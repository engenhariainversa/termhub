"""
Minimal speech-to-text HTTP service for termhub, backed by faster-whisper on CPU.

  GET  /health                     200 once the model is loaded (503 while downloading/loading)
  POST /transcribe?language=auto&hints=en,pt
                                   Authorization: Bearer $WHISPER_SECRET
                                   body = the audio file (webm/opus, ogg, mp4/aac, wav, mp3...)
                                   -> {"text": "...", "language": "en", "language_probability": 0.97,
                                       "duration": 12.3, "no_speech": false}
                                   language: "auto" (default) detects; a code forces it.
                                   hints: likely languages, best first (the client's, the account's),
                                   used when the detection is unsure (lang.py).

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
from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps

from auth import authorized
from lang import best_attempt, parse_hints, pick_language, retry_order


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
# "auto" (default) detects the spoken language; a code (pt, en...) forces it for every clip (TER-1096).
DEFAULT_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "auto")
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
# Below this detection probability the caller's hints decide among the likely languages (lang.py).
DETECT_THRESHOLD = float(os.environ.get("WHISPER_DETECT_THRESHOLD", "0.6"))
# Style hint: whisper mimics the prompt's punctuation and casing. Measured on pt-BR audio, "medium"
# with this prompt beat every larger model (large-v3/turbo drop punctuation in Portuguese).
# A prompt in one language pulls the text towards it, so each language gets its own.
DEFAULT_PROMPTS = {
    "pt": "Olá, tudo bem? Hoje vamos revisar o código do projeto. Primeiro, abra o arquivo principal; depois, rode os testes.",
    "en": "Hi, how are you? Today we will review the project's code. First, open the main file; then, run the tests.",
    "es": "Hola, ¿qué tal? Hoy vamos a revisar el código del proyecto. Primero, abre el archivo principal; después, ejecuta las pruebas.",
}
# A custom prompt is written in the configured language: it replaces the built-in one for that language
# only (for every language when WHISPER_LANGUAGE is "auto", the operator's choice).
CUSTOM_PROMPT = os.environ.get("WHISPER_INITIAL_PROMPT")
PORT = int(os.environ.get("PORT", "8000"))
# The compose network is not authentication: an empty secret refuses every /transcribe.
SECRET = os.environ.get("WHISPER_SECRET", "")
MAX_BYTES = 64 * 1024 * 1024
SAMPLE_RATE = 16000  # decode_audio's default, what whisper runs on
VAD = VadOptions(min_silence_duration_ms=500)

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


def prompt_for(language: str) -> str | None:
    if CUSTOM_PROMPT and DEFAULT_LANGUAGE in ("auto", "", language):
        return CUSTOM_PROMPT
    return DEFAULT_PROMPTS.get(language)


def run(audio, language: str) -> dict:
    """One pass in a known language; never `task=translate`: the text stays in the language spoken."""
    assert model is not None
    segments, _info = model.transcribe(
        audio,
        language=language,
        task="transcribe",
        beam_size=BEAM_SIZE,
        initial_prompt=prompt_for(language),
        vad_filter=True,
        vad_parameters=VAD,
        condition_on_previous_text=False,
    )
    spoken = [s for s in segments if s.text.strip()]
    text = " ".join(s.text.strip() for s in spoken)
    logprob = sum(s.avg_logprob for s in spoken) / len(spoken) if spoken else float("-inf")
    return {"text": text, "language": language, "avg_logprob": logprob}


def transcribe(data: bytes, language: str, hints: list[str]) -> dict:
    """Forced language: one pass. Otherwise detect, pick (lang.py), and retry the other candidates
    when an unsure pick comes out empty. Silence answers `no_speech` without running the model."""
    assert model is not None
    with lock:
        t0 = time.time()
        audio = decode_audio(io.BytesIO(data))
        duration = round(len(audio) / SAMPLE_RATE, 2)
        probability = None
        if not get_speech_timestamps(audio, VAD):
            elapsed = time.time() - t0
            log(f"transcribed {len(data)} bytes, audio {duration:.1f}s, no speech, {elapsed:.1f}s")
            return {"text": "", "language": None, "language_probability": None, "duration": duration, "no_speech": True}
        if language:
            result = run(audio, language)
            tries = 1
        else:
            try:
                detected, detected_p, all_probs = model.detect_language(audio, vad_filter=True, vad_parameters=VAD)
            except Exception as err:  # never lose the clip to the detector: the candidates decide alone
                log(f"language detection failed: {type(err).__name__}")
                detected, detected_p, all_probs = (hints or ["pt"])[0], 0.0, []
            chosen = pick_language(detected, detected_p, all_probs, hints, DETECT_THRESHOLD)
            probability = dict(all_probs).get(chosen, detected_p)
            result = run(audio, chosen)
            tries = 1
            if not result["text"] and detected_p < DETECT_THRESHOLD:
                attempts = [result]
                for code in retry_order(chosen, hints):
                    attempts.append(run(audio, code))
                    tries += 1
                result = best_attempt(attempts)
                probability = dict(all_probs).get(result["language"], probability)
        elapsed = time.time() - t0
    text = result["text"]
    log(f"transcribed {len(data)} bytes, audio {duration:.1f}s, lang {result['language']}, {tries} pass(es), {elapsed:.1f}s, {len(text)} chars")
    return {
        "text": text,
        "language": result["language"],
        "language_probability": None if probability is None else round(probability, 3),
        "duration": duration,
        "no_speech": False,
    }


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
        query = parse_qs(url.query)
        language = (query.get("language") or [DEFAULT_LANGUAGE])[0].strip().lower()
        if language == "auto":
            language = ""
        hints = parse_hints((query.get("hints") or [""])[0])
        try:
            self.send_json(200, transcribe(data, language, hints))
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
