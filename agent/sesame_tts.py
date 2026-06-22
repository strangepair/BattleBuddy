"""Custom LiveKit TTS plugin for Sesame CSM running locally."""

import sys
import os
import asyncio

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sesame-csm"))
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["TORIO_USE_FFMPEG"] = "0"

import torch
from livekit.agents import tts
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

SPEAKER_ID = 3


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

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        pcm_float, sr = await asyncio.to_thread(self._tts_instance.generate_audio_sync, self._input_text)

        pcm_int16 = (pcm_float * 32767).clamp(-32768, 32767).to(torch.int16)
        raw_bytes = pcm_int16.numpy().tobytes()

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
