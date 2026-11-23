// Mirage Visual — task-based UI. Mirage runs in worker.js (Cactus WebAssembly);
// this file picks images, runs tasks, and draws Mirage's 0–1000 coordinates on a canvas.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const PALETTE = ["#f5b301", "#60a5fa", "#f472b6", "#34d399", "#a78bfa", "#fb7185", "#22d3ee", "#f97316", "#a3e635", "#c084fc"];
const OCR_COLOR = "#ffcd00";
const PLATE_COLOR = "#f97316";
const MAX_CANVAS = 2048;
const MAX_INPUT = 2048;

const SECTION_LABELS = { scene: "Scene", objects: "Objects", text: "Text", regions: "Regions", relations: "Relations", events: "Events", reasoning: "Reasoning" };
const LANGUAGE_LABELS = { auto: "Auto", en: "English", de: "Deutsch", fr: "Français", es: "Español", it: "Italiano", nl: "Nederlands", pl: "Polski" };
const MASK_LABELS = { polygons: "Outline, all pieces", largest: "Largest piece only", merged: "Merged" };

// ---------- tasks ----------
const yesNo = { enum: ["present", "absent"] };
const CATEGORIES = ["crime scene", "mug shot", "car plate", "kitchen", "other"];
const FORMS = {
  category: { category: { enum: CATEGORIES } },
  crime: {
    location: { enum: ["indoor", "outdoor"] },
    evidence_markers: yesNo,
    marker_count: { type: "integer", minimum: 0, maximum: 30 },
    blood_stains: yesNo,
    knife: yesNo,
    firearm: yesNo,
    gloves: yesNo,
    police_tape: yesNo,
  },
  // Visual questions behind the NIST mugshot best practice and OSAC 2024-N-0007 (see MUG_RULES).
  mugshot: {
    pose: { enum: ["frontal", "left profile", "right profile", "half profile"] },
    expression: { enum: ["neutral", "smiling", "other"] },
    eyes: { enum: ["open", "closed"] },
    mouth: { enum: ["closed", "open"] },
    eyeglasses: { enum: ["none", "glasses", "glasses with glare"] },
    head_covering: yesNo,
    ears_visible: { enum: ["yes", "no"] },
    background: { enum: ["plain gray", "plain white", "plain other color", "height chart", "busy or patterned"] },
    background_shadow: yesNo,
    face_lighting: { enum: ["even", "shadowed", "glare or hot spots"] },
    sharpness: { enum: ["sharp", "blurry"] },
    composition: { enum: ["head only", "head and shoulders", "upper body", "full body"] },
    people_count: { type: "integer", minimum: 0, maximum: 5 },
    placard: yesNo,
    visible_tattoos: yesNo,
  },
  plate: {
    vehicle: { enum: ["car", "motorcycle", "truck", "bus", "none"] },
    plate_visible: yesNo,
    plate_color: { enum: ["white", "yellow", "black", "blue", "other"] },
  },
  kitchen: {
    stove: yesNo,
    sink: yesNo,
    refrigerator: yesNo,
    condition: { enum: ["clean", "cluttered", "dirty"] },
    people_count: { type: "integer", minimum: 0, maximum: 10 },
  },
};

const ICONS = {
  overview: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  category: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  crime: '<path d="M3 20h18"/><path d="M6 20 10.5 5h3L18 20"/><path d="M10 14h4"/>',
  mugshot: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7 18c1-2.4 3-3.4 5-3.4s4 1 5 3.4"/>',
  plate: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 12h2M10.5 12h3M16 12h2"/>',
  kitchen: '<path d="M4 11h16v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M2 11h20M9 7c0-1.2 1-1.8 1-3M14 7c0-1.2 1-1.8 1-3"/>',
  custom: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
};

const TASKS = {
  overview: { group: "general", title: "Overview", desc: "Scene, objects, text", calls: (s) => [{ describe: { sections: [...s.sections] } }] },
  category: { group: "general", title: "Category", desc: "Crime scene, mug shot…", calls: () => [{ extract: FORMS.category }] },
  text: { group: "general", title: "Read text", desc: "Signs, labels, plates", calls: () => [{ describe: { sections: ["text"] } }] },
  crime: { group: "check", title: "Crime scene", desc: "Evidence, markers, weapons", calls: () => [{ extract: FORMS.crime }, { describe: { sections: ["objects", "text"] } }] },
  mugshot: { group: "check", title: "Mug shot", desc: "Check against NIST capture rules", calls: () => [{ extract: FORMS.mugshot }, { describe: { sections: ["objects"] } }] },
  plate: { group: "check", title: "Car plate", desc: "Vehicle and plate number", calls: () => [{ extract: FORMS.plate }, { describe: { sections: ["objects", "text"] } }] },
  kitchen: { group: "check", title: "Kitchen", desc: "Appliances, condition", calls: () => [{ extract: FORMS.kitchen }] },
  custom: { group: "check", title: "Custom", desc: "Your own questions", calls: () => [{ extract: fieldsToSchema() }] },
};

const SAMPLES = ["cafe_interior.jpg", "sign_beach.jpg", "pallas_cat.jpg", "sneakers_orange_bg.jpg"].map((name) => ({ name, url: `/samples/${name}` }));

const state = {
  task: "overview",
  file: null,
  bitmap: null,
  sampleName: null,
  imageToken: 0,
  result: null, // { task, describe, form, elapsed_ms, steps }
  hot: null,
  busy: false,
  queued: false,
  ready: false,
  cache: new Map(),
  sections: new Set(["scene", "objects", "text"]),
  layers: { masks: true, boxes: true, labels: true, text: true },
  fields: [],
  view: "summary",
};

const canvas = $("#canvas");
const ctx = canvas.getContext("2d");

// ---------- helpers ----------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 2) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "—");
const pct = (n) => (typeof n === "number" && Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—");
const colorFor = (i) => PALETTE[i % PALETTE.length];
const human = (s) => String(s).replace(/_/g, " ");
const cap = (s) => human(s).replace(/^./, (c) => c.toUpperCase());
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
const isNone = (v) => v === null || v === undefined || v === "-";
const looksLikePlate = (s) => {
  const t = String(s || "").replace(/[\s.\-·]/g, "");
  return t.length >= 4 && t.length <= 10 && /^[A-Z0-9]+$/i.test(t) && /\d/.test(t) && /[A-Z]/i.test(t);
};

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), isErr ? 6000 : 2400);
}

function setStatus(stateName, text, title = "") {
  const el = $("#status");
  el.dataset.state = stateName;
  el.title = title;
  $("#status-text").textContent = text;
}

function setBusy(b, text = "Analyzing…") {
  state.busy = b;
  $("#busy").hidden = !b;
  $("#busy-text").textContent = text;
  if (!state.result) renderResults(); // keep the placeholder in step with the busy state
  updateRun();
}

function updateRun() {
  const btn = $("#run");
  btn.disabled = state.busy || !state.ready || !state.file;
  const fresh = !state.result || state.result.task !== state.task;
  $(".run-label", btn).textContent = state.busy ? "Analyzing…" : fresh ? `Analyze · ${TASKS[state.task].title}` : "Analyze again";
}

// ---------- engine (Web Worker) ----------
const pending = new Map();
let nextId = 1;
let worker = null;

function startEngine() {
  if (typeof WebAssembly !== "object" || typeof OffscreenCanvas !== "function") {
    return setStatus("error", "This browser is too old to run Mirage");
  }
  worker = new Worker("/worker.js");
  worker.onmessage = ({ data: m }) => {
    if (m.type === "progress") {
      const mb = (n) => (n / 1048576).toFixed(1);
      const text = m.phase === "engine" ? "Starting engine…"
        : m.phase === "cache" ? "Loading model…"
        : m.phase === "load" ? "Preparing model…"
        : m.total ? `Downloading model ${Math.round((m.loaded / m.total) * 100)}% · ${mb(m.total)} MB` : `Downloading model ${mb(m.loaded)} MB`;
      setStatus("loading", text);
    } else if (m.type === "ready") {
      state.ready = true;
      setStatus("ready", "Ready · runs on your device", `Model loaded in ${m.load_seconds}s. Images never leave this browser.`);
      updateRun();
      if (state.file && !state.result) run();
    } else if (m.type === "error") {
      setStatus("error", "Model failed to load", m.error);
      toast(m.error, true);
    } else if (m.type === "result") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m);
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

function bitmapToRgb(bmp) {
  const s = Math.min(1, MAX_INPUT / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const g = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  const rgba = g.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  return { rgb: rgb.buffer, width: w, height: h };
}

// ---------- settings ----------
function settings() {
  return {
    language: $("#language").value,
    mask_format: $("#mask_format").value,
    conf: clamp($("#conf").value, 0, 1),
    text_conf: clamp($("#text_conf").value, 0, 1),
    max_objects: clamp($("#max_objects").value, 1, 64) | 0,
    max_text_lines: clamp($("#max_text_lines").value, 1, 64) | 0,
    max_tokens: clamp($("#max_tokens").value, 64, 1536) | 0,
    nms: $("#nms").checked,
  };
}

function buildSettings() {
  $("#language").innerHTML = Object.entries(LANGUAGE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  $("#mask_format").innerHTML = Object.entries(MASK_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  $("#sections").innerHTML = Object.keys(SECTION_LABELS).map((s) => `<button type="button" class="chip" data-section="${s}" aria-pressed="${state.sections.has(s)}">${SECTION_LABELS[s]}</button>`).join("");
  $$("#sections .chip").forEach((c) => c.addEventListener("click", () => {
    const s = c.dataset.section;
    if (state.sections.has(s)) {
      if (state.sections.size === 1) return toast("Keep at least one section");
      state.sections.delete(s);
    } else state.sections.add(s);
    c.setAttribute("aria-pressed", state.sections.has(s));
  }));
  ["conf", "text_conf", "max_objects", "max_text_lines", "max_tokens"].forEach((id) => {
    const input = $(`#${id}`), out = $(`#${id}-out`);
    const sync = () => (out.textContent = input.step.includes(".") ? Number(input.value).toFixed(2) : input.value);
    input.addEventListener("input", sync);
    sync();
  });
}

// ---------- tasks UI ----------
function buildTasks() {
  for (const [id, t] of Object.entries(TASKS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "task";
    b.dataset.task = id;
    b.setAttribute("aria-pressed", id === state.task);
    b.innerHTML = `<span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg></span><b>${t.title}</b><small>${t.desc}</small>`;
    b.addEventListener("click", () => selectTask(id));
    $(`.tasks[data-group="${t.group}"]`).append(b);
  }
}

function selectTask(id) {
  state.task = id;
  $$(".task").forEach((b) => b.setAttribute("aria-pressed", b.dataset.task === id));
  $("#custom").hidden = id !== "custom";
  const cached = state.cache.get(cacheKey());
  if (cached) {
    state.result = cached;
    state.hot = null;
    renderAll();
  } else {
    state.result = null;
    renderAll();
    if (id !== "custom") run();
  }
}

// ---------- custom form builder ----------
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
    const name = f.name.trim().replace(/\s+/g, "_");
    if (!name) continue;
    if (f.type === "enum") {
      const choices = String(f.choices).split(",").map((c) => c.trim()).filter(Boolean);
      if (choices.length) out[name] = { enum: choices };
    } else if (f.type === "integer") {
      const lo = Number(f.min) || 0, hi = Number(f.max) || 0;
      out[name] = { type: "integer", minimum: Math.min(lo, hi), maximum: Math.max(lo, hi) };
    } else out[name] = { type: "string" };
  }
  return out;
}

function renderFields() {
  const box = $("#fields");
  box.innerHTML = state.fields.map((f, i) => `
    <div class="form-field" data-i="${i}">
      <div class="top-row">
        <input type="text" data-k="name" value="${esc(f.name)}" placeholder="Question, e.g. gloves" aria-label="Question name">
        <select data-k="type" aria-label="Answer type">
          <option value="enum" ${f.type === "enum" ? "selected" : ""}>Choice</option>
          <option value="integer" ${f.type === "integer" ? "selected" : ""}>Number</option>
          <option value="string" ${f.type === "string" ? "selected" : ""}>Text</option>
        </select>
        <button type="button" class="icon-btn" data-remove aria-label="Remove question">×</button>
      </div>
      ${f.type === "enum" ? `<input type="text" data-k="choices" value="${esc(f.choices)}" placeholder="present, absent" aria-label="Choices, comma separated">` : ""}
      ${f.type === "integer" ? `<div class="range"><input type="number" data-k="min" value="${esc(f.min)}" aria-label="Minimum"><input type="number" data-k="max" value="${esc(f.max)}" aria-label="Maximum"></div>` : ""}
    </div>`).join("");
  $$(".form-field", box).forEach((row) => {
    const i = Number(row.dataset.i);
    $$("[data-k]", row).forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      const k = el.dataset.k;
      state.fields[i][k] = el.value;
      if (k === "type") {
        Object.assign(state.fields[i], el.value === "enum" ? { choices: state.fields[i].choices || "present, absent" } : el.value === "integer" ? { min: 0, max: 10 } : {});
        renderFields();
      }
      syncFormJson();
    }));
    $("[data-remove]", row).addEventListener("click", () => { state.fields.splice(i, 1); renderFields(); syncFormJson(); });
  });
}

function syncFormJson() { $("#form-json").value = JSON.stringify(fieldsToSchema(), null, 2); updateRun(); }
function loadSchema(schema) { state.fields = schemaToFields(schema); renderFields(); syncFormJson(); }

function buildCustom() {
  const names = { category: "Category", crime: "Crime scene", mugshot: "Mug shot", plate: "Car plate", kitchen: "Kitchen" };
  $("#start-from").innerHTML += Object.entries(names).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  $("#start-from").addEventListener("change", (e) => { if (FORMS[e.target.value]) loadSchema(FORMS[e.target.value]); e.target.value = ""; });
  $("#add-field").addEventListener("click", () => {
    state.fields.push({ name: "", type: "enum", choices: "present, absent" });
    renderFields(); syncFormJson();
    $("#fields .form-field:last-child input")?.focus();
  });
  $("#form-json").addEventListener("input", (e) => {
    try {
      const parsed = JSON.parse(e.target.value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { state.fields = schemaToFields(parsed); renderFields(); }
    } catch { /* still typing */ }
  });
  loadSchema({ gloves: yesNo, knife: yesNo });
}

// ---------- image input ----------
async function setImage(blob, sampleName = null) {
  if (!blob || !String(blob.type).startsWith("image/")) return toast("That file isn't an image", true);
  const token = ++state.imageToken;
  state.file = null;
  updateRun();
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    if (token !== state.imageToken) return;
    state.file = blob;
    state.bitmap = bmp;
    state.sampleName = sampleName;
    state.result = null;
    state.hot = null;
    state.cache.clear();
    $$(".samples button").forEach((b) => b.classList.toggle("active", b.dataset.name === sampleName));
    $("#empty").hidden = true;
    renderAll();
    if (state.ready && state.task !== "custom") run();
  } catch {
    toast("Couldn't read that image. Try a JPEG or PNG.", true);
  }
}

function bindInput() {
  $$("[data-file]").forEach((inp) => inp.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) setImage(f); e.target.value = ""; }));
  const wrap = $("#canvas-wrap"), over = $("#dropping");
  let depth = 0;
  wrap.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; over.hidden = false; });
  wrap.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; over.hidden = true; } });
  wrap.addEventListener("dragover", (e) => e.preventDefault());
  wrap.addEventListener("drop", (e) => { e.preventDefault(); depth = 0; over.hidden = true; const f = e.dataTransfer.files[0]; if (f) setImage(f); });
  window.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) setImage(item.getAsFile());
  });
}

function buildSamples() {
  const box = $("#samples");
  box.innerHTML = SAMPLES.map((s) => `<button type="button" data-name="${esc(s.name)}" title="Sample: ${esc(human(s.name.replace(/\.\w+$/, "")))}"><img src="${esc(s.url)}" alt="" loading="lazy"></button>`).join("");
  $$("button", box).forEach((b, i) => b.addEventListener("click", async () => {
    state.file = null;
    updateRun();
    const blob = await (await fetch(SAMPLES[i].url)).blob();
    setImage(blob, SAMPLES[i].name);
  }));
}

// ---------- run ----------
function cacheKey() {
  const extra = state.task === "custom" ? JSON.stringify(fieldsToSchema()) : state.task === "overview" ? [...state.sections].join() : "";
  return `${state.imageToken}|${state.task}|${extra}|${JSON.stringify(settings())}`;
}

async function run() {
  if (!state.ready || !state.file) return;
  if (state.busy) { state.queued = true; return; }
  const task = state.task;
  const calls = TASKS[task].calls(state);
  if (task === "custom" && !Object.keys(calls[0].extract).length) return toast("Add at least one complete question", true);

  const s = settings();
  const token = state.imageToken;
  const key = cacheKey();
  const out = { task, describe: null, form: null, elapsed_ms: 0, steps: calls.length };
  setBusy(true, calls.length > 1 ? "Analyzing · step 1 of 2" : "Analyzing…");
  try {
    for (let i = 0; i < calls.length; i++) {
      if (calls.length > 1) $("#busy-text").textContent = `Analyzing · step ${i + 1} of ${calls.length}`;
      const c = calls[i];
      const options = c.extract
        ? { form: c.extract, conf: s.conf, text_conf: s.text_conf }
        : { sections: c.describe.sections, mask_format: s.mask_format, conf: s.conf, text_conf: s.text_conf, max_objects: s.max_objects, max_text_lines: s.max_text_lines, max_tokens: s.max_tokens, nms: s.nms };
      const res = await callEngine({ ...bitmapToRgb(state.bitmap), options, language: s.language === "auto" ? null : s.language });
      out.elapsed_ms += res.elapsed_ms;
      if (c.extract) out.form = res.result?.form || {};
      else out.describe = res.result || {};
      out.done = i + 1;
      if (token !== state.imageToken || task !== state.task) break;
    }
    if (token === state.imageToken && out.done === calls.length) state.cache.set(key, out);
    if (token === state.imageToken && task === state.task) {
      state.result = out;
      state.hot = null;
      renderAll();
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(false);
    if (state.queued) {
      state.queued = false;
      if (!state.cache.has(cacheKey())) run();
    }
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

const objects = () => state.result?.describe?.objects || [];
const textLines = () => state.result?.describe?.text || [];

function draw() {
  const bmp = state.bitmap;
  if (!bmp) return;
  const scale = Math.min(1, MAX_CANVAS / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * scale), H = Math.round(bmp.height * scale);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bmp, 0, 0, W, H);
  if (!state.result?.describe) return;

  const sx = W / 1000, sy = H / 1000;
  const lw = Math.max(2, Math.round(Math.max(W, H) / 320));
  const fontPx = Math.max(12, Math.round(Math.max(W, H) / 54));
  const objs = objects();
  const hot = state.hot;
  const dim = (i) => hot !== null && hot !== i;

  if (hot !== null) { ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.fillRect(0, 0, W, H); }

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
      ctx.globalAlpha = dim(i) ? 0.06 : hot === i ? 0.45 : 0.28;
      ctx.fillStyle = colorFor(i);
      ctx.fill("evenodd");
      ctx.globalAlpha = dim(i) ? 0.12 : 0.95;
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
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(lx, ly, tw, th, Math.round(fontPx * 0.25)) : ctx.rect(lx, ly, tw, th);
    ctx.fill();
    ctx.fillStyle = "#111";
    ctx.textBaseline = "middle";
    ctx.fillText(text, lx + pad, ly + th / 2);
    ctx.globalAlpha = 1;
  };

  objs.forEach((o, i) => {
    if (!Array.isArray(o.bbox) || o.bbox.length < 4) return;
    const [x0, y0, x1, y1] = o.bbox;
    const a = dim(i) ? 0.18 : 1;
    if (state.layers.boxes) {
      ctx.globalAlpha = a;
      ctx.lineWidth = hot === i ? lw * 1.6 : lw;
      ctx.strokeStyle = colorFor(i);
      ctx.strokeRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
      ctx.globalAlpha = 1;
    }
    if (state.layers.labels) label(`${o.name} ${fmt(o.score)}`, x0 * sx, y0 * sy, colorFor(i), a);
  });

  if (state.layers.text) {
    for (const t of textLines()) {
      if (!Array.isArray(t.bbox) || t.bbox.length < 4) continue;
      const [x0, y0, x1, y1] = t.bbox;
      const plate = looksLikePlate(t.string);
      const color = plate ? PLATE_COLOR : OCR_COLOR;
      const a = hot !== null ? 0.3 : 1;
      ctx.globalAlpha = a;
      ctx.lineWidth = Math.max(1.5, lw * (plate ? 0.9 : 0.6));
      ctx.strokeStyle = color;
      ctx.strokeRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
      ctx.globalAlpha = 1;
      if (state.layers.labels) label(t.string, x0 * sx, y1 * sy + fontPx * 1.6, color, a * 0.95);
    }
  }
}

function setHot(i) {
  if (state.hot === i) return;
  state.hot = i;
  $$(".obj").forEach((el) => el.classList.toggle("hot", Number(el.dataset.i) === i));
  draw();
}

function bindCanvas() {
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
  $$("#layers input").forEach((i) => i.addEventListener("change", () => { state.layers[i.dataset.layer] = i.checked; draw(); }));
}

// ---------- results ----------
function confidence(p) {
  if (typeof p !== "number") return { cls: "low", text: "Unsure" };
  if (p >= 0.7) return { cls: "high", text: "High" };
  if (p >= 0.4) return { cls: "mid", text: "Medium" };
  return { cls: "low", text: "Low" };
}

// Normalize one form field: answer, its confidence, and the best real choice when Mirage declines.
function readField(f) {
  const probs = f?.probabilities ? Object.entries(f.probabilities).sort((a, b) => b[1] - a[1]) : [];
  if (!isNone(f?.value)) {
    const p = f.probabilities ? f.probabilities[String(f.value)] : f.probability;
    return { answer: String(f.value), p, declined: false, probs };
  }
  const lean = probs.find(([k]) => k !== "-");
  return { answer: lean ? lean[0] : null, p: lean ? lean[1] : null, declined: true, probs };
}

const probBars = (probs) => probs.slice(0, 6).map(([k, p], j) =>
  `<div class="prob ${j === 0 ? "top" : ""}"><span title="${esc(k)}">${k === "-" ? "no clear match" : esc(human(k))}</span><span class="track"><i style="width:${Math.max(2, p * 100)}%"></i></span><span class="pct">${pct(p)}</span></div>`).join("");

function formHtml(form, task) {
  const entries = Object.entries(form || {});
  if (!entries.length) return "";
  const fields = entries.map(([name, f]) => ({ name, ...readField(f) }));
  const declined = fields.filter((f) => f.declined).length;
  const notice = declined === fields.length
    ? `<p class="notice">Mirage couldn't decide on this photo, so the answers below are its best guesses (low confidence). It works best on clear, close, well-lit photos.</p>`
    : "";

  if (task === "category") {
    const f = fields[0];
    const c = f.declined ? { cls: "low", text: "Best guess" } : confidence(f.p);
    return `${notice}<div class="answer"><div class="q">This photo looks like</div>
      <div class="a ${f.answer ? "" : "none"}">${f.answer ? esc(human(f.answer)) : "Can't tell"} <span class="badge ${c.cls}">${c.text}${f.p != null ? ` · ${pct(f.p)}` : ""}</span></div>
      ${f.declined ? `<div class="note">Mirage declined to choose (${pct(f.probs.find(([k]) => k === "-")?.[1])} no clear match).</div>` : ""}
      <div class="probs" style="margin-top:12px;display:grid;gap:5px">${probBars(f.probs)}</div></div>`;
  }

  return `${notice}<div><h3 class="section-title">Checklist <span class="count">${fields.length}</span></h3><ul class="checklist">${fields.map((f) => {
    const c = f.declined ? { cls: "low", text: "Guess" } : confidence(f.p);
    const val = f.answer == null ? `<span class="fval none">No answer</span>`
      : `<span class="fval ${f.declined ? "none" : ""}">${f.declined ? `<span class="lean-tag">maybe </span>` : ""}${esc(human(f.answer))}</span>`;
    return `<li><details><summary><span class="fname">${esc(cap(f.name))}</span>${val}<span class="badge ${c.cls}">${c.text}</span></summary>
      <div class="probs">${f.probs.length ? probBars(f.probs) : `<div class="prob top"><span>confidence</span><span class="track"><i style="width:${(f.p || 0) * 100}%"></i></span><span class="pct">${pct(f.p)}</span></div>`}</div></details></li>`;
  }).join("")}</ul></div>`;
}

function describeHtml(r, task) {
  if (!r) return "";
  const parts = [];
  const objs = r.objects || [];
  const lines = r.text || [];
  const nameById = new Map();
  objs.forEach((o, i) => { if (o.id != null && !nameById.has(o.id)) nameById.set(o.id, { name: o.name, i }); });
  const tag = (id) => {
    const hit = nameById.get(id);
    return hit ? `<span class="tagc"><i style="background:${colorFor(hit.i)}"></i>${esc(hit.name)}</span>` : `<span class="tagc" title="Below the sensitivity threshold">object #${esc(id)}</span>`;
  };

  // For plate / text-first tasks, text goes on top.
  const textFirst = task === "plate" || task === "text";
  const textBlock = () => {
    if (!("text" in r)) return "";
    const sorted = textFirst ? [...lines].sort((a, b) => looksLikePlate(b.string) - looksLikePlate(a.string)) : lines;
    const plates = lines.filter((t) => looksLikePlate(t.string)).length;
    const title = task === "plate" ? "Plate text" : "Text";
    const empty = task === "plate" ? "No readable plate text. Plates need to be large and sharp in the photo; try a closer crop." : "No text found.";
    return `<div><h3 class="section-title">${title} <span class="count">${lines.length}${plates && task !== "text" ? ` · ${plates} plate-like` : ""}</span></h3>${lines.length
      ? `<div class="list" style="gap:6px">${sorted.map((t) => {
        const plate = looksLikePlate(t.string) && (task === "plate" || task === "text");
        return `<div class="ocr ${plate ? "plate" : ""}"><span>${plate ? `<span class="tag">Plate?</span>` : ""}<q>${esc(t.string)}</q></span><span class="score">${fmt(t.score)}</span></div>`;
      }).join("")}</div>`
      : `<p class="placeholder">${empty}</p>`}</div>`;
  };

  if (textFirst) parts.push(textBlock());
  if (r.scene && Object.keys(r.scene).length) {
    parts.push(`<div><h3 class="section-title">Scene</h3><div class="kv">${Object.entries(r.scene).map(([k, v]) => `<span><b>${esc(human(k))}</b>${esc(v)}</span>`).join("")}</div></div>`);
  }
  if ("objects" in r) {
    parts.push(`<div><h3 class="section-title">Objects <span class="count">${objs.length}</span></h3>${objs.length ? `<ul class="list">${objs.map((o, i) => {
      const attrs = [o.position, ...Object.entries(o.description || {}).map(([k, v]) => `${human(k)}: ${v}`)].filter(Boolean);
      return `<li class="obj" data-i="${i}"><span class="sw" style="background:${colorFor(i)}"></span><span class="name">${esc(o.name)}</span><span class="score">${fmt(o.score)}</span>
        ${attrs.length ? `<span class="attrs">${attrs.map((a) => `<span>${esc(a)}</span>`).join("")}</span>` : ""}</li>`;
    }).join("")}</ul>` : `<p class="placeholder">Nothing detected above the sensitivity setting.</p>`}</div>`);
  }
  if (!textFirst) parts.push(textBlock());
  if ("relations" in r) {
    const rels = r.relations || [];
    parts.push(`<div><h3 class="section-title">Relations <span class="count">${rels.length}</span></h3>${rels.length ? rels.map((x) => x && typeof x === "object"
      ? `<div class="rel">${tag(x.subject)}<span class="pred">${esc(human(x.predicate))}</span>${tag(x.object)}</div>`
      : `<div class="raw">${esc(JSON.stringify(x))}</div>`).join("") : `<p class="placeholder">None found.</p>`}</div>`);
  }
  for (const key of ["regions", "events"]) {
    if (!(key in r)) continue;
    const items = r[key] || [];
    parts.push(`<div><h3 class="section-title">${SECTION_LABELS[key]} <span class="count">${items.length}</span></h3>${items.length ? items.map((x) => `<div class="raw">${esc(typeof x === "string" ? x : JSON.stringify(x))}</div>`).join("") : `<p class="placeholder">None found.</p>`}</div>`);
  }
  if (r.reasoning) {
    const steps = String(r.reasoning).split("|").map((s) => s.trim()).filter((s) => s && !/^lang:/i.test(s));
    parts.push(`<div><h3 class="section-title">Reasoning</h3><ol class="reason">${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>`);
  }
  return parts.join("");
}

// ---------- mug shot capture standards ----------
// Sources: NIST "Best Practice Recommendation for the Capture of Mugshots" / face-pose best practice
// (ANSI/NIST-ITL Type-10), and OSAC 2024-N-0007 on head coverings, accessories and make-up.
const NIST = "NIST mugshot best practice";
const OSAC = "OSAC 2024-N-0007";
// For each Mirage field: which answers pass, which only need checking, and the rule behind it.
const MUG_RULES = [
  { field: "pose", label: "Frontal pose", pass: ["frontal"], warn: ["half profile", "left profile", "right profile"], src: NIST, why: "A full-face frontal image must always be captured; profiles are taken in addition." },
  { field: "people_count", label: "One person only", pass: ["1"], src: NIST, why: "Composition is a single subject's head (and shoulders) on a plain background." },
  { field: "expression", label: "Neutral expression", pass: ["neutral"], src: NIST, why: "Neutral, non-smiling; a closed-mouth smile is not recommended." },
  { field: "eyes", label: "Eyes open", pass: ["open"], src: NIST, why: "Both eyes open normally; iris and pupil clearly visible." },
  { field: "mouth", label: "Mouth closed", pass: ["closed"], src: NIST, why: "Mouth closed." },
  { field: "eyeglasses", label: "No glare on glasses", pass: ["none", "glasses"], src: NIST, why: "Glasses may be worn; with significant glare, take a second frontal without them." },
  { field: "head_covering", label: "No head covering", pass: ["absent"], warn: ["present"], src: OSAC, why: "A primary mugshot is captured without head coverings, accessories or make-up; accommodations may apply." },
  { field: "ears_visible", label: "Ears visible", pass: ["yes"], warn: ["no"], src: NIST, why: "Ears visible; hair pushed back or tied when appropriate." },
  { field: "background", label: "Plain gray background", pass: ["plain gray"], warn: ["plain white", "plain other color"], src: NIST, why: "Plain, smooth 18% gray background; head-to-background boundary clear." },
  { field: "background_shadow", label: "No background shadow", pass: ["absent"], src: NIST, why: "No shadows on the background behind the face." },
  { field: "face_lighting", label: "Even face lighting", pass: ["even"], src: NIST, why: "Light equally distributed; no dark eye sockets, no hot spots on cheeks or forehead." },
  { field: "sharpness", label: "In focus", pass: ["sharp"], src: NIST, why: "Face in focus from the nose to the ears." },
  { field: "composition", label: "Head (and shoulders) framing", pass: ["head only", "head and shoulders"], warn: ["upper body"], src: NIST, why: "Head-only or head-and-shoulders composition." },
];

// Pixel measurements done locally on the image (no model involved).
function measureImage(bmp) {
  const s = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
  const w = Math.max(8, Math.round(bmp.width * s)), h = Math.max(8, Math.round(bmp.height * s));
  const g = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const patch = (x0, y0, pw, ph) => {
    let r = 0, gg = 0, b = 0, n = 0;
    for (let y = y0; y < y0 + ph; y++) for (let x = x0; x < x0 + pw; x++) {
      const i = (y * w + x) * 4; r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++;
    }
    return [r / n, gg / n, b / n];
  };
  let chroma = 0, n = 0;
  for (let i = 0; i < px.length; i += 16) { chroma += Math.abs(px[i] - px[i + 1]) + Math.abs(px[i + 1] - px[i + 2]); n++; }
  const pw = Math.max(2, Math.round(w * 0.1)), ph = Math.max(2, Math.round(h * 0.1));
  const ix = Math.round(w * 0.02), iy = Math.round(h * 0.02);
  return { width: bmp.width, height: bmp.height, chroma: chroma / n, corners: [patch(ix, iy, pw, ph), patch(w - ix - pw, iy, pw, ph)] };
}

function mugshotChecks(r) {
  const m = measureImage(state.bitmap);
  const rows = [];
  const add = (label, status, detail, src, why) => rows.push({ label, status, detail, src, why });

  // Measured
  const ratio = m.width / m.height;
  add("3:4 aspect ratio", Math.abs(ratio - 0.75) <= 0.03 ? "pass" : "fail", `${m.width}×${m.height} is ${ratio.toFixed(2)}:1, expected 0.75:1 (3:4)`, NIST, "Width:height of the captured image is 3:4, e.g. 600×800 or 768×1024.");
  add("Resolution", m.width >= 600 && m.height >= 800 ? "pass" : m.width >= 480 && m.height >= 600 ? "warn" : "fail", `${m.width}×${m.height}, recommended at least 600×800`, NIST, "Common capture sizes are 600×800 and 768×1024; no digital zoom.");
  add("Color image", m.chroma > 3 ? "pass" : "fail", m.chroma > 3 ? "Color" : "Looks grayscale", NIST, "Captured facial images are in color (24-bit RGB).");
  const bg = m.corners.map(([R, G, B]) => {
    const neutral = Math.max(R, G, B) - Math.min(R, G, B) <= 10;
    const inRange = [R, G, B].every((v) => v >= 95 && v <= 135);
    return { neutral, inRange, mean: Math.round((R + G + B) / 3) };
  });
  const bgStatus = bg.every((c) => c.neutral && c.inRange) ? "pass" : bg.every((c) => c.neutral) ? "warn" : "fail";
  add("18% gray background (measured)", bgStatus,
    `Top corners average ${bg.map((c) => c.mean).join(" and ")} of 255; target ~115 (105–125), gray with channels within 10${bgStatus === "warn" ? "; neutral but too light or dark" : bgStatus === "fail" ? "; not a neutral gray" : ""}`,
    NIST, "Background is 18% gray: RGB means 105–125 and channels within 10 of each other.");

  // Head size and centering from Mirage's face/person box
  const objs = r.describe?.objects || [];
  const face = objs.find((o) => /\b(face|head)\b/i.test(o.name)) || objs.find((o) => /\b(person|man|woman|boy|girl|human)\b/i.test(o.name));
  if (face?.bbox) {
    const [x0, , x1] = face.bbox;
    const off = Math.abs((x0 + x1) / 2 - 500) / 10;
    add("Head centered", off <= 5 ? "pass" : off <= 10 ? "warn" : "fail", `${/face|head/i.test(face.name) ? "Face" : "Person"} box is ${off.toFixed(0)}% off center`, NIST, "Nose bridge and mouth midpoints on the image's vertical center line.");
    if (/face|head/i.test(face.name)) {
      const wpct = (x1 - x0) / 10;
      add("Head size", wpct >= 40 && wpct <= 80 ? "pass" : "warn", `Head is ${wpct.toFixed(0)}% of image width; ~50% head-and-shoulders, ~70% head-only`, NIST, "Head width about 50% (head and shoulders) or 70% (head only) of the image width.");
    }
  } else {
    add("Head centered", "unclear", "No face or person box detected", NIST, "Nose bridge and mouth midpoints on the image's vertical center line.");
  }

  // Judged by Mirage. Its answers are often wrong on fine facial detail, so they never produce a
  // hard Fail: anything that doesn't pass becomes "Check" for a person to confirm.
  const seen = JSON.stringify(objs).toLowerCase();
  for (const rule of MUG_RULES) {
    const f = readField(r.form?.[rule.field]);
    if (!f || f.answer == null || f.declined || (typeof f.p === "number" && f.p < 0.4)) {
      add(rule.label, "unclear", f?.answer ? `Mirage unsure (maybe ${human(f.answer)})` : "Mirage unsure", rule.src, rule.why);
      continue;
    }
    const a = String(f.answer);
    // Cross-check: glasses claimed but the object pass saw none → don't raise a false alarm.
    if (rule.field === "eyeglasses" && a !== "none" && !/glass|spectacle/.test(seen)) {
      add(rule.label, "unclear", `Mirage's passes disagree: form says ${human(a)}, objects show no glasses`, rule.src, rule.why);
      continue;
    }
    add(rule.label, rule.pass.includes(a) ? "pass" : "warn", `Mirage: ${human(a)} (${pct(f.p)})`, rule.src, rule.why);
  }

  // Notes that are documentation, not pass/fail
  const notes = [];
  const tat = readField(r.form?.visible_tattoos);
  if (tat && !tat.declined && tat.answer === "present") notes.push("Visible tattoos or marks: photograph and record scars, marks and tattoos (SMT) separately.");
  const plac = readField(r.form?.placard);
  if (plac && !plac.declined && plac.answer === "present") notes.push("A placard or name board is in frame; it is not part of the NIST image specification.");
  return { rows, notes };
}

function mugshotHtml(r) {
  const { rows, notes } = mugshotChecks(r);
  const n = (s) => rows.filter((x) => x.status === s).length;
  const label = { pass: "Pass", warn: "Check", fail: "Fail", unclear: "Unclear" };
  const cls = { pass: "high", warn: "mid", fail: "fail", unclear: "low" };
  const verdict = n("fail") ? { t: "Does not meet the standard", c: "fail" } : n("warn") || n("unclear") ? { t: "Needs review", c: "mid" } : { t: "Meets the checked rules", c: "high" };
  return `<div class="answer"><div class="q">Booking photo capture check</div>
      <div class="a" style="text-transform:none;font-size:20px">${verdict.t} <span class="badge ${verdict.c}">${n("pass")} of ${rows.length} pass</span></div>
      <div class="note">${n("fail")} fail · ${n("warn")} to check · ${n("unclear")} unclear. Only measured rules (size, ratio, color, background) can fail; Mirage's judgments are a first pass for a person to confirm.</div></div>
    ${notes.length ? notes.map((t) => `<p class="notice">${esc(t)}</p>`).join("") : ""}
    <div><h3 class="section-title">Capture standards <span class="count">${rows.length}</span></h3><ul class="checklist std">${rows.map((x) => `
      <li><details><summary><span class="sname">${esc(x.label)}</span><span class="badge ${cls[x.status]}">${label[x.status]}</span><span class="sdetail">${esc(x.detail)}</span></summary>
      <div class="probs"><div class="rule">${esc(x.why)} <span class="src">${esc(x.src)}</span></div></div></details></li>`).join("")}</ul></div>`;
}

// Task-specific answer pulled from the text pass (OCR), shown above the checklist.
function headlineHtml(r) {
  if (r.task === "mugshot" && r.form) return mugshotHtml(r);
  const lines = r.describe?.text || [];
  if (r.task === "plate") {
    const plates = lines.filter((t) => looksLikePlate(t.string)).sort((a, b) => (b.score || 0) - (a.score || 0));
    const best = plates[0];
    if (!best) {
      return `<div class="answer"><div class="q">Plate number</div><div class="a none">Not read</div>
        <div class="note">No plate-like text found. Plates need to be large and sharp; try a closer crop of the plate.</div></div>`;
    }
    const c = confidence(best.score);
    return `<div class="answer"><div class="q">Plate number</div>
      <div class="a" style="font-family:var(--mono);text-transform:none;letter-spacing:.04em">${esc(best.string)} <span class="badge ${c.cls}">${c.text} · ${pct(best.score)}</span></div>
      ${plates.length > 1 ? `<div class="note">Other candidates: ${plates.slice(1, 4).map((t) => esc(t.string)).join(", ")}</div>` : ""}
      <div class="note">Read by OCR; check it against the photo before relying on it.</div></div>`;
  }
  if (r.task === "crime") {
    const nums = [...new Set(lines.map((t) => String(t.string).trim()).filter((s) => /^\d{1,3}$/.test(s)))].sort((a, b) => a - b);
    if (!nums.length) return "";
    return `<div class="answer"><div class="q">Evidence marker numbers read</div>
      <div class="a" style="font-family:var(--mono);font-size:20px">${nums.map(esc).join(" · ")}</div>
      <div class="note">${nums.length} marker${nums.length === 1 ? "" : "s"} read by OCR; small or angled markers can be missed.</div></div>`;
  }
  return "";
}

function renderResults() {
  const view = $("#view-summary");
  const t = TASKS[state.task];
  $("#results-title").textContent = t.title;
  const r = state.result;
  $("#results-sub").textContent = r ? `${(r.elapsed_ms / 1000).toFixed(1)} s on this device${r.steps > 1 ? ` · ${r.steps} passes` : ""}` : "";
  $("#json").textContent = r ? JSON.stringify({ describe: r.describe, form: r.form }, (k, v) => (v === null ? undefined : v), 2) : "";

  if (!r) {
    view.innerHTML = !state.file
      ? `<p class="placeholder">Choose a photo to start. ${state.ready ? "" : "The model is loading; the first visit downloads about 22 MB."}</p>`
      : state.task === "custom" ? `<p class="placeholder">Write your questions above, then press Analyze.</p>`
      : `<p class="placeholder">${state.busy ? "Analyzing…" : state.ready ? "Press Analyze to run this task." : "Waiting for the model to load…"}</p>`;
    return;
  }
  // Mug shot shows the standards table instead of the raw checklist; raw answers stay in JSON.
  const body = r.task === "mugshot"
    ? headlineHtml(r) + describeHtml(r.describe, r.task)
    : headlineHtml(r) + formHtml(r.form, r.task) + describeHtml(r.describe, r.task);
  view.innerHTML = body || `<p class="placeholder">Mirage returned nothing for this task.</p>`;
  $$(".obj", view).forEach((el) => {
    el.addEventListener("mouseenter", () => setHot(Number(el.dataset.i)));
    el.addEventListener("mouseleave", () => setHot(null));
  });
}

function renderAll() {
  const b = state.bitmap;
  const r = state.result;
  $("#meta").textContent = b ? `${b.width}×${b.height}${r ? ` · ${(r.elapsed_ms / 1000).toFixed(1)} s` : ""}` : "";
  renderResults();
  draw();
  updateRun();
}

// ---------- misc bindings ----------
function bindViews() {
  $$(".seg button").forEach((t) => t.addEventListener("click", () => {
    state.view = t.dataset.view;
    $$(".seg button").forEach((x) => x.classList.toggle("active", x === t));
    $("#view-summary").hidden = state.view !== "summary";
    $("#view-json").hidden = state.view !== "json";
  }));
  $("#copy-json").addEventListener("click", async () => {
    if (!state.result) return toast("Nothing to copy yet");
    try { await navigator.clipboard.writeText($("#json").textContent); toast("Copied"); } catch { toast("Couldn't copy", true); }
  });
  $("#download-json").addEventListener("click", () => {
    if (!state.result) return toast("Nothing to download yet");
    const blob = new Blob([$("#json").textContent], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `mirage-${state.result.task}-${Date.now()}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#run").addEventListener("click", () => { state.cache.delete(cacheKey()); run(); });
  window.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); $("#run").click(); } });
}

// ---------- boot ----------
buildSettings();
buildTasks();
buildCustom();
buildSamples();
bindInput();
bindCanvas();
bindViews();
renderAll();
startEngine();
