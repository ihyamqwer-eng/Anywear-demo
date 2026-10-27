from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

DEFAULT_DETECTION_THRESHOLD = 0.42


@dataclass(frozen=True)
class Detection:
    x: int
    y: int
    width: int
    height: int
    confidence: float
    mask: np.ndarray

    @property
    def center(self) -> tuple[float, float]:
        return self.x + self.width / 2, self.y + self.height / 2


class WatermarkDetector:
    max_detection_width = 960

    def __init__(self, template_path: str, threshold: float = DEFAULT_DETECTION_THRESHOLD) -> None:
        self.template_path = Path(template_path)
        self.threshold = threshold
        self.template_edges: np.ndarray | None = None
        self.template_size: tuple[int, int] | None = None
        self.last_box: tuple[int, int, int, int] | None = None
        self.frame_index = 0
        self.lost_frames = 0
        self.last_confidence = 0.0
        self._load_template()

    @property
    def ready(self) -> bool:
        return self.template_edges is not None

    def _load_template(self) -> None:
        image = cv2.imread(str(self.template_path), cv2.IMREAD_COLOR)
        if image is None or image.shape[0] < 24 or image.shape[1] < 80:
            return
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 45, 125)
        if cv2.countNonZero(edges) < 40:
            return
        self.template_edges = edges
        self.template_size = (image.shape[1], image.shape[0])

    @staticmethod
    def _rounded_mask(shape: tuple[int, int], box: tuple[int, int, int, int]) -> np.ndarray:
        frame_height, frame_width = shape
        x, y, width, height = box
        margin_x = max(2, round(width * 0.018))
        margin_y = max(2, round(height * 0.07))
        left = max(0, x - margin_x)
        top = max(0, y - margin_y)
        right = min(frame_width, x + width + margin_x)
        bottom = min(frame_height, y + height + margin_y)
        mask = np.zeros((frame_height, frame_width), dtype=np.uint8)
        radius = max(1, (bottom - top) // 2)
        cv2.rectangle(mask, (left + radius, top), (right - radius - 1, bottom - 1), 255, -1)
        cv2.circle(mask, (left + radius, top + radius), radius, 255, -1)
        cv2.circle(mask, (right - radius - 1, top + radius), radius, 255, -1)
        return mask

    def _search(self, edges: np.ndarray, scales: list[float], region: tuple[int, int, int, int] | None) -> tuple[tuple[int, int, int, int], float] | None:
        if self.template_edges is None or self.template_size is None:
            return None
        frame_height, frame_width = edges.shape
        if region is None:
            left, top, right, bottom = 0, 0, frame_width, frame_height
        else:
            left, top, right, bottom = region
        search_image = edges[top:bottom, left:right]
        best: tuple[tuple[int, int, int, int], float] | None = None
        for scale in scales:
            width = max(80, round(self.template_size[0] * scale))
            height = max(24, round(self.template_size[1] * scale))
            if width >= search_image.shape[1] or height >= search_image.shape[0]:
                continue
            template = cv2.resize(self.template_edges, (width, height), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
            score_map = cv2.matchTemplate(search_image, template, cv2.TM_CCOEFF_NORMED)
            _, confidence, _, location = cv2.minMaxLoc(score_map)
            candidate = ((left + location[0], top + location[1], width, height), float(confidence))
            if best is None or candidate[1] > best[1]:
                best = candidate
        return best

    def detect(self, frame_rgb: np.ndarray) -> Detection | None:
        self.frame_index += 1
        if not self.ready or self.template_size is None:
            return None

        frame_height, frame_width = frame_rgb.shape[:2]
        detection_scale = min(1.0, self.max_detection_width / frame_width)
        if detection_scale < 1.0:
            search_frame = cv2.resize(
                frame_rgb,
                (round(frame_width * detection_scale), round(frame_height * detection_scale)),
                interpolation=cv2.INTER_AREA,
            )
        else:
            search_frame = frame_rgb
        search_height, search_width = search_frame.shape[:2]
        gray = cv2.cvtColor(search_frame, cv2.COLOR_RGB2GRAY)
        edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 45, 125)
        base_scale = frame_width / 1920 * detection_scale
        scales = [base_scale * factor for factor in (0.88, 1.0, 1.12)]
        candidate = None

        if self.last_box is not None and self.lost_frames < 10:
            x, y, width, height = self.last_box
            x = round(x * detection_scale)
            y = round(y * detection_scale)
            width = round(width * detection_scale)
            height = round(height * detection_scale)
            pad_x = max(round(260 * detection_scale), width)
            pad_y = max(round(150 * detection_scale), height * 2)
            local_region = (
                max(0, x + width // 2 - pad_x),
                max(0, y + height // 2 - pad_y),
                min(search_width, x + width // 2 + pad_x),
                min(search_height, y + height // 2 + pad_y),
            )
            candidate = self._search(edges, scales, local_region)

        global_scan = candidate is None or candidate[1] < self.threshold or self.frame_index % 20 == 0
        if global_scan:
            global_candidate = self._search(edges, scales, None)
            if global_candidate is not None and (candidate is None or global_candidate[1] > candidate[1]):
                candidate = global_candidate

        if candidate is None or candidate[1] < self.threshold:
            self.lost_frames += 1
            self.last_confidence = candidate[1] if candidate else 0.0
            if self.lost_frames >= 10:
                self.last_box = None
            return None

        small_box, confidence = candidate
        left, top, right, bottom = (
            round(small_box[0] / detection_scale),
            round(small_box[1] / detection_scale),
            round((small_box[0] + small_box[2]) / detection_scale),
            round((small_box[1] + small_box[3]) / detection_scale),
        )
        left = min(max(0, left), frame_width - 1)
        top = min(max(0, top), frame_height - 1)
        box = (left, top, min(frame_width, right) - left, min(frame_height, bottom) - top)
        self.last_box = box
        self.lost_frames = 0
        self.last_confidence = confidence
        mask = self._rounded_mask((frame_height, frame_width), box)
        return Detection(*box, confidence, mask)
