"""Custom LiveKit TTS plugin for Sesame CSM running locally."""

import sys
import os
import asyncio
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sesame-csm"))
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["TORIO_USE_FFMPEG"] = "0"

import torch
from livekit.agents import tts
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

SPEAKER_ID = 3
TTS_TIMEOUT_SECONDS = 3


def _log_voice_failure(reason: str, session_id: str = "") -> dict:
    """Emit a structured voice_failure log entry and return the event dict."""
    event = {
        "type": "voice_failure",
        "reason": reason,
        "session_id": session_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    print(f"[SesameTTS] VOICE_FAILURE {event}")
    return event


class SesameTTS(tts.TTS):
    def __init__(self):
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1,
        )
        self._generator = None

    def _ensure_loaded(self):
        if self._generator is None:
            from generator import load_csm_1b
            device = "mps" if torch.backends.mps.is_available() else "cpu"
            print(f"[SesameTTS] Loading CSM model on {device}...")
            self._generator = load_csm_1b(device=device)
            print("[SesameTTS] Model loaded.")

    def synthesize(self, text: str, *, conn_options=DEFAULT_API_CONNECT_OPTIONS) -> "SesameSynthesizeStream":
        return SesameSynthesizeStream(tts_instance=self, input_text=text, conn_options=conn_options)

    def generate_audio_sync(self, text: str) -> tuple:
        self._ensure_loaded()
        audio = self._generator.generate(
            text=text,
            speaker=SPEAKER_ID,
            context=[],
            max_audio_length_ms=30000,
        )
        return audio.cpu(), self._generator.sample_rate


class SesameSynthesizeStream(tts.ChunkedStream):
    def __init__(self, *, tts_instance: SesameTTS, input_text: str, conn_options):
        super().__init__(tts=tts_instance, input_text=input_text, conn_options=conn_options)
        self._tts_instance = tts_instance

    # TODO: add unit test for voice_failure path
    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        try:
            pcm_float, sr = await asyncio.wait_for(
                asyncio.to_thread(self._tts_instance.generate_audio_sync, self._input_text),
                timeout=TTS_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            _log_voice_failure(f"TTS generation exceeded {TTS_TIMEOUT_SECONDS}s timeout")
            raise
        except Exception as exc:
            _log_voice_failure(f"TTS generation error: {exc}")
            raise

        raw_bytes = (pcm_float * 32767).clamp(-32768, 32767).to(torch.int16).numpy().tobytes()

        if not raw_bytes:
            _log_voice_failure("TTS produced zero audio bytes")
            raise RuntimeError("SesameTTS produced no audio output")

        output_emitter.initialize(
            request_id="sesame",
            sample_rate=sr,
            num_channels=1,
            mime_type="audio/pcm",
        )

        chunk_size = sr * 2  # 1 second of 16-bit mono audio
        for i in range(0, len(raw_bytes), chunk_size):
            output_emitter.push(raw_bytes[i:i + chunk_size])

        output_emitter.flush()
