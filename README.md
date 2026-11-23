# Mirage Visual

A local web portal for [Cactus-Compute/mirage](https://huggingface.co/Cactus-Compute/mirage), a 51M-parameter,
2-bit on-device vision model for scene description, object detection with masks, OCR, relations,
reasoning and constrained form extraction.

The model runs on your machine through the `cactus-compute` Python SDK (no hosted API exists).
First start downloads the engine and the 21.6 MB weights and caches them.

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python server.py
```

Open http://127.0.0.1:7860. Set `PORT` to change the port.

## Features

- **Describe** — pick sections (scene, objects, text, regions, relations, events, reasoning), output
  language, mask format, and thresholds. Boxes, segmentation masks and OCR lines are drawn over the image;
  hover an object in the list or on the image to isolate it.
- **Extract** — build a form of choice / integer / text fields (or edit the JSON) and see the chosen
  value plus the probability of each option. `-` / “No clear match” means the model declined to guess.
- Raw JSON view with copy and download.

## API

- `GET  /api/health` — model load status
- `POST /api/describe` — multipart: `image`, `sections` (comma list), `language`, `mask_format`,
  `conf`, `text_conf`, `max_objects`, `max_text_lines`, `max_tokens`, `nms`
- `POST /api/extract` — multipart: `image`, `form` (JSON object), `conf`, `text_conf`

Mirage returns coordinates on a 0–1000 scale relative to image width and height.

Sample images in `samples/` come from the `hugging-apps/mirage-vision` Space and the Hugging Face
documentation images dataset.
