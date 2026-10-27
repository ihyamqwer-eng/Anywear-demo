from __future__ import annotations

import asyncio
import os
import struct
import time
from contextlib import suppress
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from detector import DEFAULT_DETECTION_THRESHOLD
from propainter_runtime import ProPainterRuntime

INPUT_HEADER = struct.Struct("!4sIdHH")
OUTPUT_HEADER = struct.Struct("!4sIdHHBfH")
MAX_FRAME_BYTES = 8 * 1024 * 1024
FRAME_MAGIC = b"AWF1"
OUTPUT_MAGIC = b"AWP1"
OUTPUT_FPS = 20
BATCH_FRAMES = max(10, int(os.getenv("WATERMARK_BATCH_FRAMES", "60")))
MAX_QUEUE_FRAMES = max(BATCH_FRAMES, int(os.getenv("WATERMARK_MAX_QUEUE_FRAMES", "100")))

runtime = ProPainterRuntime(
    model_dir=os.getenv("WATERMARK_MODEL_DIR", "/models"),
    template_path=os.getenv("WATERMARK_TEMPLATE_PATH", "/watermark-config/watermark-template.png"),
    detection_threshold=float(os.getenv("WATERMARK_DETECTION_THRESHOLD", str(DEFAULT_DETECTION_THRESHOLD))),
    max_active_tiles=max(1, int(os.getenv("WATERMARK_MAX_ACTIVE_TILES", "3"))),
)
active_connection = False
connection_guard = asyncio.Lock()
service_metrics: dict[str, Any] = {
    "dropped_frames": 0,
    "fallback_frames": 0,
    "processed_frames": 0,
    "output_fps": 0.0,
    "latency_ms": None,
    "p95_latency_ms": None,
    "gpu_memory_mb": None,
    "detection_confidence": None,
    "batch_ms": None,
    "message": None,
}

app = FastAPI()


@app.on_event("startup")
async def start_model_loading() -> None:
    asyncio.create_task(asyncio.to_thread(runtime.load))


def get_cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def worker_status(queue_depth: int = 0) -> dict[str, Any]:
    if runtime.load_state == "ready":
        state = "ready"
    elif runtime.load_state == "template_missing":
        state = "template_missing"
    elif runtime.load_state == "error":
        state = "error"
    else:
        state = "loading"
    return {
        "type": "status",
        "state": state,
        "model": "ProPainter",
        "gpu": "RTX-compatible CUDA" if get_cuda_available() else "unavailable",
        "input_width": 1920,
        "input_height": 1080,
        "input_fps": OUTPUT_FPS,
        "output_fps": service_metrics["output_fps"],
        "latency_ms": service_metrics["latency_ms"],
        "p95_latency_ms": service_metrics["p95_latency_ms"],
        "queue_depth": queue_depth,
        "dropped_frames": service_metrics["dropped_frames"],
        "processed_frames": service_metrics["processed_frames"],
        "fallback_frames": service_metrics["fallback_frames"],
        "detection_confidence": service_metrics["detection_confidence"],
        "gpu_memory_mb": service_metrics["gpu_memory_mb"],
        "batch_ms": service_metrics["batch_ms"],
        "template_available": bool(runtime.detector and runtime.detector.ready),
        "message": runtime.error or service_metrics["message"],
    }


@app.get("/healthz")
async def health() -> JSONResponse:
    cuda_available = get_cuda_available()
    payload = worker_status()
    payload["ok"] = cuda_available
    return JSONResponse(payload, status_code=200 if cuda_available else 503)


def origin_is_same_site(websocket: WebSocket) -> bool:
    origin = websocket.headers.get("origin", "")
    expected_host = websocket.headers.get("x-forwarded-host") or websocket.headers.get("host", "")
    expected_scheme = websocket.headers.get("x-forwarded-proto", "")
    if not origin or not expected_host or expected_scheme not in ("http", "https"):
        return False
    try:
        parsed = urlsplit(origin)
        return parsed.scheme == expected_scheme and parsed.netloc.casefold() == expected_host.casefold() and not parsed.path and not parsed.query and not parsed.fragment
    except ValueError:
        return False


def parse_frame(packet: bytes) -> tuple[int, float, int, int, bytes]:
    if len(packet) <= INPUT_HEADER.size or len(packet) > MAX_FRAME_BYTES + INPUT_HEADER.size:
        raise ValueError("Frame size is outside the accepted range")
    magic, sequence, captured_ms, width, height = INPUT_HEADER.unpack_from(packet)
    if magic != FRAME_MAGIC:
        raise ValueError("Invalid frame header")
    if width < 320 or height < 180 or width > 3840 or height > 2160:
        raise ValueError("Frame dimensions are outside the accepted range")
    return sequence, captured_ms, width, height, packet[INPUT_HEADER.size:]


def enqueue_latest(queue: asyncio.Queue[tuple[int, float, int, int, bytes]], frame: tuple[int, float, int, int, bytes]) -> bool:
    dropped = False
    if queue.full():
        with suppress(asyncio.QueueEmpty):
            queue.get_nowait()
            queue.task_done()
            dropped = True
    queue.put_nowait(frame)
    return dropped


async def send_status(websocket: WebSocket, send_guard: asyncio.Lock, queue_depth: int) -> None:
    async with send_guard:
        await websocket.send_json(worker_status(queue_depth))


@app.websocket("/ws/watermark")
async def watermark_socket(websocket: WebSocket) -> None:
    global active_connection
    if not origin_is_same_site(websocket):
        await websocket.close(code=4403, reason="Same-origin connection required")
        return

    async with connection_guard:
        if active_connection:
            await websocket.close(code=4429, reason="Watermark worker already has an active stream")
            return
        active_connection = True

    await websocket.accept()
    send_guard = asyncio.Lock()
    incoming: asyncio.Queue[tuple[int, float, int, int, bytes]] = asyncio.Queue(maxsize=MAX_QUEUE_FRAMES)
    disconnected = asyncio.Event()

    async def publish_status() -> None:
        while not disconnected.is_set():
            try:
                await send_status(websocket, send_guard, incoming.qsize())
            except Exception:
                disconnected.set()
                return
            await asyncio.sleep(1)

    async def receive_frames() -> None:
        while not disconnected.is_set():
            try:
                packet = await websocket.receive_bytes()
                parsed = parse_frame(packet)
                if not runtime.ready:
                    continue
                if enqueue_latest(incoming, parsed):
                    service_metrics["dropped_frames"] += 1
            except WebSocketDisconnect:
                disconnected.set()
            except ValueError as error:
                service_metrics["message"] = str(error)
                with suppress(Exception):
                    await send_status(websocket, send_guard, incoming.qsize())
            except Exception:
                disconnected.set()

    async def process_frames() -> None:
        loop = asyncio.get_running_loop()
        while not disconnected.is_set():
            try:
                first = await asyncio.wait_for(incoming.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            batch = [first]
            while len(batch) < BATCH_FRAMES and not disconnected.is_set():
                try:
                    batch.append(incoming.get_nowait())
                except asyncio.QueueEmpty:
                    await asyncio.sleep(0.01)
            if len(batch) != BATCH_FRAMES:
                for _ in batch:
                    incoming.task_done()
                continue

            batch_started = loop.time()
            try:
                output, metrics = await asyncio.to_thread(runtime.process_batch, batch)
                service_metrics["batch_ms"] = metrics["batch_ms"]
                service_metrics["fallback_frames"] += metrics["fallback_frames"]
                service_metrics["processed_frames"] += metrics["processed_frames"]
                service_metrics["gpu_memory_mb"] = metrics["gpu_memory_mb"]
                service_metrics["detection_confidence"] = metrics["max_confidence"]
                service_metrics["message"] = None
            except Exception as error:
                output = [(sequence, captured_ms, width, height, jpeg, False, 0.0, True) for sequence, captured_ms, width, height, jpeg in batch]
                service_metrics["fallback_frames"] += len(batch)
                service_metrics["message"] = f"Batch fallback: {type(error).__name__}: {error}"

            batch_elapsed = max(loop.time() - batch_started, 0.001)
            service_metrics["output_fps"] = round(len(output) / batch_elapsed, 1)
            await send_status(websocket, send_guard, incoming.qsize())
            output_started = loop.time()
            for index, (sequence, captured_ms, width, height, jpeg, repaired, confidence, fallback) in enumerate(output):
                flags = (1 if repaired else 0) | (2 if fallback else 0)
                header = OUTPUT_HEADER.pack(
                    OUTPUT_MAGIC,
                    sequence,
                    captured_ms,
                    width,
                    height,
                    flags,
                    float(confidence),
                    min(65535, int(service_metrics["batch_ms"] or 0)),
                )
                async with send_guard:
                    await websocket.send_bytes(header + jpeg)
                deadline = output_started + (index + 1) / OUTPUT_FPS
                await asyncio.sleep(max(0.0, deadline - loop.time()))
                incoming.task_done()

    tasks = [asyncio.create_task(publish_status()), asyncio.create_task(receive_frames()), asyncio.create_task(process_frames())]
    try:
        await send_status(websocket, send_guard, incoming.qsize())
        await tasks[1]
    finally:
        disconnected.set()
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError, Exception):
                await task
        async with connection_guard:
            active_connection = False
