from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from statistics import median
from typing import Any

import cv2
import numpy as np

PROPAINTER_COMMIT = "e870e79321c31b733e2031af5aa2fb1fe3ac7eec"
PRETRAIN_MODEL_URL = "https://github.com/sczhou/ProPainter/releases/download/v0.1.0/"


class ProPainterRuntime:
    def __init__(self, model_dir: str, template_path: str, detection_threshold: float, max_active_tiles: int) -> None:
        self.model_dir = Path(model_dir)
        self.template_path = template_path
        self.detection_threshold = detection_threshold
        self.max_active_tiles = max_active_tiles
        self.device: Any = None
        self.detector: Any = None
        self.raft: Any = None
        self.flow_completion: Any = None
        self.inpainter: Any = None
        self.error: str | None = None
        self.load_state = "gpu_check"
        self.lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.load_state == "ready" and self.detector is not None and self.detector.ready

    def load(self) -> None:
        self.load_state = "loading_models"
        try:
            import torch
            from detector import WatermarkDetector

            if not torch.cuda.is_available():
                raise RuntimeError("CUDA is unavailable in the watermark worker; CPU fallback is disabled")
            self.device = torch.device("cuda:0")
            torch.backends.cudnn.benchmark = True
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.set_num_threads(2)
            self.model_dir.mkdir(parents=True, exist_ok=True)
            self.detector = WatermarkDetector(self.template_path, self.detection_threshold)
            if not self.detector.ready:
                self.load_state = "template_missing"
                self.error = f"Watermark reference image is missing or invalid: {self.template_path}"
                return

            repository = Path("/opt/propainter")
            sys.path.insert(0, str(repository))
            from model.modules.flow_comp_raft import RAFT_bi
            from model.propainter import InpaintGenerator
            from model.recurrent_flow_completion import RecurrentFlowCompleteNet
            from utils.download_util import load_file_from_url

            def checkpoint(name: str) -> str:
                return load_file_from_url(
                    url=f"{PRETRAIN_MODEL_URL}{name}",
                    model_dir=str(self.model_dir),
                    progress=False,
                    file_name=name,
                )

            raft_path = checkpoint("raft-things.pth")
            flow_path = checkpoint("recurrent_flow_completion.pth")
            inpaint_path = checkpoint("ProPainter.pth")
            self.raft = RAFT_bi(raft_path, self.device)
            self.flow_completion = RecurrentFlowCompleteNet(flow_path).to(self.device).eval()
            self.inpainter = InpaintGenerator(model_path=inpaint_path).to(self.device).eval()
            self.load_state = "ready"
            self.error = None
        except Exception as error:
            self.load_state = "error"
            self.error = f"{type(error).__name__}: {error}"

    def _tile_groups(self, detections: list[Any]) -> list[dict[str, Any]]:
        groups: list[dict[str, Any]] = []
        for index, detection in enumerate(detections):
            if detection is None:
                continue
            center_x, center_y = detection.center
            matching = None
            for group in groups:
                distance_x = abs(center_x - group["center_x"])
                distance_y = abs(center_y - group["center_y"])
                if distance_x <= 250 and distance_y <= 150:
                    matching = group
                    break
            if matching is None:
                groups.append({"center_x": center_x, "center_y": center_y, "indices": [index]})
            else:
                matching["indices"].append(index)
                matching["center_x"] = median([detections[item].center[0] for item in matching["indices"]])
                matching["center_y"] = median([detections[item].center[1] for item in matching["indices"]])
        groups.sort(key=lambda group: len(group["indices"]), reverse=True)
        return groups

    @staticmethod
    def _blend_region(original: np.ndarray, restored: np.ndarray, mask: np.ndarray) -> np.ndarray:
        alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), 1.6)
        alpha = np.clip(alpha, 0.0, 1.0)[:, :, None]
        return np.clip(original.astype(np.float32) * (1 - alpha) + restored.astype(np.float32) * alpha, 0, 255).astype(np.uint8)

    def _inpaint_clip(self, frames: list[np.ndarray], masks: list[np.ndarray]) -> list[np.ndarray]:
        import torch

        frame_count = len(frames)
        height, width = frames[0].shape[:2]
        if frame_count < 3 or any(frame.shape[:2] != (height, width) for frame in frames):
            raise ValueError("ProPainter clip requires at least three same-sized frames")
        if width % 8 or height % 8:
            raise ValueError("ProPainter tile dimensions must be multiples of eight")

        frame_tensor = torch.from_numpy(np.stack(frames)).to(self.device).permute(0, 3, 1, 2).float().div_(255.0)
        frame_tensor = frame_tensor.unsqueeze(0).mul_(2.0).sub_(1.0)
        mask_stack = np.stack(masks)
        mask_dilated = [cv2.dilate(mask, np.ones((9, 9), np.uint8), iterations=1) for mask in mask_stack]
        flow_dilated = [cv2.dilate(mask, np.ones((17, 17), np.uint8), iterations=1) for mask in mask_stack]
        masks_tensor = torch.from_numpy(np.stack(mask_dilated)).to(self.device).float().div_(255.0).unsqueeze(0).unsqueeze(2)
        flow_masks = torch.from_numpy(np.stack(flow_dilated)).to(self.device).float().div_(255.0).unsqueeze(0).unsqueeze(2)

        with torch.inference_mode():
            flow_forward: list[torch.Tensor] = []
            flow_backward: list[torch.Tensor] = []
            clip_length = 12
            for start in range(0, frame_count, clip_length):
                end = min(frame_count, start + clip_length)
                if start == 0:
                    forward, backward = self.raft(frame_tensor[:, start:end], iters=20)
                else:
                    forward, backward = self.raft(frame_tensor[:, start - 1:end], iters=20)
                flow_forward.append(forward)
                flow_backward.append(backward)
            flow_forward_tensor = torch.cat(flow_forward, dim=1)
            flow_backward_tensor = torch.cat(flow_backward, dim=1)
            forward_completed = []
            backward_completed = []
            self.flow_completion.half()
            self.inpainter.half()
            frame_tensor = frame_tensor.half()
            masks_tensor = masks_tensor.half()
            flow_masks = flow_masks.half()
            flow_forward_tensor = flow_forward_tensor.half()
            flow_backward_tensor = flow_backward_tensor.half()
            completed_bi, _ = self.flow_completion.forward_bidirect_flow(
                (flow_forward_tensor, flow_backward_tensor), flow_masks
            )
            completed_bi = self.flow_completion.combine_flow(
                (flow_forward_tensor, flow_backward_tensor), completed_bi, flow_masks
            )
            masked_frames = frame_tensor * (1 - masks_tensor)
            propagated, updated_local_masks = self.inpainter.img_propagation(
                masked_frames, completed_bi, masks_tensor, "nearest"
            )
            batch, time, _, _, _ = masks_tensor.shape
            updated_frames = frame_tensor * (1 - masks_tensor) + propagated.view(batch, time, 3, height, width) * masks_tensor
            updated_masks = updated_local_masks.view(batch, time, 1, height, width)

            composite = [np.array(frame, copy=True) for frame in frames]
            composite_sum = [np.zeros_like(frame, dtype=np.float32) for frame in frames]
            composite_count = [0] * frame_count
            neighbor_stride = 5
            for start in range(0, frame_count, neighbor_stride):
                neighbor_ids = list(range(max(0, start - neighbor_stride), min(frame_count, start + neighbor_stride + 1)))
                ref_ids = [idx for idx in range(0, frame_count, 10) if idx not in neighbor_ids]
                selected_ids = neighbor_ids + ref_ids
                selected_frames = updated_frames[:, selected_ids]
                selected_masks = masks_tensor[:, selected_ids]
                selected_updated_masks = updated_masks[:, selected_ids]
                selected_flows = (
                    completed_bi[0][:, neighbor_ids[:-1]],
                    completed_bi[1][:, neighbor_ids[:-1]],
                )
                prediction = self.inpainter(
                    selected_frames,
                    selected_flows,
                    selected_masks,
                    selected_updated_masks,
                    len(neighbor_ids),
                ).view(-1, 3, height, width)
                prediction = (prediction.float().add(1).div(2).clamp(0, 1).cpu().permute(0, 2, 3, 1).numpy() * 255)
                original_masks = masks_tensor[0, neighbor_ids].float().cpu().permute(0, 2, 3, 1).numpy()
                for local_index, frame_index in enumerate(neighbor_ids):
                    predicted = prediction[local_index].astype(np.uint8)
                    alpha = np.clip(original_masks[local_index], 0, 1)
                    fused = predicted * alpha + frames[frame_index].astype(np.float32) * (1 - alpha)
                    composite_sum[frame_index] += fused
                    composite_count[frame_index] += 1

            for index, count in enumerate(composite_count):
                if count:
                    composite[index] = np.clip(composite_sum[index] / count, 0, 255).astype(np.uint8)
            return composite

    def process_batch(self, packets: list[tuple[int, float, int, int, bytes]]) -> tuple[list[tuple[int, float, int, int, bytes, bool, float, bool]], dict[str, Any]]:
        import torch

        with self.lock:
            started = __import__("time").perf_counter()
            decoded: list[np.ndarray] = []
            headers: list[tuple[int, float, int, int]] = []
            for sequence, captured_ms, width, height, jpeg in packets:
                image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
                if image is None:
                    raise ValueError("Invalid JPEG frame")
                if image.shape[1] != width or image.shape[0] != height:
                    raise ValueError("Frame header dimensions do not match its JPEG payload")
                decoded.append(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
                headers.append((sequence, captured_ms, width, height))

            detections = [self.detector.detect(frame) for frame in decoded]
            groups = self._tile_groups(detections)
            selected_groups = groups[:self.max_active_tiles]
            restored = [np.array(frame, copy=True) for frame in decoded]
            processed_indices: set[int] = set()
            fallback_indices: set[int] = set()
            processed_tiles = 0
            frame_height, frame_width = decoded[0].shape[:2]
            tile_width = min(512, frame_width - frame_width % 8)
            tile_height = min(384, frame_height - frame_height % 8)

            for group in selected_groups:
                left = min(max(0, round((group["center_x"] - tile_width / 2) / 8) * 8), frame_width - tile_width)
                top = min(max(0, round((group["center_y"] - tile_height / 2) / 8) * 8), frame_height - tile_height)
                tile_frames = [frame[top:top + tile_height, left:left + tile_width].copy() for frame in decoded]
                tile_masks = [np.zeros((tile_height, tile_width), dtype=np.uint8) for _ in decoded]
                frame_indices = set(group["indices"])
                for index in frame_indices:
                    detection = detections[index]
                    if detection is None:
                        continue
                    tile_masks[index] = detection.mask[top:top + tile_height, left:left + tile_width]
                try:
                    restored_tiles = self._inpaint_clip(tile_frames, tile_masks)
                    for index in frame_indices:
                        local_mask = tile_masks[index]
                        if cv2.countNonZero(local_mask) == 0:
                            continue
                        original = decoded[index][top:top + tile_height, left:left + tile_width]
                        restored[index][top:top + tile_height, left:left + tile_width] = self._blend_region(
                            original, restored_tiles[index], local_mask
                        )
                        processed_indices.add(index)
                    processed_tiles += 1
                except Exception:
                    for index in frame_indices:
                        fallback_indices.add(index)

            for index, detection in enumerate(detections):
                if detection is None:
                    continue
                if index not in processed_indices:
                    fallback_indices.add(index)
            encoded: list[tuple[int, float, int, int, bytes, bool, float, bool]] = []
            for index, frame in enumerate(restored):
                ok, encoded_frame = cv2.imencode(".jpg", cv2.cvtColor(frame, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 94])
                if not ok:
                    raise RuntimeError("Unable to encode repaired frame")
                sequence, captured_ms, original_width, original_height = headers[index]
                detection = detections[index]
                is_processed = index in processed_indices
                confidence = detection.confidence if detection is not None else 0.0
                encoded.append((sequence, captured_ms, original_width, original_height, encoded_frame.tobytes(), is_processed, confidence, index in fallback_indices))

            elapsed_ms = (__import__("time").perf_counter() - started) * 1000
            memory_mb = round(torch.cuda.max_memory_allocated(self.device) / (1024 * 1024), 1)
            torch.cuda.reset_peak_memory_stats(self.device)
            metrics = {
                "batch_ms": round(elapsed_ms, 1),
                "processed_frames": len(processed_indices),
                "fallback_frames": len(fallback_indices),
                "detected_frames": sum(detection is not None for detection in detections),
                "max_confidence": round(max((d.confidence for d in detections if d is not None), default=0.0), 3),
                "gpu_memory_mb": memory_mb,
                "tiles": processed_tiles,
                "unprocessed_tiles": max(0, len(groups) - processed_tiles),
                "input_width": frame_width,
                "input_height": frame_height,
            }
            return encoded, metrics
