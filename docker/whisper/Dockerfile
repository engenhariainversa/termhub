# Speech-to-text service for termhub: faster-whisper (CTranslate2, int8) on CPU.
# Tiny HTTP API, see server.py. Model weights are downloaded on first start into
# the "whisper-models" volume (HF cache), so the image itself stays small.
FROM python:3.12-slim
WORKDIR /srv
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 HF_HOME=/models
# av is pinned too: faster-whisper 1.2.1 calls av.open(metadata_errors=...), which av 19 removed,
# so an unpinned rebuild fails every transcription with "unexpected keyword argument".
RUN pip install --no-cache-dir faster-whisper==1.2.1 av==18.1.0
COPY auth.py server.py ./
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"
CMD ["python", "server.py"]
