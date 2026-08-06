// @ts-check
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

// The pure, node-importable geometry transform lives in step-core.js (issue #108);
// this module is the browser-only orchestrator (worker + <script> injection + CDN)
// that feeds it. buildGroupFromOcctResult builds the THREE.Group from either
// engine's per-mesh arrays; it imports `three` itself, so step.js no longer needs
// a direct three import.
import { buildGroupFromOcctResult, repackResultMesh } from './step-core.js';

/** @typedef {import('three').Group} Group */
/** @typedef {import('./step-core.js').OcctMesh} OcctMesh */
/** @typedef {import('./step-core.js').OcctNode} OcctNode */
/** @typedef {import('./step-core.js').EdgeStyle} EdgeStyle */
/** @typedef {import('./ui.js').ErrorKind} ErrorKind */
/** @typedef {import('./ui.js').TaggedError} TaggedError */

/**
 * Provenance metadata recovered best-effort from a STEP HEADER block. Any field
 * may be '' when it could not be read.
 * @typedef {object} StepHeader
 * @property {string} schema - FILE_SCHEMA identifier, e.g. AUTOMOTIVE_DESIGN.
 * @property {string} ap - Application Protocol short name (AP203/AP214/AP242).
 * @property {string} author - Author list, comma-joined.
 * @property {string} organization - Organization list, comma-joined.
 * @property {string} originatingSystem - Originating CAD system.
 * @property {string} preprocessor - Preprocessor version string.
 * @property {string} timestamp - FILE_NAME time_stamp.
 */

/**
 * The `{ meshes, root }` shape both engines produce and buildGroup consumes.
 * @typedef {object} ParseResult
 * @property {OcctMesh[]} meshes - Per-mesh typed arrays, one per solid.
 * @property {OcctNode | null} root - Sanitized assembly hierarchy, or null.
 */

/** A stage tag passed to the optional progress hook. @typedef {'engine' | 'parse'} LoadPhase */

// Exported so the UI (About panel, issue #113) can display the live engine
// version instead of hardcoding it — a version bump here updates the panel
// automatically. The three.js version is read at runtime from THREE.REVISION.
export const OCCT_VERSION = '0.0.23';
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
/**
 * @param {string} nameOrExt - A file name, dotted extension, or bare extension.
 * @returns {string | null} The occt reader method (ReadStepFile / ReadIgesFile /
 *   ReadBrepFile), or null when the extension isn't one occt reads.
 */
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
/**
 * Detect a STEP file's declared length unit. Pure, bounded, and never throws.
 * @param {ArrayBuffer | ArrayBufferView} buffer - The raw STEP bytes.
 * @returns {'mm' | 'm' | 'cm' | 'in' | 'ft' | 'mil' | null} The short unit
 *   symbol, or null when it can't be determined.
 */
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

// Cap for the STEP HEADER scan (issue #96). The ISO-10303-21 HEADER section
// (FILE_DESCRIPTION / FILE_NAME / FILE_SCHEMA) is the very first block of the
// file and is tiny — a few hundred bytes to a couple KB — so decode only this
// leading window and never touch the (potentially many-MB) DATA section. If the
// header somehow doesn't appear inside the window, we simply report no metadata.
const HEADER_SCAN_CAP = 64 * 1024;

// Return the argument text inside the FIRST `NAME(...)` call in `text`, matched
// with balanced parentheses and string-literal awareness (so a `)` or `(` inside
// a quoted value doesn't end the call early). Returns null when the call isn't
// found. Case-insensitive on the keyword — STEP keywords are conventionally
// upper-case, but we don't rely on it.
function stepCallArgs(text, name) {
  const re = new RegExp(name + '\\s*\\(', 'gi');
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length; // just past the opening '('
  let depth = 1;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      // '' is an escaped single quote inside a STEP string, not a terminator.
      if (c === "'") {
        if (text[i + 1] === "'") { i++; continue; }
        inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; continue; }
    else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return text.slice(start, i); }
  }
  return text.slice(start); // unterminated call — best-effort tail
}

// Split a call's argument text into top-level comma-separated arguments,
// respecting nested parens and string literals (so `('a,b'),'c'` → two args, not
// three). Returns trimmed argument strings.
function stepTopLevelArgs(inner) {
  const args = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (inner[i + 1] === "'") { cur += "'"; i++; continue; }
        inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  args.push(cur.trim());
  return args;
}

// Decode the ISO-10303-21 string escapes that show up in header fields:
// `\X2\HHHH…\X0\` (UTF-16BE code units) and `\X\HH` (a single ISO-8859 byte).
// Anything else is left as-is — this is best-effort display cleanup, never a
// correctness dependency.
function decodeStepEscapes(s) {
  return s
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
      let out = '';
      for (let i = 0; i + 4 <= hex.length; i += 4) {
        out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      }
      return out;
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Pull every quoted string literal out of one argument (handling the '' escape),
// decoded for display. `$` (STEP's "unset") and unquoted tokens yield []. Used for
// both scalar fields (take [0]) and STEP's parenthesized author/organization lists.
function stepStrings(arg) {
  if (arg == null) return [];
  const out = [];
  let inStr = false;
  let cur = '';
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if (inStr) {
      if (c === "'") {
        if (arg[i + 1] === "'") { cur += "'"; i++; continue; }
        inStr = false;
        out.push(decodeStepEscapes(cur));
        cur = '';
        continue;
      }
      cur += c;
    } else if (c === "'") {
      inStr = true;
      cur = '';
    }
  }
  return out;
}

// First quoted string of an argument, or '' when there is none (e.g. `$`).
function stepFirstString(arg) {
  const all = stepStrings(arg);
  return all.length ? all[0].trim() : '';
}

// The bare schema name from a FILE_SCHEMA entry like
// `AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }` — everything before the `{`/`(`.
function stepSchemaName(s) {
  const t = String(s).trim();
  const cut = t.search(/[{(]/);
  return (cut >= 0 ? t.slice(0, cut) : t).trim();
}

// Map a FILE_SCHEMA identifier to its familiar Application Protocol short name.
// Recognized by schema keyword first (AUTOMOTIVE_DESIGN⇒AP214,
// CONFIG_CONTROL_DESIGN⇒AP203, the AP242 managed-model schema⇒AP242), then by the
// `10303 <n>` protocol number embedded in the schema identifier braces. Returns ''
// when nothing recognizable is present rather than guessing.
function stepApName(schemaText) {
  const u = String(schemaText).toUpperCase();
  if (u.includes('AP242') || u.includes('MANAGED_MODEL_BASED_3D_ENGINEERING')) return 'AP242';
  if (u.includes('AUTOMOTIVE_DESIGN')) return 'AP214';
  if (u.includes('CONFIG_CONTROL_DESIGN')) return 'AP203';
  const m = u.match(/10303\s+(\d+)/);
  if (m && (m[1] === '203' || m[1] === '214' || m[1] === '242')) return 'AP' + m[1];
  return '';
}

// Decode ONLY the leading HEADER;…ENDSEC; block of a STEP file as text and extract,
// best-effort, its provenance metadata (issue #96): the FILE_SCHEMA schema name +
// Application Protocol (AP203/AP214/AP242), and from FILE_NAME the timestamp, author
// list, organization list, preprocessor version, and originating system.
//
// Bounded (only HEADER_SCAN_CAP leading bytes are decoded, and only the text
// between the first `HEADER;` and the following `ENDSEC;` is scanned) and it NEVER
// throws: any decode/parse miss degrades to empty fields. Returns null when the
// header isn't found in the window (non-STEP formats, or a header past the cap) or
// when nothing usable was extracted, so callers can treat "no metadata" uniformly.
/**
 * Decode only the leading HEADER;…ENDSEC; block of a STEP file and extract, best
 * effort, its provenance metadata. Bounded and never throws.
 * @param {ArrayBuffer | ArrayBufferView} buffer - The raw STEP bytes.
 * @returns {StepHeader | null} The recovered header, or null when none was found.
 */
export function parseStepHeader(buffer) {
  try {
    let bytes;
    if (buffer instanceof ArrayBuffer) {
      bytes = new Uint8Array(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else {
      return null;
    }

    const dec = new TextDecoder('utf-8', { fatal: false });
    const head = dec.decode(bytes.subarray(0, Math.min(bytes.length, HEADER_SCAN_CAP)));

    // Bound the scan to the HEADER;…ENDSEC; block. No `HEADER;` in the window ⇒
    // not a STEP header we can read — report nothing rather than scanning DATA.
    const hIdx = head.indexOf('HEADER;');
    if (hIdx < 0) return null;
    const eIdx = head.indexOf('ENDSEC;', hIdx);
    const header = eIdx >= 0 ? head.slice(hIdx + 'HEADER;'.length, eIdx) : head.slice(hIdx + 'HEADER;'.length);

    const out = {
      schema: '', ap: '', author: '', organization: '',
      originatingSystem: '', preprocessor: '', timestamp: '',
    };

    // FILE_NAME(name, time_stamp, (author…), (organization…), preprocessor_version,
    // originating_system, authorization) — index the positional args after a
    // paren/string-aware split so a comma inside a quoted value never shifts them.
    const fnRaw = stepCallArgs(header, 'FILE_NAME');
    if (fnRaw != null) {
      const a = stepTopLevelArgs(fnRaw);
      out.timestamp = stepFirstString(a[1]);
      out.author = stepStrings(a[2]).map((s) => s.trim()).filter(Boolean).join(', ');
      out.organization = stepStrings(a[3]).map((s) => s.trim()).filter(Boolean).join(', ');
      out.preprocessor = stepFirstString(a[4]);
      out.originatingSystem = stepFirstString(a[5]);
    }

    // FILE_SCHEMA((‘AUTOMOTIVE_DESIGN { … }’)) — one or more schema identifier
    // strings; the first names the flavor and its AP.
    const fsRaw = stepCallArgs(header, 'FILE_SCHEMA');
    if (fsRaw != null) {
      const schemas = stepStrings(fsRaw);
      if (schemas.length) {
        out.schema = stepSchemaName(schemas[0]);
        out.ap = stepApName(schemas.join(' '));
      }
    }

    // Only surface a header when we actually recovered something.
    return Object.keys(out).some((k) => out[k]) ? out : null;
  } catch (e) {
    return null; // never let a header-parse failure affect the render
  }
}

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
      const e = /** @type {TaggedError} */ (new Error(msg.message || 'Failed to load the 3D engine in the worker'));
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
        const e = /** @type {TaggedError} */ (new Error(msg.message || 'occt failed to parse the CAD data'));
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
  const e = /** @type {TaggedError} */ (new Error((ev && ev.message) || 'STEP parse worker crashed'));
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
/**
 * Terminate the worker (if any) and reject every in-flight parse so nothing hangs.
 * @param {TaggedError} [err] - The failure that prompted teardown; pending parses
 *   get a generic `kind:'init'` rejection when omitted.
 * @returns {void}
 */
function teardownWorker(err) {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerReadyPromise = null;
  readyResolvers = null;
  for (const p of pending.values()) {
    const e = /** @type {TaggedError} */ (err || new Error('STEP parse worker was terminated'));
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
        const e = /** @type {TaggedError} */ (err instanceof Error ? err : new Error(String(err)));
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
/**
 * Ensure a CAD engine is up (idempotent): the parse worker + its WASM engine
 * when possible, otherwise the main-thread engine.
 * @returns {Promise<unknown>} Resolves once an engine is ready.
 * @throws {TaggedError} `kind:'init'` only if BOTH engines fail to load.
 */
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
/**
 * Terminate the parse worker and discard cached engine promises so the next
 * load spawns a fresh worker / re-downloads the engine. Used by the UI's Retry.
 * `workerDisabled` stays sticky so a proven-unusable worker isn't retried.
 * @returns {void}
 */
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
/**
 * Parse a CAD file (STEP/IGES/BREP) into a THREE.Group of shaded meshes,
 * off-thread via the worker when healthy, otherwise on the main thread.
 * @param {ArrayBuffer | ArrayBufferView} buf - The raw file bytes.
 * @param {string} ext - File name or extension used to pick the occt reader.
 * @param {(phase: LoadPhase) => void} [onPhase] - Progress hook: 'engine' then 'parse'.
 * @param {EdgeStyle} [edgeStyle] - Deferred feature-edge overlay stroke.
 * @param {() => void} [onEdgesReady] - Redraw hook after each edge overlay builds.
 * @returns {Promise<Group>} The loaded model group (with `userData.unit`
 *   and `userData.stepHeader` set for STEP when detectable).
 * @throws {TaggedError} `kind:'parse'` on unsupported extension or bad bytes,
 *   `kind:'empty'` when the parse yields no renderable geometry, or `kind:'init'`
 *   when the engine can't load.
 */
export async function loadCadFromArrayBuffer(buf, ext, onPhase, edgeStyle = { color: 0x0a0d12, opacity: 0.35 }, onEdgesReady) {
  if (onPhase) onPhase('engine');

  // Resolve the reader up front from the extension so an unknown format fails fast
  // (kind:'parse' — it's a bad-input problem, not an engine one) before the engine
  // is even touched. The UI guards on extension before calling in, so this is a
  // belt-and-suspenders check for a stray unsupported call.
  const reader = readerForExtension(ext);
  if (!reader) {
    const e = /** @type {TaggedError} */ (new Error(`Unsupported CAD file extension: ${ext}`));
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

  // No-renderable-geometry guard (issue #97): a file can parse cleanly yet carry
  // nothing tessellable — wireframe/surfaces-only, a datum/annotation export, or an
  // assembly of empty references — in which case the engine reports success with an
  // empty (or all-zero-vertex) mesh list. Building an empty THREE.Group here would
  // let showStepFromArrayBuffer tear down the current model and swap in a blank
  // scene with a success-worded hint and no signal that the file held nothing to
  // draw. Detect it and throw a distinctly-tagged error (kind:'empty') so the UI
  // can route it like a per-file parse error (transient toast) — and, because the
  // throw happens before any teardown, the previously loaded model stays on screen.
  const hasRenderableGeometry =
    Array.isArray(meshes) &&
    meshes.some((m) => m && m.position && m.position.length > 0);
  if (!hasRenderableGeometry) {
    const e = /** @type {TaggedError} */ (new Error('parsed OK but contains no solid geometry'));
    e.kind = 'empty';
    throw e;
  }

  const group = buildGroupFromOcctResult(meshes, root, edgeStyle, onEdgesReady);

  // Native length unit (issue #95): STEP declares its length unit as plain
  // ISO-10303-21 text, so decode + detect it here and stash the short symbol on
  // the group. Guarded by the reader so it runs ONLY for STEP — IGES/BREP carry
  // no reliable text length-unit field, so they report no unit rather than a
  // wrong one. Detection is bounded and never throws; a miss leaves `unit` unset,
  // which the UI reads as "unknown" and shows the current unitless dimensions.
  if (reader === 'ReadStepFile') {
    const unit = detectStepLengthUnit(arrayBuffer);
    if (unit) group.userData.unit = unit;

    // Header provenance (issue #96): the ISO-10303-21 HEADER carries schema/AP,
    // author, originating system, and a timestamp that the geometry parse throws
    // away. Decode the leading header block here (STEP-only — IGES/BREP have no
    // equivalent) and stash the best-effort fields on the group for the UI's
    // "Details" disclosure. Bounded and never throws; a miss leaves stepHeader
    // unset, which the UI reads as "no details to show".
    const stepHeader = parseStepHeader(arrayBuffer);
    if (stepHeader) group.userData.stepHeader = stepHeader;
  }

  return group;
}

// ---------------------------------------------------------------------------
// The occt-import-js result contract, documented in ONE place.
//
// occt's `Read{Step,Iges,Brep}File(bytes, params)` all return the SAME nested shape
// typed below (observed against occt-import-js@0.0.23 — see OCCT_VERSION). A
// contributor extending the loader — adding materials, per-mesh names, hierarchy, or
// a new format — should read these typedefs instead of reverse-engineering the schema
// from usage or the occt C++/WASM source. This is the RAW shape the engine emits;
// {@link repackResultMesh} (in ./step-core.js) flattens each mesh into the
// transferable {@link OcctMesh} typed-array shape buildGroupFromOcctResult consumes,
// and the worker transfers that flattened shape back — so the raw structure below is
// only ever touched at the parse boundary (parseOnMainThread + the worker).
// ---------------------------------------------------------------------------

/**
 * The raw value occt's `Read*File(bytes, params)` returns.
 * @typedef {object} OcctReadResult
 * @property {boolean} success - False when occt could not parse the bytes. The loader
 *   treats a falsy `success` as a kind:'parse' failure (see parseOnMainThread); a
 *   truthy `success` with an empty/degenerate `meshes` is caught downstream as
 *   kind:'empty' (a file that parsed but holds nothing tessellable).
 * @property {OcctRawMesh[]} meshes - One entry per tessellated solid; possibly empty.
 * @property {object} [root] - The assembly hierarchy (nodes carry a `name` and
 *   `meshes` index refs into the flat array, plus `children`). Sanitized into the
 *   lite tree the UI reads; absent or null when the engine supplies no hierarchy.
 */

/**
 * One raw mesh inside {@link OcctReadResult}.meshes — the NESTED attribute shape occt
 * emits, before {@link repackResultMesh} flattens it.
 *
 * Fields occt returns that this loader intentionally IGNORES (documented so "what
 * else is available" is discoverable without diffing the occt source):
 *   - `brep_faces`: an array of `{ first, last, color }` ranges that group the index
 *     buffer by the originating B-rep face — the hook for per-face selection or
 *     per-face coloring. This loader shades one material per whole solid, so it is
 *     dropped. A future per-face feature would read it here.
 * @typedef {object} OcctRawMesh
 * @property {{ array: number[] }} attributes - Vertex attributes. `attributes.position`
 *   `{ array }` is flat XYZ vertex positions, 3 numbers per vertex, in the model's
 *   NATIVE length units (occt does not normalize to mm/m; detectStepLengthUnit reads
 *   the unit from the STEP text) — REQUIRED, a mesh without it is not renderable.
 *   `attributes.normal` `{ array }` is flat XYZ per-vertex normals, 3 per vertex —
 *   OPTIONAL, omitted for some tessellations; when absent the group builder calls
 *   computeVertexNormals() to derive them.
 * @property {{ array: number[] }} [index] - Triangle vertex indices, 3 per triangle.
 *   OPTIONAL — absent for a non-indexed (triangle-soup) mesh.
 * @property {[number, number, number]} [color] - Per-body RGB, each channel a float
 *   already NORMALIZED to 0–1 (NOT 0–255) — mapped straight into new THREE.Color(r,g,b)
 *   with NO /255. OPTIONAL — absent when the body declares no color (default blue).
 * @property {string} [name] - STEP product/solid label, or absent/'' when unnamed.
 */

// Back-compat thin wrapper: the original STEP-only entry point, preserved so any
// caller (or bookmark) still works. Routes through the format-aware loader with the
// STEP reader.
/**
 * Back-compat STEP-only wrapper around {@link loadCadFromArrayBuffer}.
 * @param {ArrayBuffer | Uint8Array} buf - The raw STEP bytes.
 * @param {(phase: 'engine' | 'parse') => void} [onPhase] - Progress hook, invoked
 *   with 'engine' (before WASM engine init) then 'parse' (before decoding bytes).
 * @param {EdgeStyle} [edgeStyle] - Deferred feature-edge overlay stroke.
 * @param {() => void} [onEdgesReady] - Redraw hook after each edge overlay builds.
 * @returns {Promise<THREE.Group>} The loaded model group.
 */
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

// The pure THREE.Group construction (buildGroupFromOcctResult + its per-part
// fidelity, parts/tree registries, and deferred edge overlay) moved to
// step-core.js (issue #108) so it imports only `three` and runs headless. This
// module's loadCadFromArrayBuffer delegates to it after either engine parses.

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
    const w = /** @type {any} */ (window);
    if (w.occtimportjs) {
      resolve(w.occtimportjs);
      return;
    }
    const script = document.createElement('script');
    script.src = OCCT_BASE + 'occt-import-js.js';
    script.onload = () => {
      if (w.occtimportjs) resolve(w.occtimportjs);
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
        const e = /** @type {TaggedError} */ (err instanceof Error ? err : new Error(String(err)));
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
  // The raw occt read result — see the {@link OcctReadResult} typedef above for the
  // full nested contract (`{ success, meshes: OcctRawMesh[], root }`). The worker
  // path produces the identical shape off-thread; both feed repackResultMesh.
  const result = /** @type {OcctReadResult} */ (occt[reader](new Uint8Array(arrayBuffer), null));
  if (!result || !result.success) {
    const e = /** @type {TaggedError} */ (new Error(`occt ${reader} failed to parse the CAD data`));
    e.kind = 'parse';
    throw e;
  }
  return { meshes: result.meshes.map(repackResultMesh), root: result.root || null };
}

// repackResultMesh now lives in ./step-core.js (issue #109) so the browser loader
// and the headless parse test share ONE repack and can't drift; imported above.

// Permanently route to the main-thread engine for the rest of the session and tear
// down the (broken) worker so nothing keeps awaiting it.
function disableWorker() {
  workerDisabled = true;
  teardownWorker();
}
