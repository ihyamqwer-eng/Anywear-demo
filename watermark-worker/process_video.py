from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from datetime import datetime
from fractions import Fraction
from pathlib import Path
from typing import Any

import av
import cv2
import numpy as np

from detector import DEFAULT_DETECTION_THRESHOLD
from propainter_runtime import ProPainterRuntime


def local_timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


class ProgressReporter:
    def __init__(self, path: Path, state: dict[str, Any]) -> None:
        self.path = path
        self.state = state
        self.lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.stopped = threading.Event()
        self.started = time.monotonic()
        self.thread = threading.Thread(target=self._run, name="video-progress", daemon=True)

    def start(self) -> None:
        self.thread.start()
        self._write()

    def update(self, **values: Any) -> None:
        with self.lock:
            self.state.update(values)
        self._write()

    def stop(self) -> None:
        self.stopped.set()
        if self.thread.ident is not None:
            self.thread.join(timeout=2)
        try:
            self._write()
        except OSError as error:
            print(f"Progress file update failed: {error}", file=sys.stderr, flush=True)

    def _snapshot(self) -> dict[str, Any]:
        with self.lock:
            payload = dict(self.state)
        elapsed = max(0.0, time.monotonic() - self.started)
        completed = int(payload.get("processedFrames", 0))
        total = int(payload.get("totalFrames", 0))
        rate = completed / elapsed if elapsed > 0 and completed else 0.0
        payload["updatedAt"] = local_timestamp()
        payload["elapsedSeconds"] = round(elapsed, 1)
        payload["processingFps"] = round(rate, 2)
        payload["percent"] = round(min(100.0, completed * 100 / total), 1) if total else None
        payload["estimatedRemainingSeconds"] = round((total - completed) / rate, 1) if total and rate else None
        return payload

    def _write(self) -> dict[str, Any]:
        with self.write_lock:
            payload = self._snapshot()
            try:
                write_json_atomic(self.path, payload)
            except OSError:
                self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            return payload

    def _run(self) -> None:
        last_log = 0.0
        while not self.stopped.wait(1):
            payload = self._write()
            now = time.monotonic()
            if now - last_log >= 5:
                print(json.dumps({
                    "status": payload.get("status"),
                    "batch": f"{payload.get('currentBatch', 0)}/{payload.get('totalBatches', 0)}",
                    "processedFrames": payload.get("processedFrames", 0),
                    "totalFrames": payload.get("totalFrames", 0),
                    "percent": payload.get("percent"),
                    "elapsedSeconds": payload.get("elapsedSeconds"),
                    "estimatedRemainingSeconds": payload.get("estimatedRemainingSeconds"),
                }, ensure_ascii=False), flush=True)
                last_log = now


def encode_jpeg(frame: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        raise RuntimeError("Unable to encode input frame for the repair pipeline")
    return encoded.tobytes()


def decode_jpeg(data: bytes, expected_size: tuple[int, int]) -> np.ndarray:
    frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None or (frame.shape[1], frame.shape[0]) != expected_size:
        raise RuntimeError("Worker returned an invalid or resized frame")
    return frame


def process_video(args: argparse.Namespace) -> int:
    source = Path(args.input).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Input video does not exist: {source}")

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    output = Path(args.output).expanduser().resolve() if args.output else output_dir / f"anywear-watermark-repaired-{stamp}.mp4"
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite existing output: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(f"{output.stem}.partial{output.suffix}")
    progress_path = output.with_suffix(".progress.json")
    if partial.exists():
        raise FileExistsError(f"Partial output already exists: {partial}")

    source_container = av.open(str(source), mode="r")
    video_stream = next((stream for stream in source_container.streams if stream.type == "video"), None)
    if video_stream is None:
        source_container.close()
        raise ValueError("Input contains no video stream")
    width = int(video_stream.codec_context.width)
    height = int(video_stream.codec_context.height)
    if width < 320 or height < 180 or width > 3840 or height > 2160:
        source_container.close()
        raise ValueError(f"Unsupported video dimensions: {width}x{height}")
    rate = video_stream.average_rate or video_stream.base_rate or Fraction(30, 1)
    fps = float(rate)
    if fps <= 0 or fps > 120:
        source_container.close()
        raise ValueError(f"Unsupported source frame rate: {fps}")
    total_frames = int(video_stream.frames or 0)
    if not total_frames and source_container.duration and source_container.duration > 0:
        total_frames = round(float(source_container.duration / av.time_base) * fps)
    batch_size = args.batch_frames
    total_batches = (total_frames + batch_size - 1) // batch_size if total_frames else 0

    state: dict[str, Any] = {
        "status": "starting",
        "input": str(source),
        "output": str(output),
        "startedAt": local_timestamp(),
        "updatedAt": local_timestamp(),
        "completedAt": None,
        "width": width,
        "height": height,
        "sourceFps": fps,
        "batchFrames": batch_size,
        "currentBatch": 0,
        "totalBatches": total_batches,
        "processedFrames": 0,
        "totalFrames": total_frames,
        "detectedFrames": 0,
        "repairedFrames": 0,
        "fallbackFrames": 0,
        "gpuPeakMemoryMiB": None,
        "lastBatchMs": None,
        "message": None,
    }
    reporter = ProgressReporter(progress_path, state)
    output_container = None

    try:
        reporter.start()
        reporter.update(status="loading_models")
        runtime = ProPainterRuntime(
            model_dir=os.getenv("WATERMARK_MODEL_DIR", "/models"),
            template_path=os.getenv("WATERMARK_TEMPLATE_PATH", "/watermark-config/watermark-template.png"),
            detection_threshold=float(os.getenv("WATERMARK_DETECTION_THRESHOLD", str(DEFAULT_DETECTION_THRESHOLD))),
            max_active_tiles=max(1, int(os.getenv("WATERMARK_MAX_ACTIVE_TILES", "3"))),
        )
        runtime.load()
        if not runtime.ready:
            raise RuntimeError(runtime.error or f"Model initialization failed: {runtime.load_state}")

        output_container = av.open(str(partial), mode="w", format="mp4")
        output_stream = output_container.add_stream("libx264", rate=rate)
        output_stream.width = width
        output_stream.height = height
        output_stream.pix_fmt = "yuv420p"
        output_stream.options = {"crf": "18", "preset": "medium"}
        output_time_base = Fraction(rate.denominator, rate.numerator)

        reporter.update(status="processing")
        batch: list[tuple[int, float, int, int, bytes]] = []
        sequence = 0
        detected_total = 0
        repaired_total = 0
        fallback_total = 0
        peak_memory_mib = 0.0

        def flush_batch(current_batch: int) -> None:
            nonlocal detected_total, repaired_total, fallback_total, peak_memory_mib
            if not batch:
                return
            reporter.update(status="processing", currentBatch=current_batch, message="Running temporal repair")
            output_frames, metrics = runtime.process_batch(batch)
            for result in output_frames:
                frame_sequence, _, frame_width, frame_height, jpeg, repaired, _, fallback = result
                restored = decode_jpeg(jpeg, (frame_width, frame_height))
                output_frame = av.VideoFrame.from_ndarray(restored, format="bgr24")
                output_frame.pts = frame_sequence
                output_frame.time_base = output_time_base
                for packet in output_stream.encode(output_frame):
                    output_container.mux(packet)
                if repaired:
                    repaired_total += 1
                if fallback:
                    fallback_total += 1
            detected_total += int(metrics["detected_frames"])
            if metrics["gpu_memory_mb"] is not None:
                peak_memory_mib = max(peak_memory_mib, float(metrics["gpu_memory_mb"]))
            batch_count = len(batch)
            completed = int(state["processedFrames"]) + batch_count
            reporter.update(
                processedFrames=completed,
                detectedFrames=detected_total,
                repairedFrames=repaired_total,
                fallbackFrames=fallback_total,
                gpuPeakMemoryMiB=round(peak_memory_mib, 1),
                lastBatchMs=metrics["batch_ms"],
                message=None if not metrics["fallback_frames"] else "Some detected frames used original-frame fallback",
            )
            print(json.dumps({
                "status": "batch_complete",
                "batch": f"{current_batch}/{total_batches or '?'}",
                "processedFrames": completed,
                "repairedFrames": repaired_total,
                "fallbackFrames": fallback_total,
                "batchMs": metrics["batch_ms"],
                "gpuPeakMemoryMiB": metrics["gpu_memory_mb"],
            }, ensure_ascii=False), flush=True)
            batch.clear()

        for frame in source_container.decode(video=video_stream.index):
            bgr = frame.to_ndarray(format="bgr24")
            captured_ms = sequence * 1000.0 / fps
            batch.append((sequence, captured_ms, width, height, encode_jpeg(bgr)))
            sequence += 1
            if len(batch) >= batch_size:
                flush_batch((sequence + batch_size - 1) // batch_size)
        if batch:
            flush_batch((sequence + batch_size - 1) // batch_size)

        for packet in output_stream.encode():
            output_container.mux(packet)
        output_container.close()
        output_container = None
        source_container.close()
        os.replace(partial, output)
        reporter.update(
            status="completed_with_fallbacks" if fallback_total else "completed",
            processedFrames=sequence,
            detectedFrames=detected_total,
            repairedFrames=repaired_total,
            fallbackFrames=fallback_total,
            completedAt=local_timestamp(),
            message="Fallback frames remain unchanged; inspect the report before using the output" if fallback_total else None,
        )
        print(json.dumps({
            "status": "complete",
            "output": str(output),
            "progress": str(progress_path),
            "processedFrames": sequence,
            "detectedFrames": detected_total,
            "repairedFrames": repaired_total,
            "fallbackFrames": fallback_total,
            "completedAt": local_timestamp(),
        }, ensure_ascii=False), flush=True)
        return 0
    except BaseException as error:
        if output_container is not None:
            output_container.close()
        source_container.close()
        status = "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        try:
            reporter.update(status=status, completedAt=local_timestamp(), message=f"{type(error).__name__}: {error}")
        except OSError as progress_error:
            print(f"Could not update progress file: {progress_error}", file=sys.stderr, flush=True)
        raise
    finally:
        reporter.stop()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Repair a local video with the Anywear ProPainter worker")
    parser.add_argument("--input", required=True, help="Path to the source video")
    parser.add_argument("--output-dir", default="/video-work", help="Directory for timestamped output and progress JSON")
    parser.add_argument("--output", help="Optional explicit output MP4 path")
    parser.add_argument("--batch-frames", type=int, default=60, help="Temporal context per inference batch (minimum 3)")
    args = parser.parse_args()
    if args.batch_frames < 3 or args.batch_frames > 120:
        parser.error("--batch-frames must be between 3 and 120")
    return args


if __name__ == "__main__":
    try:
        raise SystemExit(process_video(parse_args()))
    except Exception as error:
        print(f"Video processing failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
