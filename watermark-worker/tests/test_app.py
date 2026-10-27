import asyncio
import struct
import unittest

from app import FRAME_MAGIC, INPUT_HEADER, enqueue_latest, parse_frame


class WatermarkSocketTests(unittest.TestCase):
    def test_1080p_frame_header_preserves_source_dimensions(self) -> None:
        payload = b"jpeg"
        packet = INPUT_HEADER.pack(FRAME_MAGIC, 7, 1234.5, 1920, 1080) + payload

        sequence, captured_ms, width, height, image = parse_frame(packet)

        self.assertEqual((sequence, captured_ms, width, height, image), (7, 1234.5, 1920, 1080, payload))

    def test_full_queue_drops_oldest_and_still_enqueues_new_frame(self) -> None:
        queue: asyncio.Queue[tuple[int, float, int, int, bytes]] = asyncio.Queue(maxsize=2)
        first = (1, 1.0, 1920, 1080, b"one")
        second = (2, 2.0, 1920, 1080, b"two")
        newest = (3, 3.0, 1920, 1080, b"three")
        queue.put_nowait(first)
        queue.put_nowait(second)

        dropped = enqueue_latest(queue, newest)

        self.assertTrue(dropped)
        self.assertEqual(queue.get_nowait(), second)
        self.assertEqual(queue.get_nowait(), newest)
        queue.task_done()
        queue.task_done()

    def test_available_capacity_always_accepts_frame(self) -> None:
        queue: asyncio.Queue[tuple[int, float, int, int, bytes]] = asyncio.Queue(maxsize=2)
        frame = (1, 1.0, 1920, 1080, b"jpeg")

        self.assertFalse(enqueue_latest(queue, frame))
        self.assertEqual(queue.get_nowait(), frame)
        queue.task_done()


if __name__ == "__main__":
    unittest.main()
