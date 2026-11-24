# Mirage Visual

A web portal for [Cactus-Compute/mirage](https://huggingface.co/Cactus-Compute/mirage), a 51M-parameter,
2-bit vision model for scene description, object detection with masks, OCR, relations, reasoning and
constrained form extraction.

Mirage runs **entirely in the visitor's browser**, using Cactus's official WebAssembly engine in a Web
Worker. There is no server: images never leave the device, and the site is plain static files (fits
Cloudflare Pages). The first visit downloads the 21.6 MB weights (served by the site itself) and
caches them; after that the model loads in well under a second. Inference takes a few seconds per image
on a laptop (the WASM build is single-threaded).

## Run locally

```bash
python3 -m http.server 7860 --directory public
```

Open http://127.0.0.1:7860.

## Deploy to Cloudflare

```bash
npx wrangler deploy
```

`wrangler.toml` serves `public/` as static assets on Cloudflare Workers. Wrangler 4 needs Node 22.12 or newer.

## Features

Pick a photo (upload, drop, paste, or a sample), then a task. It runs automatically and results are
cached per task.

- **Overview** — scene, objects with masks and boxes, text. Extra sections (relations, events, reasoning)
  in Settings.
- **Category** — crime scene, mug shot, car plate, kitchen, or other.
- **Read text** — OCR, with plate-like strings highlighted.
- **Checklists** — Crime scene (also reads evidence-marker numbers), Car plate (also reads the plate
  number), Kitchen, and Custom questions you write yourself.
- **Mug shot** — checks a booking photo against capture best practice: the NIST mugshot / face-pose best
  practice (ANSI/NIST-ITL Type-10) and NIST OSAC 2024-N-0007 on head coverings, accessories and make-up.
  Measured exactly from pixels: 3:4 aspect ratio, resolution (600×800+), color, 18% gray background
  (corner RGB means 105–125, channels within 10), head centering and size. Judged by Mirage for a person
  to confirm: frontal pose, one subject, neutral expression, eyes open, mouth closed, glasses glare, head
  covering, ears visible, plain background without shadow, even lighting, focus, framing. Visible
  tattoos and placards are noted. Only measured rules can fail; Mirage's calls are "Check" or "Unclear".

Each answer gets a High / Medium / Low badge. When Mirage declines to answer, its best real choice is
shown as a low-confidence guess, and the full probabilities are one click away. Hover an object to
isolate it on the image. Raw JSON can be copied or downloaded.

## JSON output

Switch results to **JSON** (or set *Settings → Show results as → JSON* to make it the default), then
**Download .json** or **Copy**. Every task produces the same documented shape, `mirage-visual/v1`:

```json
{
  "schema": "mirage-visual/v1",
  "generated_at": "2026-11-24T00:29:11.166Z",
  "model": { "name": "Cactus-Compute/mirage", "revision": "76c1e9e", "engine": "Cactus 4.1.4 WebAssembly", "runs_on": "browser (on-device)" },
  "task": { "id": "plate", "title": "Car plate" },
  "image": { "name": "car.jpg", "width": 1280, "height": 960 },
  "elapsed_ms": 1700,
  "coordinates": "bbox = [x0, y0, x1, y1] on a 0–1000 scale …; bbox_px = the same in pixels",
  "answer": { "plate_number": "AE 6133CT", "confidence": 0.77, "level": "high", "candidates": [] },
  "checklist": [{ "question": "vehicle", "answer": "car", "confidence": 0.62, "level": "medium", "probabilities": { "car": 0.62, "truck": 0.2 } }],
  "scene": { "setting": "outdoor path" },
  "objects": [{ "id": 1, "name": "car", "confidence": 0.925, "bbox": [173, 91, 848, 804], "bbox_px": [221, 87, 1085, 772], "attributes": { "color": "red" } }],
  "text": [{ "text": "AE 6133CT", "confidence": 0.77, "bbox": [270, 553, 438, 597], "plate_like": true }]
}
```

`answer` depends on the task and always has the same keys (empty results are `null` or `[]`):
Category → `category`, `confidence`, `level`, `declined`; Car plate → `plate_number`, `confidence`,
`level`, `candidates`; Crime scene → `marker_numbers`; Mug shot → `verdict`, `passed`, `total`, `failed`,
`to_check`, `unclear`, `checks[]` (`rule`, `status` pass/check/fail/unclear, `detail`, `source`), `notes`.
`level` is high (≥ 0.7), medium (≥ 0.4), low, or guess (Mirage declined and this is its best choice).
Other sections appear only when the task produced them. Options add segmentation `mask` polygons to
objects and the untouched model output under `raw`.

## Limits

Mirage is a very small model. It does best when the subject is clear and fills much of the frame.
Crowded close-ups with many small items, unusual objects, and non-Latin text are hard for it, and it
will mislabel things (a camera as a "car", evidence markers as "toy cars").

## Layout

- `public/index.html`, `style.css`, `app.js` — UI; draws Mirage's 0–1000 relative coordinates on a canvas
- `public/worker.js` — loads the engine and weights, calls `cactus_describe`
- `public/models/mirage.cact` — Mirage weights (Apache-2.0) from [Cactus-Compute/mirage](https://huggingface.co/Cactus-Compute/mirage), revision `76c1e9e`, served from the site itself
- `public/vendor/cactus/` — Cactus engine 4.1.4 WebAssembly build (`cactus.js`, `cactus.wasm`), Apache-2.0,
  from [Cactus-Compute/cactus](https://huggingface.co/Cactus-Compute/cactus)
- `public/samples/` — sample images from the `hugging-apps/mirage-vision` Space and the Hugging Face
  documentation images dataset
