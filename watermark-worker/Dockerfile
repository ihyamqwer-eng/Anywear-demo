FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

WORKDIR /app

ARG PROPAINTER_COMMIT=e870e79321c31b733e2031af5aa2fb1fe3ac7eec
RUN python -c "import urllib.request; urllib.request.urlretrieve('https://codeload.github.com/sczhou/ProPainter/tar.gz/${PROPAINTER_COMMIT}', '/tmp/propainter.tar.gz')" \
    && mkdir -p /opt/propainter \
    && tar -xzf /tmp/propainter.tar.gz -C /opt/propainter --strip-components=1 \
    && mkdir -p /licenses/propainter \
    && cp /opt/propainter/LICENSE /licenses/propainter/LICENSE

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py detector.py propainter_runtime.py process_video.py ./
COPY tests ./tests
RUN python -m unittest discover -s tests

EXPOSE 8765
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765"]
