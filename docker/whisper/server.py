"""
Minimal speech-to-text HTTP service for termhub, backed by faster-whisper on CPU.

  GET  /health                     200 once the model is loaded (503 while downloading/loading)
  POST /transcribe?language=pt     Authorization: Bearer $WHISPER_SECRET
                                   body = the audio file (webm/opus, ogg, mp4/aac, wav, mp3...)
                                   -> {"text": "...", "language": "pt", "duration": 12.3}

Requests are serialized (one transcription at a time) so a long clip does not
thrash the CPU with a second one. Audio is decoded in memory and never written
to disk or logged: the log only carries sizes and timings.
"""
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from faster_whisper import WhisperModel

from auth import authorized


def physical_cores() -> int:
    """Physical cores (hyperthreads make CTranslate2 slower, not faster); falls back to cpu_count."""
    cores: set[tuple[str, str]] = set()
    phys = core = ""
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                key, _, value = line.partition(":")
                key = key.strip()
                if key == "physical id":
                    phys = value.strip()
                elif key == "core id":
                    core = value.strip()
                    cores.add((phys, core))
    except OSError:
        pass
    return len(cores) or (os.cpu_count() or 4)


MODEL = os.environ.get("WHISPER_MODEL", "medium")
THREADS = int(os.environ.get("WHISPER_THREADS", "0")) or physical_cores()
DEFAULT_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "pt")
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
# Style hint: whisper mimics the prompt's punctuation and casing. Measured on pt-BR audio, "medium"
# with this prompt beat every larger model (large-v3/turbo drop punctuation in Portuguese).
DEFAULT_PROMPTS = {
    "pt": "Olá, tudo bem? Hoje vamos revisar o código do projeto. Primeiro, abra o arquivo principal; depois, rode os testes.",
    "en": "Hi, how are you? Today we will review the project's code. First, open the main file; then, run the tests.",
}
INITIAL_PROMPT = os.environ.get("WHISPER_INITIAL_PROMPT") or DEFAULT_PROMPTS.get(DEFAULT_LANGUAGE)
PORT = int(os.environ.get("PORT", "8000"))
# The compose network is not authentication: an empty secret refuses every /transcribe.
SECRET = os.environ.get("WHISPER_SECRET", "")
MAX_BYTES = 64 * 1024 * 1024

model: WhisperModel | None = None
lock = threading.Lock()


def log(msg: str) -> None:
    print(f"[whisper] {msg}", file=sys.stderr, flush=True)


def load_model() -> None:
    global model
    t0 = time.time()
    log(f"loading model {MODEL} (int8, {THREADS} threads)")
    m = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
    model = m
    log(f"model ready in {time.time() - t0:.1f}s")


def transcribe(data: bytes, language: str | None) -> dict:
    assert model is not None
    with lock:
        t0 = time.time()
        segments, info = model.transcribe(
            io.BytesIO(data),
            language=language or None,
            beam_size=BEAM_SIZE,
            initial_prompt=INITIAL_PROMPT,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,
        )
        text = " ".join(s.text.strip() for s in segments if s.text.strip())
        elapsed = time.time() - t0
    log(f"transcribed {len(data)} bytes, audio {info.duration:.1f}s, lang {info.language}, {elapsed:.1f}s, {len(text)} chars")
    return {"text": text, "language": info.language, "duration": round(info.duration, 2)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:  # quiet: we log ourselves
        pass

    def send_json(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/health":
            if model is None:
                self.send_json(503, {"ok": False, "status": "loading"})
            else:
                self.send_json(200, {"ok": True, "model": MODEL})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if url.path != "/transcribe":
            self.send_json(404, {"error": "not found"})
            return
        if not authorized(self.headers.get("authorization"), SECRET):
            # the body was never read: drop the connection rather than parse it as the next request
            self.close_connection = True
            self.send_json(401, {"error": "unauthorized"})
            return
        if model is None:
            self.send_json(503, {"error": "model loading"})
            return
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            self.send_json(400, {"error": "empty body"})
            return
        if length > MAX_BYTES:
            self.send_json(413, {"error": "audio too large"})
            return
        data = self.rfile.read(length)
        language = (parse_qs(url.query).get("language") or [DEFAULT_LANGUAGE])[0].strip()
        if language == "auto":
            language = ""
        try:
            self.send_json(200, transcribe(data, language))
        except Exception as err:  # decode failure, unsupported codec...
            log(f"transcription failed: {type(err).__name__}: {err}")
            self.send_json(422, {"error": "could not decode audio"})


def main() -> None:
    if not SECRET:
        log("WHISPER_SECRET is empty: every /transcribe request will be refused")
    threading.Thread(target=load_model, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"listening on :{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
