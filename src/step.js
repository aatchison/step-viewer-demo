// STEP loader core — parses STEP (ISO 10303) into three.js geometry via
// occt-import-js (OpenCascade compiled to WebAssembly).
//
// occt-import-js ships as a UMD/global factory (not an ES module). The parse
// (occt.ReadStepFile) runs in a classic Web Worker (src/step.worker.js) that
// `importScripts()` the same CDN script, so a dense CAD part decodes off the main
// thread and orbit/gizmo/UI never freeze. The worker is an OPTIMIZATION, not a
// hard dependency: if it can't init or crashes, this module transparently falls
// back to loading occt-import-js on the MAIN thread (the pre-worker path) and
// parsing there, so a model always loads. This module owns the worker lifecycle +
// message protocol, the main-thread fallback engine, and rebuilds the THREE
// geometry from the per-mesh typed arrays either engine produces.

import * as THREE from 'three';

const OCCT_VERSION = '0.0.23';
const OCCT_BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;

// occt-import-js already bundles readers for three CAD formats — the engine reads
// IGES and BREP "for free" alongside STEP. Map a normalized file extension to the
// occt reader method so one shared parse/mesh-build path serves all three; only
// the read call differs. All three return the same `{ success, meshes }` shape, so
// everything downstream (worker repack, buildGroup) is format-agnostic.
const READER_BY_EXT = {
  stp: 'ReadStepFile',
  step: 'ReadStepFile',
  igs: 'ReadIgesFile',
  iges: 'ReadIgesFile',
  brp: 'ReadBrepFile',
  brep: 'ReadBrepFile',
};

// The set of extensions the loader accepts, in canonical lower-case. Exported so
// the UI can build its <input accept>, drop-guard, and mismatch copy from the same
// source of truth this module dispatches on (no drift between guard and dispatch).
export const SUPPORTED_CAD_EXTENSIONS = Object.keys(READER_BY_EXT);

// Normalize a file name or bare extension to the occt reader method, or null when
// the extension isn't one occt reads. Accepts 'foo.IGES', '.iges', or 'iges'.
export function readerForExtension(nameOrExt) {
  const s = String(nameOrExt || '').toLowerCase();
  const dot = s.lastIndexOf('.');
  const ext = dot >= 0 ? s.slice(dot + 1) : s;
  return READER_BY_EXT[ext] || null;
}

// Cap for the text scan in detectStepLengthUnit: STEP is plain ISO-10303-21 text
// and the unit context is small, but a dense assembly's DATA section can be many
// MB of geometry we never need to look at. Decode at most this many bytes — the
// whole file when it's under the cap, otherwise a head+tail window (the unit
// context lives near the top with the other definitions, but the
// GEOMETRIC_REPRESENTATION_CONTEXT that references it can trail at the end), so
// the scan stays bounded and cheap regardless of file size.
const UNIT_SCAN_CAP = 4 * 1024 * 1024;

// Decode a STEP ArrayBuffer as text and extract its declared length unit, mapping
// to a short display symbol ('mm', 'm', 'cm', 'in', 'ft', 'mil') or null when it
// can't be determined. Pure, bounded, and NEVER throws — any decode/parse failure
// degrades to null so a detection miss can never block a render.
//
// STEP declares length as either an SI_UNIT — `SI_UNIT(.MILLI.,.METRE.)`,
// `SI_UNIT($,.METRE.)` (no prefix ⇒ metre), `SI_UNIT(.CENTI.,.METRE.)` — or a
// CONVERSION_BASED_UNIT naming a customary unit (`CONVERSION_BASED_UNIT('INCH',…)`).
// A customary file still declares metre as the SI base the conversion is defined
// against, so CONVERSION_BASED_UNIT names are checked FIRST — otherwise an inch
// part would be mislabelled 'm'. Non-length conversion units (DEGREE for angle,
// etc.) simply don't match the length-name map and are ignored.
export function detectStepLengthUnit(buffer) {
  try {
    let bytes;
    if (buffer instanceof ArrayBuffer) {
      bytes = new Uint8Array(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else {
      return null;
    }

    // Bound the decode: whole file when small, else a head+tail window.
    let text;
    const dec = new TextDecoder('utf-8', { fatal: false });
    if (bytes.length <= UNIT_SCAN_CAP) {
      text = dec.decode(bytes);
    } else {
      const half = UNIT_SCAN_CAP >> 1;
      const head = dec.decode(bytes.subarray(0, half));
      const tail = dec.decode(bytes.subarray(bytes.length - half));
      text = head + '\n' + tail;
    }

    // Customary (CONVERSION_BASED_UNIT) first — a customary STEP file also carries
    // an SI metre base unit, so SI matching alone would report metre for an inch
    // part. Scan every conversion-based unit's name and take the first that maps
    // to a length symbol; angle/other conversion units fall through unmatched.
    const CONV = {
      INCH: 'in', INCHES: 'in',
      FOOT: 'ft', FEET: 'ft',
      MIL: 'mil', THOU: 'mil',
    };
    const convRe = /CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'/gi;
    let m;
    while ((m = convRe.exec(text)) !== null) {
      const sym = CONV[m[1].trim().toUpperCase()];
      if (sym) return sym;
    }

    // SI length unit: the prefix slot is either $ (no prefix ⇒ metre) or a
    // .PREFIX. token; the unit token must be .METRE. (mass is .GRAM., plane angle
    // .RADIAN., etc. — matching METRE specifically isolates the length unit).
    const si = /SI_UNIT\s*\(\s*(\$|\.[A-Z]+\.)\s*,\s*\.METRE\.\s*\)/i.exec(text);
    if (si) {
      const prefix = si[1].toUpperCase();
      if (prefix === '$') return 'm';
      if (prefix === '.MILLI.') return 'mm';
      if (prefix === '.CENTI.') return 'cm';
      if (prefix === '.METRE.') return 'm'; // defensive; not a real prefix
      return null; // an unsupported SI prefix (MICRO/KILO/…) — don't fabricate
    }

    return null;
  } catch (e) {
    return null; // never let a detection failure block the render
  }
}

// Run a low-priority task off the first-paint critical path. Prefer
// requestIdleCallback so edge-line generation waits for an idle slot after the
// mesh is on screen; fall back to a macrotask where it isn't available.
const runWhenIdle =
  typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => setTimeout(fn, 0);

// The single reused parse worker and the promise that resolves once its WASM
// engine has initialized ('engine' phase, cached after the first load). Both are
// null until the first load lazily spawns the worker, and both are cleared by
// resetOcct() so Retry starts a genuinely fresh attempt.
let worker = null;
let workerReadyPromise = null;
let readyResolvers = null; // { resolve, reject } for the pending 'ready' handshake
let msgSeq = 0; // monotonic id so overlapping parses route to the right awaiter
const pending = new Map(); // id → { resolve, reject } for in-flight parse requests

// The worker is an OPTIMIZATION, not a hard dependency. The first time it fails to
// init (engine/CDN/WASM/worker construction) or crashes mid-parse, we flip this
// and route every subsequent parse straight to the main-thread engine below, so a
// broken/blocked worker never costs a repeated failure. Sticky for the session:
// once the worker has proven unusable, Retry keeps using the reliable main-thread
// path rather than re-failing through it.
let workerDisabled = false;

// Cached main-thread occt engine promise (the pre-worker fallback path). Null
// until the fallback first needs it; cleared by resetOcct() so Retry re-downloads.
let mainThreadOcctPromise = null;

// Route every worker message to the right awaiter. 'ready'/'init-error' settle the
// engine-init handshake; 'result'/'parse-error' settle the parse keyed by id.
function handleWorkerMessage(ev) {
  const msg = ev.data;
  switch (msg.type) {
    case 'ready':
      if (readyResolvers) {
        readyResolvers.resolve();
        readyResolvers = null;
      }
      break;
    case 'init-error': {
      const e = new Error(msg.message || 'Failed to load the 3D engine in the worker');
      e.kind = 'init';
      if (readyResolvers) {
        readyResolvers.reject(e);
        readyResolvers = null;
      }
      // The engine never came up — tear the worker down so a retry rebuilds it.
      teardownWorker(e);
      break;
    }
    case 'result': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        // Resolve with BOTH the per-mesh typed arrays and the (sanitized)
        // assembly hierarchy so buildGroup can recover per-part identity/names.
        p.resolve({ meshes: msg.meshes, root: msg.root || null });
      }
      break;
    }
    case 'parse-error': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        const e = new Error(msg.message || 'occt failed to parse the CAD data');
        e.kind = 'parse';
        p.reject(e);
      }
      break;
    }
    default:
      break;
  }
}

// A worker-level uncaught error (script failed to load, an uncatchable WASM
// abort, etc.) leaves the worker unusable — classify it as an engine/init failure
// so the UI shows the persistent Retry panel and rebuilds a fresh worker.
function handleWorkerError(ev) {
  const e = new Error((ev && ev.message) || 'STEP parse worker crashed');
  e.kind = 'init';
  if (readyResolvers) {
    readyResolvers.reject(e);
    readyResolvers = null;
  }
  teardownWorker(e);
}

// Terminate the worker (if any) and reject anything still in flight so nothing
// hangs forever. `err` is the failure that prompted the teardown; a plain
// resetOcct()/successful path passes none, and pending parses get a generic
// init-kind rejection.
function teardownWorker(err) {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerReadyPromise = null;
  readyResolvers = null;
  for (const p of pending.values()) {
    const e = err || new Error('STEP parse worker was terminated');
    if (!e.kind) e.kind = 'init';
    p.reject(e);
  }
  pending.clear();
}

// Lazily spawn the worker and initialize the WASM engine exactly once, returning
// a promise that resolves when the worker reports 'ready'. Cached across loads.
// A failure to construct the worker, or an engine/CDN/WASM init failure inside it,
// rejects with `kind: 'init'` and clears the cache so the next call retries.
function getWorkerReady() {
  if (!workerReadyPromise) {
    workerReadyPromise = new Promise((resolve, reject) => {
      try {
        // Classic worker (no { type: 'module' }) so it can importScripts() the
        // occt UMD build. Resolve the URL relative to this module so it works
        // regardless of where the app is served from.
        worker = new Worker(new URL('./step.worker.js', import.meta.url));
      } catch (err) {
        workerReadyPromise = null;
        const e = err instanceof Error ? err : new Error(String(err));
        e.kind = 'init';
        reject(e);
        return;
      }
      worker.onmessage = handleWorkerMessage;
      worker.onerror = handleWorkerError;
      readyResolvers = { resolve, reject };
      // Hand the CDN base in so OCCT_VERSION lives only here, not duplicated in
      // the worker; the worker importScripts + inits the engine on receipt.
      worker.postMessage({ type: 'init', base: OCCT_BASE });
    });
  }
  return workerReadyPromise;
}

// Send the STEP bytes to the worker and await the parsed result:
// `{ meshes, root }` — the per-mesh typed arrays plus the sanitized assembly
// hierarchy. Rejects with `kind: 'parse'` on bad bytes.
function postParse(arrayBuffer, reader) {
  return new Promise((resolve, reject) => {
    const id = ++msgSeq;
    pending.set(id, { resolve, reject });
    // Input is intentionally NOT transferred: the main thread keeps the buffer
    // intact so getMeshes() can re-parse on the main-thread fallback if the worker
    // crashes mid-parse. STEP input is text — small next to the decoded geometry —
    // so the structured-clone copy into the worker is cheap; the wins that matter
    // (off-thread ReadStepFile and the zero-copy RESULT transfer back) both stay.
    worker.postMessage({ type: 'parse', id, reader, buffer: arrayBuffer });
  });
}

// Ensures a STEP engine is up (idempotent): the parse worker + its WASM engine
// when possible, otherwise the main-thread engine. An engine/CDN/WASM/worker init
// failure in the worker (kind:'init') is NOT fatal — it disables the worker for
// the session and this resolves against the main-thread engine instead, so the
// engine is "up" wherever either path can load. It only rejects (kind:'init') if
// BOTH the worker and the main-thread download/init fail (e.g. truly offline).
export async function initOcct() {
  if (!workerDisabled) {
    try {
      return await getWorkerReady();
    } catch (err) {
      if (err && err.kind === 'parse') throw err; // can't happen on init; be safe
      disableWorker(); // engine/CDN/WASM/worker init failure — degrade to main thread
    }
  }
  return initOcctMainThread();
}

// Terminate the parse worker and discard the cached engine-ready promise so the
// next initOcct()/load spawns a fresh worker and re-inits the engine. Used by the
// UI's Retry after an engine/CDN load failure or a stall: getWorkerReady only
// self-clears on rejection, so a still-pending (hung) attempt would otherwise be
// re-awaited forever. Terminating here also kills any in-flight parse so a retry
// starts a genuinely new attempt.
export function resetOcct() {
  teardownWorker();
  // Also discard the cached main-thread engine so a Retry after a total (worker +
  // main-thread) failure re-downloads it fresh rather than re-awaiting a hung or
  // rejected promise.
  mainThreadOcctPromise = null;
  // workerDisabled stays sticky on purpose: if the worker already proved unusable
  // this session, Retry keeps using the reliable main-thread engine instead of
  // re-failing through the worker again.
}

// Parses a STEP file (as an ArrayBuffer / TypedArray) and returns a THREE.Group
// of Meshes. Throws on parse failure so callers can handle it.
//
// `onPhase` is an optional progress hook invoked with a stage tag so callers can
// surface staged first-load feedback: 'engine' just before the occt/WASM engine
// initializes (the ~10–15s first-load cost), then 'parse' just before the STEP
// bytes are decoded. It fires on every call, but engine init is cached after the
// first, so the 'engine' phase is effectively instantaneous on later loads.
// `edgeStyle` sets the deferred feature-edge overlay's stroke — { color, opacity }
// — so callers can render crisper/darker edges in a high-contrast theme. Defaults
// to the original faint line, so an omitted argument is byte-for-byte unchanged.
// `onEdgesReady` (optional) is invoked after each mesh's feature-edge overlay is
// built in its idle slot. The app uses it to request a redraw under its
// render-on-demand loop, which would otherwise be parked when the deferred edges
// finally attach a beat after first render (so the edges would only appear on the
// next camera move). No-op when omitted.
export async function loadCadFromArrayBuffer(buf, ext, onPhase, edgeStyle = { color: 0x0a0d12, opacity: 0.35 }, onEdgesReady) {
  if (onPhase) onPhase('engine');

  // Resolve the reader up front from the extension so an unknown format fails fast
  // (kind:'parse' — it's a bad-input problem, not an engine one) before the engine
  // is even touched. The UI guards on extension before calling in, so this is a
  // belt-and-suspenders check for a stray unsupported call.
  const reader = readerForExtension(ext);
  if (!reader) {
    const e = new Error(`Unsupported CAD file extension: ${ext}`);
    e.kind = 'parse';
    throw e;
  }

  // Normalize to a standalone ArrayBuffer once, up front — both the worker and the
  // main-thread fallback consume it, and it must be handed off without detaching a
  // buffer a view might share. Slice a TypedArray view to exactly its range so we
  // only ever look at these bytes.
  let arrayBuffer;
  if (buf instanceof ArrayBuffer) {
    arrayBuffer = buf;
  } else if (ArrayBuffer.isView(buf)) {
    arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } else {
    arrayBuffer = new Uint8Array(buf).buffer;
  }

  // Parse to per-mesh typed arrays + assembly hierarchy — off-thread via the
  // worker when it's healthy, otherwise on the main-thread engine. Both sources
  // yield the same `{ meshes, root }` shape.
  const { meshes, root } = await getMeshes(arrayBuffer, reader, onPhase);

  const group = buildGroup(meshes, root, edgeStyle, onEdgesReady);

  // Native length unit (issue #95): STEP declares its length unit as plain
  // ISO-10303-21 text, so decode + detect it here and stash the short symbol on
  // the group. Guarded by the reader so it runs ONLY for STEP — IGES/BREP carry
  // no reliable text length-unit field, so they report no unit rather than a
  // wrong one. Detection is bounded and never throws; a miss leaves `unit` unset,
  // which the UI reads as "unknown" and shows the current unitless dimensions.
  if (reader === 'ReadStepFile') {
    const unit = detectStepLengthUnit(arrayBuffer);
    if (unit) group.userData.unit = unit;
  }

  return group;
}

// Back-compat thin wrapper: the original STEP-only entry point, preserved so any
// caller (or bookmark) still works. Routes through the format-aware loader with the
// STEP reader.
export function loadStepFromArrayBuffer(buf, onPhase, edgeStyle = { color: 0x0a0d12, opacity: 0.35 }, onEdgesReady) {
  return loadCadFromArrayBuffer(buf, 'step', onPhase, edgeStyle, onEdgesReady);
}

// Resolve the parsed per-mesh typed arrays, preferring the off-thread worker and
// falling back to the main-thread engine. The worker keeps orbit/gizmo/UI
// responsive while a dense part decodes, but it is an OPTIMIZATION, never a hard
// dependency: any engine/CDN/WASM/worker init failure — or a worker crash
// mid-parse — permanently disables the worker for this session (see
// `workerDisabled`) and we re-run on the proven pre-regression main-thread path,
// so a model ALWAYS loads even where the worker can't. A genuine bad-bytes parse
// failure (kind:'parse') is re-thrown untouched: the main thread would fail on the
// same bytes identically, so retrying there would only double the work.
// Returns `{ meshes, root }`: the per-mesh typed arrays plus the sanitized occt
// assembly hierarchy (or null when the engine supplied none).
async function getMeshes(arrayBuffer, reader, onPhase) {
  if (!workerDisabled) {
    try {
      await getWorkerReady();
      if (onPhase) onPhase('parse');
      return await postParse(arrayBuffer, reader);
    } catch (err) {
      if (err && err.kind === 'parse') throw err; // bad CAD bytes — no fallback helps
      disableWorker(); // engine/init failure or worker crash — degrade to main thread
    }
  }
  if (onPhase) onPhase('parse');
  return parseOnMainThread(arrayBuffer, reader);
}

// Build the THREE.Group from the (worker- or main-thread-produced) per-mesh typed
// arrays + the occt assembly hierarchy. Shared verbatim by both engines so the
// returned Group — geometry, materials, per-part userData, structural registry,
// and deferred edge overlays — is byte-for-byte identical no matter which engine
// parsed the STEP.
//
// PER-PART FIDELITY (issue #94): earlier this merged every result mesh into a few
// draw calls grouped by colour, which flattened a multi-body assembly into an
// anonymous blob — you couldn't tell how many parts it had, name them, or hide
// one to see another. Per-part visibility is fundamentally incompatible with
// cross-body merging (a merged geometry is ONE object; you can't hide a slice of
// it), so we now build exactly one THREE.Mesh per occt result mesh (== one
// solid/body) and tag it with a stable index + name on userData. This also makes
// the explode + color-by-part tools literally correct — both already assumed
// "one mesh per solid". The cost is draw calls (a same-colour assembly no longer
// collapses to one mesh); this is the deliberate, criteria-required trade for
// assembly data fidelity, and each mesh's own colour/name is now preserved too.
function buildGroup(meshes, root, edgeStyle, onEdgesReady) {
  const group = new THREE.Group();

  // Recover a display name per result-mesh index from the assembly hierarchy
  // (occt's result.root): every node that references mesh indices lends those
  // meshes its STEP product/component label. Used only as a fallback when the
  // flat per-mesh name is blank, so the more specific per-body name still wins.
  const nameByIndex = namesFromRoot(meshes.length, root);

  meshes.forEach((resultMesh, i) => {
    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(resultMesh.position, 3)
    );

    if (resultMesh.normal) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(resultMesh.normal, 3));
    }

    if (resultMesh.index) {
      geometry.setIndex(new THREE.Uint32BufferAttribute(resultMesh.index, 1));
    }

    if (!resultMesh.normal) {
      geometry.computeVertexNormals();
    }

    let color = new THREE.Color(0x4f9dff);
    if (resultMesh.color && resultMesh.color.length >= 3) {
      color = new THREE.Color(resultMesh.color[0], resultMesh.color[1], resultMesh.color[2]);
    }

    const name = resultMesh.name || nameByIndex[i] || '';
    emitMesh(group, geometry, color, name, i, edgeStyle, onEdgesReady);
  });

  // Ordered parts registry the UI reads to render the "Parts" panel: one entry
  // per built mesh (== one occt solid). `index` is stable for the model's life so
  // a row always addresses the same mesh; `name` may be '' (the UI supplies a
  // localized "Part N" fallback).
  //
  // Attached NON-ENUMERABLY on userData: it holds live THREE.Mesh references
  // (mesh → parent → group → userData → parts → mesh is circular), and GLTFExporter
  // serializes each object's userData via JSON.stringify over Object.keys(userData).
  // A non-enumerable prop is invisible to Object.keys, so export never trips on the
  // cycle — while `group.userData.parts` / `.tree` stay directly readable by the UI.
  Object.defineProperty(group.userData, 'parts', {
    value: group.children
      .filter((c) => c.isMesh)
      .map((mesh) => ({ index: mesh.userData.partIndex, name: mesh.userData.partName, mesh })),
    enumerable: false, writable: true, configurable: true,
  });

  // Lightweight structural tree derived from occt's root (names + mesh indices),
  // handed to the UI alongside the group so it can render hierarchy. Null when the
  // engine supplied no hierarchy. Non-enumerable for the same export-safety reason.
  Object.defineProperty(group.userData, 'tree', {
    value: liteTree(root),
    enumerable: false, writable: true, configurable: true,
  });

  return group;
}

// Build a per-result-mesh-index name array from the occt assembly hierarchy. Walks
// every node; a node with `meshes` (indices into the flat result array) lends its
// `name` to those meshes. First (shallowest) name wins so a leaf keeps its own
// component label rather than an ancestor assembly's. Returns an all-'' array when
// there's no hierarchy, so callers can treat it uniformly.
function namesFromRoot(count, root) {
  const names = new Array(count).fill('');
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const list = Array.isArray(node.meshes) ? node.meshes : [];
    for (const mi of list) {
      if (typeof mi === 'number' && mi >= 0 && mi < count && !names[mi] && node.name) {
        names[mi] = node.name;
      }
    }
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const c of kids) walk(c);
  };
  walk(root);
  return names;
}

// Reduce the occt assembly hierarchy to a minimal, structured-clone-safe tree
// ({ name, meshes?, children? }) for the UI to render structure from, dropping any
// engine-specific extras. Returns null for a missing/invalid node.
function liteTree(node) {
  if (!node || typeof node !== 'object') return null;
  const out = { name: node.name || '' };
  if (Array.isArray(node.meshes)) {
    const idx = node.meshes.filter((m) => typeof m === 'number');
    if (idx.length) out.meshes = idx;
  }
  const kids = Array.isArray(node.children) ? node.children.map(liteTree).filter(Boolean) : [];
  if (kids.length) out.children = kids;
  return out;
}

// --- Main-thread fallback engine -------------------------------------------
// The pre-regression path: inject occt-import-js as a classic <script>, call the
// exposed global factory, and parse on the main thread. It blocks the UI while a
// dense part decodes (which is exactly why the worker exists), but it needs no
// Worker + importScripts + off-thread WASM, so it loads wherever the worker path
// is blocked or broken. Reached only via getMeshes()/initOcct() once the worker
// has been disabled, so the common case still parses off-thread.

// Idempotent-per-call factory loader: resolves window.occtimportjs, injecting the
// CDN <script> once if it isn't already present.
function loadOcctFactoryMainThread() {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      reject(new Error('no DOM available for the main-thread occt fallback'));
      return;
    }
    if (window.occtimportjs) {
      resolve(window.occtimportjs);
      return;
    }
    const script = document.createElement('script');
    script.src = OCCT_BASE + 'occt-import-js.js';
    script.onload = () => {
      if (window.occtimportjs) resolve(window.occtimportjs);
      else reject(new Error('occt-import-js loaded but did not expose a factory'));
    };
    script.onerror = () => reject(new Error('Failed to load occt-import-js from CDN'));
    document.head.appendChild(script);
  });
}

// Load + init the main-thread WASM engine exactly once, cached. locateFile points
// at the same CDN dir so the sibling .wasm resolves. A failure rejects with
// kind:'init' and clears the cache so a later attempt retries the download.
function initOcctMainThread() {
  if (!mainThreadOcctPromise) {
    mainThreadOcctPromise = loadOcctFactoryMainThread()
      .then((factory) => factory({ locateFile: (path) => OCCT_BASE + path }))
      .catch((err) => {
        mainThreadOcctPromise = null; // allow a retry on the next attempt
        const e = err instanceof Error ? err : new Error(String(err));
        e.kind = 'init';
        throw e;
      });
  }
  return mainThreadOcctPromise;
}

// Parse STEP bytes on the main thread and return the SAME `{ meshes, root }`
// shape the worker posts back, so buildGroup consumes either engine identically.
// Bad bytes reject with kind:'parse'; engine/CDN/WASM failures surface (via
// initOcctMainThread) with kind:'init'.
async function parseOnMainThread(arrayBuffer, reader) {
  const occt = await initOcctMainThread();
  const result = occt[reader](new Uint8Array(arrayBuffer), null);
  if (!result || !result.success) {
    const e = new Error(`occt ${reader} failed to parse the CAD data`);
    e.kind = 'parse';
    throw e;
  }
  return { meshes: result.meshes.map(repackResultMesh), root: result.root || null };
}

// Repack one occt result mesh into the { position, normal, index, color, name }
// typed-array shape the worker transfers back (see step.worker.js), so buildGroup
// is fed byte-for-byte the same structure from either engine.
function repackResultMesh(rm) {
  const position = Float32Array.from(rm.attributes.position.array);

  let normal = null;
  if (rm.attributes.normal && rm.attributes.normal.array) {
    normal = Float32Array.from(rm.attributes.normal.array);
  }

  let index = null;
  if (rm.index && rm.index.array) {
    index = Uint32Array.from(rm.index.array);
  }

  let color = null;
  if (rm.color && rm.color.length >= 3) {
    color = Float32Array.from([rm.color[0], rm.color[1], rm.color[2]]);
  }

  return { position, normal, index, color, name: rm.name || '' };
}

// Permanently route to the main-thread engine for the rest of the session and tear
// down the (broken) worker so nothing keeps awaiting it.
function disableWorker() {
  workerDisabled = true;
  teardownWorker();
}

// Build the shaded Mesh for one geometry+color, stash the base color + STEP name
// + stable part index, schedule its deferred edge overlay, and add it to the
// group. One call per occt result mesh, so material, userData, and edge behaviour
// are identical for every part.
function emitMesh(group, geometry, color, name, partIndex, edgeStyle, onEdgesReady) {
  // Machined-metal PBR: near-full metalness with a tight satin roughness so the
  // scene's RoomEnvironment IBL yields the crisp reflections of a milled aluminum
  // part rather than flat toy blue. The blue accent identity is kept via `color`;
  // envMapIntensity is lifted slightly so the reflections read strongly under the
  // filmic tone map.
  const material = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.85,
    roughness: 0.3,
    envMapIntensity: 1.15,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);

  // Stash the resolved occt base color on the mesh so the app's material
  // presets (Studio/Technical/Clay/X-ray) can recolor and restore the part's
  // real color without re-parsing the STEP. `color` above is the same value
  // the default Studio material starts with; clone so a later preset mutating
  // material.color can never mutate this reference.
  mesh.userData.baseColor = color.clone();

  // Carry the STEP sub-object name through to the Mesh so the click-to-select
  // picker can label the face it hit. occt-import-js exposes a per-mesh `name`
  // (the STEP product/solid label); it can be empty, so the picker falls back
  // to a child index when this is blank.
  if (name) mesh.name = name;

  // Per-part identity for the "Parts" panel (issue #94): a stable index (the occt
  // result-mesh position, so a panel row always addresses the same mesh across
  // re-renders) and the resolved name (may be '' — the UI supplies a localized
  // "Part N" fallback). The panel toggles this mesh's `visible`; its deferred
  // edge-lines child is a descendant, so hiding the mesh hides the edges too.
  mesh.userData.partIndex = partIndex;
  mesh.userData.partName = name || '';

  // Faint edge lines for mechanical crispness. EdgesGeometry with a 30° crease
  // threshold keeps only real feature edges (not every triangle), so smooth
  // fillets stay clean. Added as a child so it inherits the mesh transform and
  // is disposed with the group; the wireframe toggle leaves it untouched
  // (LineBasicMaterial ignores `wireframe`). Built from this mesh's (possibly
  // merged) geometry, so the overlay also collapses to one LineSegments per colour.
  //
  // EdgesGeometry walks every triangle of the full mesh — on a dense CAD part
  // that's the single most expensive app-side step, and doing it inline blocks
  // the group (and thus first render) until every edge is computed. Defer it to
  // an idle slot so the shaded mesh appears as soon as it's parsed; the edges
  // pop in a beat later as non-essential polish. Guard on the parent still
  // being attached so a model swapped out before the idle callback fires
  // doesn't attach edges to (or leak geometry for) a discarded group.
  scheduleEdges(mesh, geometry, edgeStyle, onEdgesReady);

  group.add(mesh);
}

// True while `obj` is still connected to a live Scene. After a model swap the
// caller does `scene.remove(group)` (severing group.parent) but leaves the mesh
// attached to the group, so `mesh.parent` alone stays truthy on a discarded
// group — walk the ancestor chain to a Scene instead for a reliable liveness
// check.
function isInScene(obj) {
  for (let o = obj; o; o = o.parent) {
    if (o.isScene) return true;
  }
  return false;
}

// Triangle-count ceiling for the decorative feature-edge overlay. EdgesGeometry
// walks EVERY triangle of the mesh (O(tris) CPU) and allocates a whole second
// geometry's worth of GPU memory for the line set — pure polish on top of the
// shaded mesh, which is already the deliverable. On a multi-million-triangle part
// that idle task janks and can roughly double memory for a barely-visible gain,
// so above this threshold we skip the overlay for that mesh entirely: no
// EdgesGeometry, no LineSegments, no extra material is ever allocated. Models
// under the limit are byte-for-byte unchanged.
const EDGE_TRI_LIMIT = 500_000;

// Triangle count for a geometry, matching how the app counts tris elsewhere
// (index.count/3 when indexed, else position.count/3 — see index.html
// countTriangles). Returns 0 for a geometry with neither attribute so it can
// never trip the skip guard on a degenerate/empty mesh.
function triangleCount(geometry) {
  if (geometry.index) return geometry.index.count / 3;
  const pos = geometry.attributes && geometry.attributes.position;
  return pos ? pos.count / 3 : 0;
}

// Build the decorative feature-edge overlay for a mesh during an idle slot,
// after the shaded mesh is already on screen. Kept off the parse/first-render
// path so first display isn't blocked on it (see call site).
function scheduleEdges(mesh, geometry, edgeStyle, onEdgesReady) {
  // Above EDGE_TRI_LIMIT the overlay costs more than it's worth (see the constant):
  // bail before scheduling any idle work so nothing is allocated for this mesh. The
  // shaded mesh still renders normally; it just goes without feature edges.
  if (triangleCount(geometry) > EDGE_TRI_LIMIT) return;
  runWhenIdle(() => {
    // The group may have been swapped out before this idle slot ran; if it's no
    // longer in the scene, skip so we don't build edges on a discarded model.
    if (!isInScene(mesh)) return;
    // Blueprint mode force-builds any missing edge overlay synchronously when it
    // switches on (see index.html applyBlueprint). If that already ran for this
    // mesh, skip here so a mesh never ends up with two overlapping LineSegments
    // children (a GPU-geometry leak surviving until the next disposeGroup).
    if (mesh.children.some((c) => c.isLineSegments)) return;
    const edgeGeom = new THREE.EdgesGeometry(geometry, 30);
    const edges = new THREE.LineSegments(
      edgeGeom,
      new THREE.LineBasicMaterial({ color: edgeStyle.color, transparent: true, opacity: edgeStyle.opacity })
    );
    edges.raycast = () => {}; // decorative overlay — never a pick/hit target
    mesh.add(edges);
    // Ask the app to redraw: under render-on-demand the loop may have parked
    // after first render, so without this the deferred edges wouldn't show until
    // the next camera move.
    if (typeof onEdgesReady === 'function') onEdgesReady();
  });
}
