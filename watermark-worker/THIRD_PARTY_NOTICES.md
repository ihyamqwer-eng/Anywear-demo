# Third-party notices

## ProPainter

This project fetches ProPainter from `sczhou/ProPainter` at commit `e870e79321c31b733e2031af5aa2fb1fe3ac7eec` when building the local worker image. The upstream code and pretrained models are distributed under the NTU S-Lab License 1.0 for non-commercial use only. The full upstream license is copied into the image at `/licenses/propainter/LICENSE` and is available at <https://github.com/sczhou/ProPainter/blob/e870e79321c31b733e2031af5aa2fb1fe3ac7eec/LICENSE>.

Pretrained checkpoints are downloaded by ProPainter from its v0.1.0 release into the persistent Docker volume `watermark-models`; they are not included in this repository or the Windows installer. Review the upstream license before redistributing the worker image, checkpoints, or output workflow. This implementation is for authorized, non-commercial research and keeps video frames in memory only.
