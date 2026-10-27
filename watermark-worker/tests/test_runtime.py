import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

from propainter_runtime import ProPainterRuntime
from process_video import ProgressReporter


class ProPainterRuntimeTests(unittest.TestCase):
    def test_process_batch_preserves_full_frame_dimensions(self) -> None:
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        ok, encoded = cv2.imencode(".jpg", frame)
        self.assertTrue(ok)

        runtime = ProPainterRuntime("/unused", "/unused", 0.5, 1)
        runtime.device = "cpu"
        runtime.detector = SimpleNamespace(detect=lambda _frame: None)
        packet = (7, 1234.5, 1920, 1080, encoded.tobytes())

        with patch("torch.cuda.max_memory_allocated", return_value=0), patch("torch.cuda.reset_peak_memory_stats"):
            output, _ = runtime.process_batch([packet])

        sequence, captured_ms, width, height, jpeg, repaired, confidence, fallback = output[0]
        self.assertEqual((sequence, captured_ms, width, height), (7, 1234.5, 1920, 1080))
        self.assertFalse(repaired)
        self.assertEqual(confidence, 0.0)
        self.assertFalse(fallback)
        restored = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(restored.shape, (1080, 1920, 3))

    def test_progress_reporter_serializes_concurrent_updates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "progress.json"
            reporter = ProgressReporter(path, {"status": "processing", "processedFrames": 0, "totalFrames": 8})
            reporter.start()
            writers = [threading.Thread(target=reporter.update, kwargs={"processedFrames": index}) for index in range(1, 9)]
            for writer in writers:
                writer.start()
            for writer in writers:
                writer.join()
            reporter.stop()

            progress = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(progress["status"], "processing")
            self.assertIn(progress["processedFrames"], range(1, 9))


if __name__ == "__main__":
    unittest.main()
