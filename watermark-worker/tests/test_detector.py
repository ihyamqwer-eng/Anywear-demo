import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from detector import DEFAULT_DETECTION_THRESHOLD, WatermarkDetector


def make_template() -> np.ndarray:
    image = np.full((80, 320, 3), (28, 28, 28), dtype=np.uint8)
    cv2.rectangle(image, (14, 9), (306, 70), (104, 104, 104), -1, cv2.LINE_AA)
    cv2.circle(image, (45, 40), 31, (104, 104, 104), -1, cv2.LINE_AA)
    cv2.circle(image, (275, 40), 31, (104, 104, 104), -1, cv2.LINE_AA)
    points = np.array([[45, 21], [50, 34], [64, 39], [50, 44], [45, 58], [40, 44], [26, 39], [40, 34]], np.int32)
    cv2.fillPoly(image, [points], (246, 246, 246), cv2.LINE_AA)
    cv2.putText(image, "AI Generated", (75, 51), cv2.FONT_HERSHEY_SIMPLEX, 0.95, (246, 246, 246), 2, cv2.LINE_AA)
    return image


class WatermarkDetectorTests(unittest.TestCase):
    def test_matches_template_at_1080p(self) -> None:
        template = make_template()
        with tempfile.TemporaryDirectory() as temp_dir:
            template_path = Path(temp_dir) / "template.png"
            self.assertTrue(cv2.imwrite(str(template_path), template))
            detector = WatermarkDetector(str(template_path))
            frame = np.full((1080, 1920, 3), (36, 82, 110), dtype=np.uint8)
            frame[284:364, 812:1132] = template
            detection = detector.detect(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

        self.assertIsNotNone(detection)
        assert detection is not None
        self.assertGreaterEqual(detection.confidence, DEFAULT_DETECTION_THRESHOLD)
        self.assertLessEqual(abs(detection.x - 812), 8)
        self.assertLessEqual(abs(detection.y - 284), 8)
        self.assertGreater(cv2.countNonZero(detection.mask), 0)

    def test_plain_scene_does_not_trigger_a_match(self) -> None:
        template = make_template()
        with tempfile.TemporaryDirectory() as temp_dir:
            template_path = Path(temp_dir) / "template.png"
            self.assertTrue(cv2.imwrite(str(template_path), template))
            detector = WatermarkDetector(str(template_path))
            frame = np.random.default_rng(4).integers(0, 255, (1080, 1920, 3), dtype=np.uint8)

        self.assertIsNone(detector.detect(frame))

    def test_detects_translucent_watermark_on_a_varied_background(self) -> None:
        template = make_template()
        x_coordinates = np.arange(1920, dtype=np.uint8)[None, :]
        y_coordinates = np.arange(1080, dtype=np.uint8)[:, None]
        frame = np.empty((1080, 1920, 3), dtype=np.uint8)
        frame[:, :, 0] = 44 + x_coordinates // 16
        frame[:, :, 1] = 52 + y_coordinates // 20
        frame[:, :, 2] = 68 + (x_coordinates // 24 + y_coordinates // 30) % 32
        left, top = 812, 284
        region = frame[top:top + template.shape[0], left:left + template.shape[1]]
        watermark_mask = cv2.cvtColor(template, cv2.COLOR_BGR2GRAY) > 50
        blended = cv2.addWeighted(region, 0.4, template, 0.6, 0)
        region[watermark_mask] = blended[watermark_mask]

        with tempfile.TemporaryDirectory() as temp_dir:
            template_path = Path(temp_dir) / "template.png"
            self.assertTrue(cv2.imwrite(str(template_path), template))
            detector = WatermarkDetector(str(template_path))
            detection = detector.detect(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

        self.assertIsNotNone(detection)
        assert detection is not None
        self.assertGreaterEqual(detection.confidence, DEFAULT_DETECTION_THRESHOLD)
        self.assertLessEqual(abs(detection.x - left), 8)
        self.assertLessEqual(abs(detection.y - top), 8)


if __name__ == "__main__":
    unittest.main()
