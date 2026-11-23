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

## Deploy to Cloudflare Pages

```bash
npx wrangler pages deploy
```

`wrangler.toml` points Pages at `public/`. Wrangler 4 needs Node 22.12 or newer.

## Features

- **Describe** — pick sections (scene, objects, text, regions, relations, events, reasoning), output
  language, mask format, and thresholds. Boxes, segmentation masks and OCR lines are drawn over the image;
  hover an object in the list or on the image to isolate it.
- **Extract** — build a form of choice / integer / text fields (or edit the JSON) and see the chosen
  value plus the probability of each option. Extract only answers the questions you write, so tailor
  them to the photo. “No clear match” means the model declined to guess.
- Raw JSON view with copy and download.

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
