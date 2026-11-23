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
- **Checklists** — Crime scene (also reads evidence-marker numbers), Mug shot, Car plate (also reads the
  plate number), Kitchen, and Custom questions you write yourself.

Each answer gets a High / Medium / Low badge. When Mirage declines to answer, its best real choice is
shown as a low-confidence guess, and the full probabilities are one click away. Hover an object to
isolate it on the image. Raw JSON can be copied or downloaded.

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
