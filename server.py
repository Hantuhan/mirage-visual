"""Mirage Visual — a local web portal for Cactus-Compute/mirage.

Runs the Mirage vision model on this machine through the `cactus-compute`
Python SDK and serves a browser UI for describe (scene, objects, masks, OCR,
relations, reasoning) and extract (constrained forms).
"""
from __future__ import annotations

import os

os.environ.setdefault("CACTUS_TELEMETRY", "0")

import json
import re
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

import cactus
import cactus.agent.mirage as mirage_module

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
SAMPLES = ROOT / "samples"
MAX_UPLOAD = 20 * 1024 * 1024

SECTIONS = ["scene", "objects", "text", "regions", "relations", "events", "reasoning"]
LANGUAGES = ["auto", "en", "de", "fr", "es", "it", "nl", "pl"]
MASK_FORMATS = ["polygons", "largest", "merged"]


# The native engine can emit bare nan/inf literals in score fields, which is
# invalid JSON. Swap the module's json for one that nulls them out first.
_BARE = re.compile(r'"(?:\\.|[^"\\])*"|(-?nan|-?inf(?:inity)?)', re.IGNORECASE)


class _SanitizingJSON:
    def __getattr__(self, name):
        return getattr(json, name)

    @staticmethod
    def loads(text, *args, **kwargs):
        try:
            return json.loads(text, *args, **kwargs)
        except json.JSONDecodeError:
            fixed = _BARE.sub(lambda m: "null" if m.group(1) else m.group(0), text)
            return json.loads(fixed, *args, **kwargs)


mirage_module.json = _SanitizingJSON()


class Engine:
    """Loads Mirage once in the background; calls are serialized by the SDK."""

    def __init__(self):
        self.model = None
        self.error = None
        self.load_seconds = None
        self._ready = threading.Event()
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        started = time.perf_counter()
        try:
            self.model = cactus.Mirage()
            self.load_seconds = round(time.perf_counter() - started, 2)
        except Exception as exc:  # surfaced through /api/health
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self._ready.set()

    def get(self):
        if not self._ready.wait(timeout=600):
            raise HTTPException(503, "Model is still loading")
        if self.model is None:
            raise HTTPException(500, f"Model failed to load: {self.error}")
        return self.model

    @property
    def status(self):
        if not self._ready.is_set():
            return "loading"
        return "ready" if self.model is not None else "error"


engine = Engine()
app = FastAPI(title="Mirage Visual")


async def _read_image(image: UploadFile) -> bytes:
    data = await image.read()
    if not data:
        raise HTTPException(400, "Empty image upload")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "Image is larger than 20 MB")
    return data


def _clamp(value, low, high, cast):
    try:
        return max(low, min(high, cast(value)))
    except (TypeError, ValueError):
        raise HTTPException(400, f"Invalid numeric option: {value!r}")


@app.get("/api/health")
def health():
    return {
        "status": engine.status,
        "error": engine.error,
        "load_seconds": engine.load_seconds,
        "sdk_version": getattr(cactus, "__version__", None),
        "weights": getattr(engine.model, "weights", None) and Path(engine.model.weights).name,
        "sections": SECTIONS,
        "languages": LANGUAGES,
        "mask_formats": MASK_FORMATS,
    }


@app.post("/api/describe")
async def describe(
    image: UploadFile = File(...),
    sections: str = Form("scene,objects,text"),
    language: str = Form("auto"),
    mask_format: str = Form("polygons"),
    conf: float = Form(0.5),
    text_conf: float = Form(0.35),
    max_objects: int = Form(20),
    max_text_lines: int = Form(20),
    max_tokens: int = Form(512),
    nms: bool = Form(True),
):
    data = await _read_image(image)
    chosen = [s.strip() for s in sections.split(",") if s.strip()]
    bad = [s for s in chosen if s not in SECTIONS]
    if bad or not chosen:
        raise HTTPException(400, f"Unknown or empty sections: {bad or chosen}")
    if language not in LANGUAGES:
        raise HTTPException(400, f"Unsupported language: {language}")
    if mask_format not in MASK_FORMATS:
        raise HTTPException(400, f"Unsupported mask_format: {mask_format}")

    options = {
        "sections": chosen,
        "mask_format": mask_format,
        "conf": _clamp(conf, 0.0, 1.0, float),
        "text_conf": _clamp(text_conf, 0.0, 1.0, float),
        "max_objects": _clamp(max_objects, 1, 64, int),
        "max_text_lines": _clamp(max_text_lines, 1, 64, int),
        "max_tokens": _clamp(max_tokens, 64, 1536, int),
        "nms": bool(nms),
    }
    model = engine.get()
    started = time.perf_counter()
    try:
        result = await run_in_threadpool(
            model.describe, data, options=options, language=None if language == "auto" else language
        )
    except (RuntimeError, ValueError, TypeError, OSError) as exc:
        raise HTTPException(422, f"Mirage could not process this image: {exc}")
    return JSONResponse({
        "result": result,
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
        "options": options,
        "language": language,
    })


@app.post("/api/extract")
async def extract(
    image: UploadFile = File(...),
    form: str = Form(...),
    conf: float = Form(0.5),
    text_conf: float = Form(0.35),
):
    data = await _read_image(image)
    try:
        schema = json.loads(form)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Form is not valid JSON: {exc}")
    if not isinstance(schema, dict) or not schema:
        raise HTTPException(400, "Form must be a non-empty JSON object of fields")
    model = engine.get()
    started = time.perf_counter()
    try:
        result = await run_in_threadpool(
            model.extract, data, schema,
            conf=_clamp(conf, 0.0, 1.0, float), text_conf=_clamp(text_conf, 0.0, 1.0, float),
        )
    except (RuntimeError, ValueError, TypeError, OSError) as exc:
        raise HTTPException(422, f"Mirage could not fill this form: {exc}")
    return {"result": result, "elapsed_ms": round((time.perf_counter() - started) * 1000), "form": schema}


@app.get("/api/samples")
def samples():
    names = sorted(p.name for p in SAMPLES.glob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
    return {"samples": [{"name": n, "url": f"/samples/{n}"} for n in names]}


app.mount("/samples", StaticFiles(directory=SAMPLES), name="samples")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", 7860)))
