// Mirage Visual front end. Talks to server.py; draws Mirage's 0–1000 relative
// coordinates over the uploaded image on a canvas.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const PALETTE = ["#7cf2c8", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#fb7185", "#34d399", "#f97316", "#22d3ee", "#c084fc"];
const OCR_COLOR = "#ffcd00";
const DEFAULT_SECTIONS = ["scene", "objects", "text"];
const SECTION_LABELS = { scene: "Scene", objects: "Objects", text: "Text (OCR)", regions: "Regions", relations: "Relations", events: "Events", reasoning: "Reasoning" };
const LANGUAGE_LABELS = { auto: "Auto", en: "English", de: "Deutsch", fr: "Français", es: "Español", it: "Italiano", nl: "Nederlands", pl: "Polski" };
const MASK_LABELS = { polygons: "Polygons (all pieces)", largest: "Largest piece", merged: "Merged" };
const MAX_CANVAS = 2048;

const yesNo = { enum: ["present", "absent"] };
const PRESETS = {
  "Photo category": {
    category: { enum: ["crime scene", "mug shot", "kitchen", "other"] },
  },
  "Crime scene": {
    location: { enum: ["indoor", "outdoor"] },
    evidence_markers: yesNo,
    marker_count: { type: "integer", minimum: 0, maximum: 30 },
    blood_stains: yesNo,
    knife: yesNo,
    firearm: yesNo,
    gloves: yesNo,
    police_tape: yesNo,
  },
  "Mug shot": {
    view: { enum: ["front", "profile"] },
    height_chart: yesNo,
    placard: yesNo,
    background: { enum: ["plain wall", "height chart", "other"] },
    people_count: { type: "integer", minimum: 0, maximum: 5 },
  },
  "Kitchen": {
    stove: yesNo,
    sink: yesNo,
    refrigerator: yesNo,
    condition: { enum: ["clean", "cluttered", "dirty"] },
    people_count: { type: "integer", minimum: 0, maximum: 10 },
  },
  "Scene basics": {
    setting: { enum: ["indoor", "outdoor"] },
    n_people: { type: "integer", minimum: 0, maximum: 50 },
  },
  "Traffic sign": { sign: { enum: ["stop", "yield", "speed limit", "none"] } },
  "Product photo": {
    category: { enum: ["clothing", "footwear", "electronics", "food", "furniture", "other"] },
    background: { enum: ["plain", "studio", "lifestyle", "outdoor"] },
  },
  "Safety check": {
    hazard_visible: { enum: ["yes", "no"] },
    lighting: { enum: ["bright", "dim", "dark"] },
  },
};

const state = {
  mode: "describe",
  file: null,
  bitmap: null,
  sampleName: null,
  result: null,
  raw: null,
  hot: null,
  busy: false,
  ready: false,
  sections: new Set(DEFAULT_SECTIONS),
  layers: { masks: true, boxes: true, labels: true, text: true },
  fields: [],
};

const canvas = $("#canvas");
const ctx = canvas.getContext("2d");

// ---------- helpers ----------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 2) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "—");
const pct = (n) => (typeof n === "number" && Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—");
const colorFor = (i) => PALETTE[i % PALETTE.length];
const human = (s) => String(s).replace(/_/g, " ");

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), isErr ? 6000 : 2400);
}

function setBusy(b) {
  state.busy = b;
  $("#busy").hidden = !b;
  updateRun();
}

function updateRun() {
  const btn = $("#run");
  btn.disabled = state.busy || !state.ready || !state.file;
  $(".run-label", btn).textContent = state.busy ? "Running…" : state.mode === "extract" ? "Fill form" : "Analyze";
}

// ---------- in-browser engine (Web Worker) ----------
const pending = new Map();
let nextId = 1;
let worker = null;

function setStatus(stateName, text, title = "") {
  const el = $("#status");
  el.dataset.state = stateName;
  el.title = title;
  $("#status-text").textContent = text;
}

function startEngine() {
  if (typeof WebAssembly !== "object") return setStatus("error", "This browser can't run WebAssembly");
  worker = new Worker("/worker.js");
  worker.onmessage = ({ data: m }) => {
    if (m.type === "progress") {
      const mb = (n) => (n / 1048576).toFixed(1);
      const text = m.phase === "engine" ? "Starting engine…"
        : m.phase === "cache" ? "Loading cached model…"
        : m.phase === "load" ? "Preparing model…"
        : m.total ? `Downloading model ${mb(m.loaded)} / ${mb(m.total)} MB` : `Downloading model ${mb(m.loaded)} MB`;
      setStatus("loading", text);
    } else if (m.type === "ready") {
      state.ready = true;
      setStatus("ready", `Model ready · on your device · ${m.load_seconds}s`, "Mirage runs in this browser; images never leave your device.");
      updateRun();
    } else if (m.type === "error") {
      setStatus("error", "Model failed to load", m.error);
      toast(m.error, true);
    } else if (m.type === "result") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      m.error ? p.reject(new Error(m.error)) : p.resolve(m);
    }
  };
  worker.onerror = (e) => { setStatus("error", "Engine crashed", e.message); toast(e.message || "Engine crashed", true); };
}

function callEngine(payload) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, payload }, [payload.rgb]);
  });
}

// Packed RGB bytes for the engine. Mirage works on a ≤1536 px canvas internally,
// so very large photos are scaled down first to save memory.
const MAX_INPUT = 2048;
function bitmapToRgb(bmp) {
  const s = Math.min(1, MAX_INPUT / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  const rgba = g.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  return { rgb: rgb.buffer, width: w, height: h };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));

// ---------- image input ----------
async function setImage(blob, sampleName = null) {
  if (!blob || !blob.type.startsWith("image/")) return toast("That file is not an image", true);
  const token = (state.imageToken = (state.imageToken || 0) + 1);
  state.file = null; // block runs until the new image is decoded
  updateRun();
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    if (token !== state.imageToken) return; // a newer image superseded this one
    state.file = blob;
    state.bitmap = bmp;
    state.sampleName = sampleName;
    state.result = null;
    state.raw = null;
    state.hot = null;
    $$(".samples button").forEach((b) => b.classList.toggle("active", b.dataset.name === sampleName));
    $("#empty").hidden = true;
    $("#meta").textContent = `${bmp.width}×${bmp.height}`;
    renderResults();
    draw();
    updateRun();
  } catch {
    toast("Could not decode that image", true);
  }
}

function bindInput() {
  const drop = $("#drop");
  $("#file").addEventListener("change", (e) => e.target.files[0] && setImage(e.target.files[0]));
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; f && setImage(f); });
  // allow dropping onto the stage too
  const wrap = $("#canvas-wrap");
  wrap.addEventListener("dragover", (e) => e.preventDefault());
  wrap.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; f && setImage(f); });
  window.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) setImage(item.getAsFile());
  });
}

const SAMPLES = ["cafe_interior.jpg", "pallas_cat.jpg", "sign_beach.jpg", "sneakers_orange_bg.jpg"]
  .map((name) => ({ name, url: `/samples/${name}` }));

async function loadSamples() {
  try {
    const samples = SAMPLES;
    const box = $("#samples");
    box.innerHTML = samples.map((s) => `<button type="button" data-name="${esc(s.name)}" data-url="${esc(s.url)}" title="${esc(s.name)}"><img src="${esc(s.url)}" alt="${esc(s.name)}" loading="lazy"></button>`).join("");
    $$("button", box).forEach((b) => b.addEventListener("click", async () => {
      state.file = null;
      updateRun();
      const blob = await (await fetch(b.dataset.url)).blob();
      setImage(blob, b.dataset.name);
    }));
    if (samples[0]) $$("button", box)[0].click();
  } catch { /* samples are optional */ }
}

// ---------- describe controls ----------
function buildDescribeControls() {
  $("#sections").innerHTML = Object.keys(SECTION_LABELS).map((s) => `<button type="button" class="chip" data-section="${s}" aria-pressed="${state.sections.has(s)}">${SECTION_LABELS[s]}</button>`).join("");
  $$("#sections .chip").forEach((c) => c.addEventListener("click", () => {
    const s = c.dataset.section;
    if (state.sections.has(s)) {
      if (state.sections.size === 1) return toast("Keep at least one section");
      state.sections.delete(s);
    } else state.sections.add(s);
    c.setAttribute("aria-pressed", state.sections.has(s));
  }));
  $("#language").innerHTML = Object.entries(LANGUAGE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  $("#mask_format").innerHTML = Object.entries(MASK_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  ["conf", "text_conf", "max_objects", "max_text_lines", "max_tokens"].forEach((id) => {
    const input = $(`#${id}`), out = $(`#${id}-out`);
    const sync = () => (out.textContent = input.step.includes(".") ? Number(input.value).toFixed(2) : input.value);
    input.addEventListener("input", sync);
    sync();
  });
}

// ---------- extract form builder ----------
function schemaToFields(schema) {
  return Object.entries(schema).map(([name, spec]) => {
    if (Array.isArray(spec?.enum)) return { name, type: "enum", choices: spec.enum.join(", ") };
    if (spec?.type === "integer") return { name, type: "integer", min: spec.minimum ?? 0, max: spec.maximum ?? 10 };
    return { name, type: "string" };
  });
}

function fieldsToSchema() {
  const out = {};
  for (const f of state.fields) {
    const name = f.name.trim();
    if (!name) continue;
    if (f.type === "enum") {
      const choices = f.choices.split(",").map((c) => c.trim()).filter(Boolean);
      if (choices.length) out[name] = { enum: choices };
    } else if (f.type === "integer") {
      out[name] = { type: "integer", minimum: Number(f.min) || 0, maximum: Number(f.max) || 0 };
    } else out[name] = { type: "string" };
  }
  return out;
}

function renderFields() {
  const box = $("#fields");
  box.innerHTML = state.fields.map((f, i) => `
    <div class="form-field" data-i="${i}">
      <div class="top">
        <input type="text" data-k="name" value="${esc(f.name)}" placeholder="field_name" aria-label="Field name">
        <select data-k="type" aria-label="Field type">
          <option value="enum" ${f.type === "enum" ? "selected" : ""}>Choice</option>
          <option value="integer" ${f.type === "integer" ? "selected" : ""}>Integer</option>
          <option value="string" ${f.type === "string" ? "selected" : ""}>Text</option>
        </select>
        <button type="button" class="icon-btn" data-remove aria-label="Remove field">×</button>
      </div>
      ${f.type === "enum" ? `<input type="text" data-k="choices" value="${esc(f.choices)}" placeholder="choice a, choice b, choice c" aria-label="Choices">` : ""}
      ${f.type === "integer" ? `<div class="range"><input type="number" data-k="min" value="${esc(f.min)}" aria-label="Minimum" placeholder="min"><input type="number" data-k="max" value="${esc(f.max)}" aria-label="Maximum" placeholder="max"></div>` : ""}
    </div>`).join("");
  $$(".form-field", box).forEach((row) => {
    const i = Number(row.dataset.i);
    $$("[data-k]", row).forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      const k = el.dataset.k;
      state.fields[i][k] = el.value;
      if (k === "type") {
        Object.assign(state.fields[i], el.value === "enum" ? { choices: state.fields[i].choices || "" } : el.value === "integer" ? { min: 0, max: 10 } : {});
        renderFields();
      }
      syncFormJson();
    }));
    $("[data-remove]", row).addEventListener("click", () => { state.fields.splice(i, 1); renderFields(); syncFormJson(); });
  });
}

function syncFormJson() {
  $("#form-json").value = JSON.stringify(fieldsToSchema(), null, 2);
}

function loadSchema(schema) {
  state.fields = schemaToFields(schema);
  renderFields();
  syncFormJson();
}

function buildExtractControls() {
  $("#preset").innerHTML += Object.keys(PRESETS).map((p) => `<option>${esc(p)}</option>`).join("");
  $("#preset").addEventListener("change", (e) => { if (PRESETS[e.target.value]) loadSchema(PRESETS[e.target.value]); e.target.value = ""; });
  $("#add-field").addEventListener("click", () => { state.fields.push({ name: "", type: "enum", choices: "" }); renderFields(); syncFormJson(); $("#fields .form-field:last-child input")?.focus(); });
  $("#form-json").addEventListener("input", (e) => {
    try {
      const parsed = JSON.parse(e.target.value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { state.fields = schemaToFields(parsed); renderFields(); }
    } catch { /* keep typing */ }
  });
  loadSchema(PRESETS["Photo category"]);
}

// ---------- mode & tabs ----------
function bindTabs() {
  $$(".controls .tab").forEach((t) => t.addEventListener("click", () => {
    state.mode = t.dataset.mode;
    $$(".controls .tab").forEach((x) => x.classList.toggle("active", x === t));
    $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== state.mode));
    updateRun();
  }));
  $$(".results .tab").forEach((t) => t.addEventListener("click", () => {
    $$(".results .tab").forEach((x) => x.classList.toggle("active", x === t));
    $("#view-summary").hidden = t.dataset.view !== "summary";
    $("#view-json").hidden = t.dataset.view !== "json";
  }));
  $$("#layers input").forEach((i) => i.addEventListener("change", () => { state.layers[i.dataset.layer] = i.checked; draw(); }));
}

// ---------- run ----------
async function run() {
  if ($("#run").disabled) return;
  const conf = clamp($("#conf").value, 0, 1), text_conf = clamp($("#text_conf").value, 0, 1);
  let options, language = null, echo;
  if (state.mode === "describe") {
    options = {
      sections: [...state.sections],
      mask_format: $("#mask_format").value,
      conf, text_conf,
      max_objects: clamp($("#max_objects").value, 1, 64) | 0,
      max_text_lines: clamp($("#max_text_lines").value, 1, 64) | 0,
      max_tokens: clamp($("#max_tokens").value, 64, 1536) | 0,
      nms: $("#nms").checked,
    };
    language = $("#language").value === "auto" ? null : $("#language").value;
    echo = { options, language: $("#language").value };
  } else {
    const schema = fieldsToSchema();
    if (!Object.keys(schema).length) return toast("Add at least one complete form field", true);
    options = { form: schema, conf, text_conf };
    echo = { form: schema };
  }
  const token = state.imageToken;
  const mode = state.mode;
  setBusy(true);
  try {
    const body = { ...(await callEngine({ ...bitmapToRgb(state.bitmap), options, language })), ...echo };
    delete body.type;
    delete body.id;
    if (token !== state.imageToken) return; // image changed while running
    state.raw = body;
    state.result = { mode, ...body };
    state.hot = null;
    $("#meta").textContent = `${state.bitmap.width}×${state.bitmap.height} · ${body.elapsed_ms} ms`;
    renderResults();
    draw();
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(false);
  }
}

// ---------- canvas ----------
function maskRings(mask) {
  if (!Array.isArray(mask) || !mask.length) return [];
  if (typeof mask[0] === "number") return [mask];
  if (Array.isArray(mask[0]) && typeof mask[0][0] === "number") return mask;
  if (Array.isArray(mask[0])) return mask.flatMap(maskRings);
  return [];
}

function objects() {
  return state.result?.mode === "describe" ? state.result.result?.objects || [] : [];
}

function draw() {
  const bmp = state.bitmap;
  if (!bmp) return;
  const scale = Math.min(1, MAX_CANVAS / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * scale), H = Math.round(bmp.height * scale);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bmp, 0, 0, W, H);
  if (state.result?.mode !== "describe") return;

  const sx = W / 1000, sy = H / 1000;
  const lw = Math.max(2, Math.round(Math.max(W, H) / 320));
  const fontPx = Math.max(12, Math.round(Math.max(W, H) / 52));
  const objs = objects();
  const hot = state.hot;
  const dim = (i) => hot !== null && hot !== i;

  if (hot !== null) { ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(0, 0, W, H); ctx.drawImage(bmp, 0, 0, W, H); }

  if (state.layers.masks) {
    objs.forEach((o, i) => {
      const rings = maskRings(o.mask);
      if (!rings.length) return;
      ctx.beginPath();
      for (const r of rings) {
        if (r.length < 6) continue;
        ctx.moveTo(r[0] * sx, r[1] * sy);
        for (let k = 2; k + 1 < r.length; k += 2) ctx.lineTo(r[k] * sx, r[k + 1] * sy);
        ctx.closePath();
      }
      ctx.globalAlpha = dim(i) ? 0.08 : hot === i ? 0.45 : 0.3;
      ctx.fillStyle = colorFor(i);
      ctx.fill("evenodd");
      ctx.globalAlpha = dim(i) ? 0.15 : 0.9;
      ctx.lineWidth = Math.max(1, lw / 2);
      ctx.strokeStyle = colorFor(i);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  const label = (text, x, y, color, alpha) => {
    ctx.font = `600 ${fontPx}px Inter, system-ui, sans-serif`;
    const pad = Math.round(fontPx * 0.35);
    const tw = ctx.measureText(text).width + pad * 2, th = fontPx + pad * 1.4;
    let ly = y - th;
    if (ly < 0) ly = y;
    const lx = Math.min(Math.max(0, x), W - tw);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly, tw, th);
    ctx.fillStyle = "#0b0d12";
    ctx.textBaseline = "middle";
    ctx.fillText(text, lx + pad, ly + th / 2);
    ctx.globalAlpha = 1;
  };

  if (state.layers.boxes || state.layers.labels) {
    objs.forEach((o, i) => {
      if (!Array.isArray(o.bbox) || o.bbox.length < 4) return;
      const [x0, y0, x1, y1] = o.bbox;
      const a = dim(i) ? 0.2 : 1;
      if (state.layers.boxes) {
        ctx.globalAlpha = a;
        ctx.lineWidth = hot === i ? lw * 1.6 : lw;
        ctx.strokeStyle = colorFor(i);
        ctx.strokeRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
        ctx.globalAlpha = 1;
      }
      if (state.layers.labels) label(`${o.name} ${fmt(o.score)}`, x0 * sx, y0 * sy, colorFor(i), a);
    });
  }

  if (state.layers.text) {
    for (const t of state.result.result?.text || []) {
      if (!Array.isArray(t.bbox) || t.bbox.length < 4) continue;
      const [x0, y0, x1, y1] = t.bbox;
      ctx.lineWidth = Math.max(1.5, lw * 0.6);
      ctx.strokeStyle = OCR_COLOR;
      ctx.globalAlpha = hot !== null ? 0.3 : 1;
      ctx.strokeRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
      ctx.globalAlpha = 1;
      if (state.layers.labels) label(t.string, x0 * sx, y0 * sy, OCR_COLOR, hot !== null ? 0.3 : 0.95);
    }
  }
}

function setHot(i) {
  if (state.hot === i) return;
  state.hot = i;
  $$(".obj").forEach((el) => el.classList.toggle("hot", Number(el.dataset.i) === i));
  draw();
}

function bindCanvasHover() {
  canvas.addEventListener("mousemove", (e) => {
    const objs = objects();
    if (!objs.length) return;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 1000, y = ((e.clientY - r.top) / r.height) * 1000;
    let best = null, area = Infinity;
    objs.forEach((o, i) => {
      const b = o.bbox;
      if (!b || x < b[0] || x > b[2] || y < b[1] || y > b[3]) return;
      const a = (b[2] - b[0]) * (b[3] - b[1]);
      if (a < area) { area = a; best = i; }
    });
    setHot(best);
  });
  canvas.addEventListener("mouseleave", () => setHot(null));
  new ResizeObserver(() => draw()).observe($("#canvas-wrap"));
}

// ---------- results ----------
function renderResults() {
  const view = $("#view-summary");
  $("#json").textContent = state.raw ? JSON.stringify(state.raw.result, null, 2) : "";
  if (!state.result) { view.innerHTML = `<p class="placeholder">Results appear here after you ${state.file ? "run Mirage on this image" : "pick an image"}.</p>`; return; }
  view.innerHTML = state.result.mode === "describe" ? describeHtml(state.result.result) : extractHtml(state.result.result);
  $$(".obj", view).forEach((el) => {
    el.addEventListener("mouseenter", () => setHot(Number(el.dataset.i)));
    el.addEventListener("mouseleave", () => setHot(null));
  });
}

function describeHtml(r) {
  const parts = [];
  const objs = r.objects || [];
  const nameById = new Map();
  objs.forEach((o, i) => { if (o.id != null && !nameById.has(o.id)) nameById.set(o.id, { name: o.name, i }); });
  const tag = (id) => {
    const hit = nameById.get(id);
    return hit ? `<span class="tag"><i style="background:${colorFor(hit.i)}"></i>${esc(hit.name)}</span>` : `<span class="tag" title="Object below the confidence threshold">object #${esc(id)}</span>`;
  };

  if (r.scene && Object.keys(r.scene).length) {
    parts.push(`<section><h3>Scene</h3><div class="kv">${Object.entries(r.scene).map(([k, v]) => `<span><b>${esc(human(k))}</b>${esc(v)}</span>`).join("")}</div></section>`);
  }
  if ("objects" in r) {
    parts.push(`<section><h3>Objects <span class="count">${objs.length}</span></h3>${objs.length ? `<ul class="list">${objs.map((o, i) => {
      const attrs = [o.position && `position: ${o.position}`, ...Object.entries(o.description || {}).map(([k, v]) => `${human(k)}: ${v}`)].filter(Boolean);
      return `<li class="obj" data-i="${i}">
        <span class="sw" style="background:${colorFor(i)}"></span>
        <span class="name">${esc(o.name)}${o.id != null ? `<small>#${esc(o.id)}</small>` : ""}</span>
        <span class="score">${fmt(o.score)}</span>
        <span class="bar"><i style="width:${Math.max(0, Math.min(1, o.score || 0)) * 100}%;background:${colorFor(i)}"></i></span>
        ${attrs.length ? `<span class="attrs">${attrs.map((a) => `<span>${esc(a)}</span>`).join("")}</span>` : ""}
      </li>`;
    }).join("")}</ul>` : `<p class="placeholder">No objects above the confidence threshold.</p>`}</section>`);
  }
  if ("text" in r) {
    const lines = r.text || [];
    parts.push(`<section><h3>Text (OCR) <span class="count">${lines.length}</span></h3>${lines.length ? `<div class="list">${lines.map((t) => `<div class="ocr"><q>${esc(t.string)}</q><span class="score">${fmt(t.score)}</span></div>`).join("")}</div>` : `<p class="placeholder">No text found.</p>`}</section>`);
  }
  if ("relations" in r) {
    const rels = r.relations || [];
    parts.push(`<section><h3>Relations <span class="count">${rels.length}</span></h3>${rels.length ? rels.map((x) => typeof x === "object" && x
      ? `<div class="rel">${tag(x.subject)}<span class="pred">${esc(human(x.predicate))}</span>${tag(x.object)}</div>`
      : `<div class="raw">${esc(JSON.stringify(x))}</div>`).join("") : `<p class="placeholder">None detected.</p>`}</section>`);
  }
  for (const key of ["regions", "events"]) {
    if (!(key in r)) continue;
    const items = r[key] || [];
    parts.push(`<section><h3>${SECTION_LABELS[key]} <span class="count">${items.length}</span></h3>${items.length ? items.map((x) => `<div class="raw">${esc(typeof x === "string" ? x : JSON.stringify(x))}</div>`).join("") : `<p class="placeholder">None detected.</p>`}</section>`);
  }
  if (r.reasoning) {
    const steps = String(r.reasoning).split("|").map((s) => s.trim()).filter((s) => s && !/^lang:/i.test(s));
    parts.push(`<section><h3>Reasoning</h3><ol class="reason">${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>`);
  }
  return parts.join("") || `<p class="placeholder">Mirage returned no content for these sections.</p>`;
}

function extractHtml(r) {
  const form = r.form || {};
  const entries = Object.entries(form);
  if (!entries.length) return `<p class="placeholder">No fields returned.</p>`;
  const isNone = (v) => v === null || v === undefined || v === "-";
  const unsure = entries.filter(([, f]) => isNone(f.value)).length;
  const note = unsure === entries.length
    ? `<p class="notice">Mirage wasn't confident about any of these fields, so it declined to guess. It's a small 51M-parameter model: it does best when the subject is clear and fills much of the frame, and when the questions and choices fit the photo. Crowded close-ups with many small items are hard for it.</p>`
    : unsure ? `<p class="hint">${unsure} of ${entries.length} fields had no clear match; Mirage reports that instead of guessing.</p>` : "";
  return `<section><h3>Form <span class="count">${entries.length} field${entries.length === 1 ? "" : "s"}</span></h3>${note}<div class="list" style="gap:8px">${entries.map(([name, f]) => {
    const none = f.value === null || f.value === undefined || f.value === "-";
    let body = "";
    if (f.probabilities) {
      const sorted = Object.entries(f.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 6);
      body = sorted.map(([k, p], j) => `<div class="prob ${j === 0 ? "top" : ""}"><span title="${esc(k)}">${k === "-" ? "no match" : esc(k)}</span><span class="track"><i style="width:${p * 100}%"></i></span><span class="pct">${pct(p)}</span></div>`).join("");
    } else if (typeof f.probability === "number") {
      body = `<div class="prob top"><span>confidence</span><span class="track"><i style="width:${f.probability * 100}%"></i></span><span class="pct">${pct(f.probability)}</span></div>`;
    }
    // When Mirage declines, still surface its best real choice, marked as low-confidence.
    const lean = none && f.probabilities
      ? Object.entries(f.probabilities).filter(([k]) => k !== "-").sort((a, b) => b[1] - a[1])[0]
      : null;
    const leanHtml = lean ? `<div class="lean">Leaning: <b>${esc(lean[0])}</b> <span>(${pct(lean[1])}, low confidence)</span></div>` : "";
    return `<div class="form-out"><header><b>${esc(name)}</b></header><div class="val ${none ? "none" : ""}">${none ? "No clear match" : esc(typeof f.value === "object" ? JSON.stringify(f.value) : f.value)}</div>${leanHtml}${body}</div>`;
  }).join("")}</div></section>`;
}

// ---------- json tools ----------
function bindJson() {
  $("#copy-json").addEventListener("click", async () => {
    if (!state.raw) return toast("Nothing to copy yet");
    await navigator.clipboard.writeText(JSON.stringify(state.raw.result, null, 2));
    toast("JSON copied");
  });
  $("#download-json").addEventListener("click", () => {
    if (!state.raw) return toast("Nothing to download yet");
    const blob = new Blob([JSON.stringify(state.raw, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `mirage-${state.result.mode}-${Date.now()}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ---------- boot ----------
buildDescribeControls();
buildExtractControls();
bindTabs();
bindInput();
bindCanvasHover();
bindJson();
$("#run").addEventListener("click", run);
window.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); });
loadSamples();
startEngine();
