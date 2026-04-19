#!/usr/bin/env python3
"""
Local Piper TTS helper for step_browser_poc_v0.94

Endpoints:
- GET  /health
- GET  /voices
- POST /tts

This helper is designed for narrated export in the step browser app.
It keeps narration generation local on the user's machine.
"""
from __future__ import annotations

import io
import json
import os
import sys
import wave
import traceback
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from typing import Dict, List, Optional

HOST = os.environ.get("STEP_BROWSER_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("STEP_BROWSER_TTS_PORT", "8765"))
SCRIPT_DIR = Path(__file__).resolve().parent
VOICE_DIR = Path(os.environ.get("STEP_BROWSER_PIPER_VOICE_DIR", SCRIPT_DIR / "voices"))
DEFAULT_VOICE = os.environ.get("STEP_BROWSER_PIPER_DEFAULT_VOICE", "en_US-lessac-high")
USE_CUDA = os.environ.get("STEP_BROWSER_PIPER_USE_CUDA", "0").strip().lower() in {"1", "true", "yes", "on"}
MAX_TEXT_LEN = 8000

RECOMMENDED_VOICES = [
    "en_US-lessac-high",
    "en_US-lessac-medium",
    "en_US-ryan-high",
    "en_US-libritts-high",
    "en_GB-alan-medium",
]

PIPER_IMPORT_ERROR: Optional[str] = None
try:
    from piper import PiperVoice, SynthesisConfig
    from piper.download_voices import download_voice
except Exception as err:  # pragma: no cover - runtime environment dependent
    PiperVoice = None  # type: ignore[assignment]
    SynthesisConfig = None  # type: ignore[assignment]
    download_voice = None  # type: ignore[assignment]
    PIPER_IMPORT_ERROR = str(err)


@dataclass
class LoadedVoice:
    voice_id: str
    model_path: Path
    config_path: Path
    instance: object


VOICE_DIR.mkdir(parents=True, exist_ok=True)
_cache_lock = Lock()
_loaded_voices: Dict[str, LoadedVoice] = {}


def helper_ready() -> bool:
    return PiperVoice is not None and SynthesisConfig is not None and download_voice is not None


def list_downloaded_voices() -> List[str]:
    result = []
    for model_path in sorted(VOICE_DIR.glob("*.onnx")):
        config_path = model_path.with_suffix(model_path.suffix + ".json")
        if config_path.exists():
            result.append(model_path.stem)
    return result


def voice_paths(voice_id: str) -> tuple[Path, Path]:
    clean = voice_id.strip()
    model_path = VOICE_DIR / f"{clean}.onnx"
    config_path = VOICE_DIR / f"{clean}.onnx.json"
    return model_path, config_path


def ensure_voice_available(voice_id: str) -> tuple[Path, Path]:
    if not helper_ready():
        raise RuntimeError(f"Piper is not installed: {PIPER_IMPORT_ERROR or 'unknown import error'}")
    model_path, config_path = voice_paths(voice_id)
    if model_path.exists() and config_path.exists():
        return model_path, config_path
    # Auto-download on demand.
    try:
        download_voice(voice_id, VOICE_DIR)  # type: ignore[misc]
    except Exception as err:
        raise RuntimeError(
            f"Failed to download Piper voice '{voice_id}'. Run the install script or download the voice manually. Details: {err}"
        )
    if not model_path.exists() or not config_path.exists():
        raise RuntimeError(f"Voice '{voice_id}' did not download correctly into {VOICE_DIR}.")
    return model_path, config_path


def load_voice(voice_id: str) -> LoadedVoice:
    with _cache_lock:
        cached = _loaded_voices.get(voice_id)
        if cached is not None:
            return cached

    model_path, config_path = ensure_voice_available(voice_id)
    try:
        instance = PiperVoice.load(model_path, config_path=config_path, use_cuda=USE_CUDA)  # type: ignore[misc]
    except Exception as err:
        raise RuntimeError(f"Failed to load Piper voice '{voice_id}': {err}")

    loaded = LoadedVoice(voice_id=voice_id, model_path=model_path, config_path=config_path, instance=instance)
    with _cache_lock:
        _loaded_voices[voice_id] = loaded
    return loaded


def synthesize_wav_bytes(text: str, voice_id: str, speed: float = 1.0, volume: float = 1.0) -> bytes:
    loaded = load_voice(voice_id)
    speed = max(0.25, min(4.0, float(speed)))
    volume = max(0.1, min(4.0, float(volume)))
    # Piper uses length_scale: larger => slower. Treat speed > 1 as faster.
    syn_config = SynthesisConfig(length_scale=(1.0 / speed), volume=volume)  # type: ignore[misc]
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        loaded.instance.synthesize_wav(text, wav_file, syn_config=syn_config)  # type: ignore[attr-defined]
    return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "StepBrowserPiperTTS/0.94"

    def log_message(self, format: str, *args) -> None:
        sys.stdout.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def _send_headers(self, status: int = 200, content_type: str = "application/json; charset=utf-8", extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self._send_headers(status, "application/json; charset=utf-8", {"Content-Length": str(len(body))})
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._send_headers(204, "text/plain; charset=utf-8", {"Content-Length": "0"})

    def do_GET(self) -> None:
        path = self.path.rstrip("/") or "/"
        if path == "/":
            self._send_json({
                "ok": True,
                "name": "Step Browser Piper TTS Helper",
                "health": "/health",
                "voices": "/voices",
                "tts": "/tts",
            })
            return
        if path == "/health":
            downloaded = list_downloaded_voices()
            ok = helper_ready()
            payload = {
                "ok": ok,
                "engine": "piper",
                "voice_dir": str(VOICE_DIR),
                "downloaded_voices": downloaded,
                "voices": downloaded or RECOMMENDED_VOICES,
                "recommended_voice": downloaded[0] if downloaded else DEFAULT_VOICE,
                "default_voice": DEFAULT_VOICE,
                "use_cuda": USE_CUDA,
                "message": "Helper ready." if ok else f"Piper is not available: {PIPER_IMPORT_ERROR or 'unknown error'}",
            }
            self._send_json(payload, 200 if ok else 503)
            return
        if path == "/voices":
            self._send_json({
                "ok": helper_ready(),
                "downloaded_voices": list_downloaded_voices(),
                "recommended_voices": RECOMMENDED_VOICES,
                "default_voice": DEFAULT_VOICE,
                "voice_dir": str(VOICE_DIR),
            }, 200 if helper_ready() else 503)
            return
        self._send_json({"ok": False, "error": "Not found."}, 404)

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/tts":
            self._send_json({"ok": False, "error": "Not found."}, 404)
            return
        if not helper_ready():
            self._send_json({"ok": False, "error": f"Piper is not installed: {PIPER_IMPORT_ERROR or 'unknown import error'}"}, 503)
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        raw = self.rfile.read(content_length) if content_length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8") if raw else "{}")
        except json.JSONDecodeError:
            self._send_json({"ok": False, "error": "Invalid JSON body."}, 400)
            return

        text = str(payload.get("input") or "").strip()
        if not text:
            self._send_json({"ok": False, "error": "Missing input text."}, 400)
            return
        if len(text) > MAX_TEXT_LEN:
            self._send_json({"ok": False, "error": f"Input text exceeds {MAX_TEXT_LEN} characters."}, 400)
            return

        voice = str(payload.get("voice") or DEFAULT_VOICE).strip() or DEFAULT_VOICE
        try:
            speed = float(payload.get("speed", 1.0))
        except (TypeError, ValueError):
            speed = 1.0
        try:
            volume = float(payload.get("volume", 1.0))
        except (TypeError, ValueError):
            volume = 1.0

        try:
            wav_bytes = synthesize_wav_bytes(text, voice_id=voice, speed=speed, volume=volume)
            self._send_headers(200, "audio/wav", {"Content-Length": str(len(wav_bytes))})
            self.wfile.write(wav_bytes)
        except Exception as err:
            traceback.print_exc()
            self._send_json({
                "ok": False,
                "error": str(err),
                "voice": voice,
                "voice_dir": str(VOICE_DIR),
            }, 500)


def main() -> None:
    print(f"Step Browser Piper TTS helper listening on http://{HOST}:{PORT}")
    print(f"Voice directory: {VOICE_DIR}")
    print(f"Default voice: {DEFAULT_VOICE}")
    print(f"Piper installed: {'yes' if helper_ready() else 'no'}")
    if not helper_ready():
        print(f"Piper import error: {PIPER_IMPORT_ERROR}")
        print("Run install_piper_tts_helper.bat first.")
    else:
        downloaded = list_downloaded_voices()
        if downloaded:
            print(f"Downloaded voices: {', '.join(downloaded)}")
        else:
            print("No Piper voices are downloaded yet. The install script can fetch one, or the helper will try to download on first use.")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down helper...")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
