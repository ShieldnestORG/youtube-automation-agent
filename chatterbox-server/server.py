"""Chatterbox TTS API server — wraps ChatterboxTurboTTS behind a minimal FastAPI."""

import asyncio
import io
import os
import re

import torch
import torchaudio
from fastapi import Depends, FastAPI, HTTPException, Header, Request
from fastapi.responses import Response
from contextlib import asynccontextmanager
from pydantic import BaseModel

API_KEY = os.environ.get("CHATTERBOX_API_KEY", "")
VOICES_DIR = os.environ.get("VOICES_DIR", "/app/voices")
MAX_CHUNK_CHARS = 500

# ── Auth ────────────────────────────────────────────────────────────────────────

def verify_api_key(x_api_key: str = Header(default="")):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

# ── Startup / shutdown ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    from chatterbox.tts_turbo import ChatterboxTurboTTS

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Loading ChatterboxTurboTTS on {device}...")
    model = ChatterboxTurboTTS.from_pretrained(device=device)
    print(f"Model loaded. Sample rate: {model.sr}")

    app.state.model = model
    app.state.device = device
    app.state.gen_lock = asyncio.Lock()
    yield

app = FastAPI(title="Chatterbox TTS", lifespan=lifespan)

# ── Helpers ─────────────────────────────────────────────────────────────────────

def split_text(text: str, max_len: int = MAX_CHUNK_CHARS) -> list[str]:
    """Split text into chunks at sentence boundaries."""
    chunks = []
    remaining = text.strip()
    while len(remaining) > max_len:
        split_at = remaining.rfind(". ", 0, max_len)
        if split_at == -1:
            split_at = remaining.rfind(" ", 0, max_len)
        if split_at == -1:
            split_at = max_len
        chunks.append(remaining[: split_at + 1].strip())
        remaining = remaining[split_at + 1 :].strip()
    if remaining:
        chunks.append(remaining)
    return chunks


def resolve_voice_path(voice_ref: str) -> str | None:
    """Return the absolute path to a voice reference WAV, or None."""
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "", voice_ref)
    path = os.path.join(VOICES_DIR, f"{safe_name}.wav")
    return path if os.path.isfile(path) else None

# ── Routes ──────────────────────────────────────────────────────────────────────

class TTSRequest(BaseModel):
    text: str
    voice_ref: str = "default"
    temperature: float = 0.8


@app.get("/health")
async def health():
    return {"status": "ok", "model": "turbo", "device": app.state.device}


@app.post("/v1/tts", dependencies=[Depends(verify_api_key)])
async def tts(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty")

    voice_path = resolve_voice_path(req.voice_ref)
    model = app.state.model

    chunks = split_text(req.text)

    async with app.state.gen_lock:
        wavs = []
        for chunk in chunks:
            wav = await asyncio.to_thread(
                model.generate,
                chunk,
                audio_prompt_path=voice_path,
                temperature=req.temperature,
            )
            wavs.append(wav)

    combined = torch.cat(wavs, dim=-1)

    buf = io.BytesIO()
    torchaudio.save(buf, combined, model.sr, format="wav")
    buf.seek(0)

    return Response(content=buf.read(), media_type="audio/wav")
