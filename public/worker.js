// Runs Mirage in the browser: Cactus WebAssembly engine + mirage.cact weights.
// Everything stays on the visitor's device; the page talks to this worker by postMessage.

importScripts("./vendor/cactus/cactus.js");

// Pinned to the same revision cactus-compute 4.2.6 uses with engine 4.1.4
// (sha256 4249a0f7…f9f237). Served from this site; Hugging Face is the fallback
// for local copies that don't include public/models/.
const WEIGHTS_URL = new URL("./models/mirage.cact", self.location.href).href;
const FALLBACK_URL = "https://huggingface.co/Cactus-Compute/mirage/resolve/76c1e9e53381aca8fc3843c636216c96ff220122/mirage.cact";
const CACHE_NAME = "mirage-weights-76c1e9e";
const OUT_CAP = 16 * 1024 * 1024;
const VISION = 4;

let M = null;
let outPtr = 0;

const post = (msg) => self.postMessage(msg);

async function fetchWeights() {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(WEIGHTS_URL);
    if (hit) {
      post({ type: "progress", phase: "cache" });
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch { cache = null; } // Cache Storage can be unavailable (private mode)

  let res = await fetch(WEIGHTS_URL).catch(() => null);
  if (!res?.ok || !res.body) {
    res = await fetch(FALLBACK_URL).catch((e) => { throw new Error(`Could not download the model: ${e.message}`); });
  }
  if (!res.ok || !res.body) throw new Error(`Could not download the model (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = Date.now();
    if (now - lastPost > 120) { post({ type: "progress", phase: "download", loaded, total }); lastPost = now; }
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  post({ type: "progress", phase: "download", loaded, total: total || loaded });
  if (cache) {
    try { await cache.put(WEIGHTS_URL, new Response(bytes, { headers: { "content-type": "application/octet-stream" } })); } catch { /* quota */ }
  }
  return bytes;
}

function lastError() {
  return M.UTF8ToString(M._cactus_last_error()) || "unknown engine error";
}

// The native engine can emit bare nan/inf in score fields; null them before parsing.
function parse(text) {
  try { return JSON.parse(text); } catch {
    return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|(-?nan|-?inf(?:inity)?)/gi, (m, bare) => (bare ? "null" : m)));
  }
}

async function init() {
  const started = performance.now();
  post({ type: "progress", phase: "engine" });
  // This Emscripten build resolves cactus.wasm next to the worker and ignores
  // locateFile, so hand it the binary directly.
  const wasm = await fetch("./vendor/cactus/cactus.wasm");
  if (!wasm.ok) throw new Error(`Could not load the engine (HTTP ${wasm.status})`);
  M = await createCactus({ wasmBinary: await wasm.arrayBuffer() });
  const weights = await fetchWeights();
  post({ type: "progress", phase: "load" });
  const p = M._malloc(weights.length);
  if (!p) throw new Error("Not enough memory to load the model");
  M.HEAPU8.set(weights, p);
  const rc = M._cactus_load(p, BigInt(weights.length)); // unsigned long long → i64 → BigInt
  M._free(p);
  if (rc < 0) throw new Error(lastError());
  if (!(M._cactus_models() & VISION)) throw new Error("Downloaded archive is not a Mirage vision model");
  outPtr = M._malloc(OUT_CAP);
  post({ type: "ready", load_seconds: Math.round((performance.now() - started) / 10) / 100 });
}

function describe({ rgb, width, height, options, language }) {
  const data = new Uint8Array(rgb);
  const rp = M._malloc(data.length);
  if (!rp) throw new Error("Not enough memory for this image");
  try {
    M.HEAPU8.set(data, rp);
    const started = performance.now();
    const code = M.ccall(
      "cactus_describe", "number",
      ["number", "number", "number", "string", "string", "string", "number", "number"],
      [rp, width, height, JSON.stringify(options), language || null, null, outPtr, OUT_CAP],
    );
    const elapsed_ms = Math.round(performance.now() - started);
    if (code < 0) throw new Error(lastError());
    return { result: parse(M.UTF8ToString(outPtr)), elapsed_ms };
  } finally {
    M._free(rp);
  }
}

const ready = init().catch((err) => {
  post({ type: "error", error: String(err?.message || err) });
  throw err;
});

self.onmessage = async ({ data }) => {
  const { id, payload } = data;
  try {
    await ready;
    post({ type: "result", id, ...describe(payload) });
  } catch (err) {
    post({ type: "result", id, error: String(err?.message || err) });
  }
};
