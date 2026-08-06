// STEP loader core — parses STEP (ISO 10303) into three.js geometry via
// occt-import-js (OpenCascade compiled to WebAssembly).
//
// occt-import-js ships as a UMD/global factory (not an ES module). The actual
// parse (occt.ReadStepFile) runs in a classic Web Worker (src/step.worker.js)
// that `importScripts()` the same CDN script, so a dense CAD part decodes off the
// main thread and orbit/gizmo/UI never freeze. This module owns the worker
// lifecycle + message protocol and rebuilds the THREE geometry from the typed
// arrays the worker transfers back.

import * as THREE from 'three';
// mergeGeometries is reachable through index.html's existing `three/addons/`
// importmap entry (same jsdelivr three@0.160.0 path), so this stays zero-build.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const OCCT_VERSION = '0.0.23';
const OCCT_BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;

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
        p.resolve(msg.meshes);
      }
      break;
    }
    case 'parse-error': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        const e = new Error(msg.message || 'occt ReadStepFile failed to parse the STEP data');
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

// Send the STEP bytes to the worker (transferred zero-copy) and await the parsed
// per-mesh typed arrays. Rejects with `kind: 'parse'` on bad bytes.
function postParse(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const id = ++msgSeq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'parse', id, buffer: arrayBuffer }, [arrayBuffer]);
  });
}

// Ensures the parse worker + its WASM engine are up (idempotent).
// Any failure here is an engine/CDN/WASM/worker problem (network or init), NOT a
// parse failure — it rejects with `kind: 'init'` so callers can word the message
// right, and the cache self-clears so a later load can retry.
export async function initOcct() {
  return getWorkerReady();
}

// Terminate the parse worker and discard the cached engine-ready promise so the
// next initOcct()/load spawns a fresh worker and re-inits the engine. Used by the
// UI's Retry after an engine/CDN load failure or a stall: getWorkerReady only
// self-clears on rejection, so a still-pending (hung) attempt would otherwise be
// re-awaited forever. Terminating here also kills any in-flight parse so a retry
// starts a genuinely new attempt.
export function resetOcct() {
  teardownWorker();
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
export async function loadStepFromArrayBuffer(buf, onPhase, edgeStyle = { color: 0x0a0d12, opacity: 0.35 }, onEdgesReady) {
  if (onPhase) onPhase('engine');
  await getWorkerReady();

  // Normalize to a standalone ArrayBuffer we can hand to the worker's transfer
  // list (zero-copy). Slice a TypedArray view to exactly its range so we transfer
  // only these bytes and never detach a buffer the view might share.
  let arrayBuffer;
  if (buf instanceof ArrayBuffer) {
    arrayBuffer = buf;
  } else if (ArrayBuffer.isView(buf)) {
    arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } else {
    arrayBuffer = new Uint8Array(buf).buffer;
  }

  if (onPhase) onPhase('parse');
  // The parse runs in the worker; it transfers back per-mesh typed arrays. A
  // bad-bytes failure rejects here with kind:'parse' (see postParse/protocol).
  const meshes = await postParse(arrayBuffer);

  // Turn each occt result mesh into a THREE.BufferGeometry (+ its resolved color
  // and STEP sub-object name), computing normals where occt didn't supply them.
  const entries = meshes.map((resultMesh) => {
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

    return { geometry, color, name: resultMesh.name || '' };
  });

  const group = new THREE.Group();

  // Draw-call reduction: a STEP assembly can decode into dozens-to-hundreds of
  // small result meshes, each its own per-frame draw call. Group entries by their
  // resolved color and merge each colour-group's geometries into ONE indexed
  // BufferGeometry, so the scene renders one Mesh per distinct colour instead of
  // one per solid. countTriangles / frameObject read the summed index counts and
  // combined bbox, both invariant under merging; the wireframe toggle and the
  // idle edge overlay operate on the merged mesh, so tri count and bounds are
  // byte-for-byte the same as the unmerged path — only the draw-call count drops.
  //
  // Merging is skipped when there's a single result mesh (nothing to combine),
  // and falls back to the per-mesh path for any geometry whose attribute
  // signature can't be merged (mismatched attributes or mixed indexed/non-indexed
  // within a colour), so a stray incompatible mesh never drops out of the scene.
  if (entries.length <= 1) {
    for (const e of entries) emitMesh(group, e.geometry, e.color, e.name, edgeStyle, onEdgesReady);
  } else {
    // colorKey → { color, entries: [] }, preserving first-seen colour order.
    const byColor = new Map();
    for (const e of entries) {
      const key = e.color.getHexString();
      let bucket = byColor.get(key);
      if (!bucket) { bucket = { color: e.color, list: [] }; byColor.set(key, bucket); }
      bucket.list.push(e);
    }

    for (const bucket of byColor.values()) {
      // Within a colour, partition by attribute signature so only geometries that
      // mergeGeometries can actually combine are merged together; anything with a
      // different signature (or a lone mesh) takes the per-mesh path.
      const bySig = new Map();
      for (const e of bucket.list) {
        const key = signatureKey(e.geometry);
        let part = bySig.get(key);
        if (!part) { part = []; bySig.set(key, part); }
        part.push(e);
      }

      for (const part of bySig.values()) {
        if (part.length === 1) {
          emitMesh(group, part[0].geometry, bucket.color, part[0].name, edgeStyle, onEdgesReady);
          continue;
        }
        // mergeGeometries returns null (and logs) if the geometries are somehow
        // still incompatible — fall back to the per-mesh path so no solid is lost.
        const merged = mergeGeometries(part.map((e) => e.geometry), false);
        if (merged) {
          const name = (part.find((e) => e.name) || part[0]).name;
          emitMesh(group, merged, bucket.color, name, edgeStyle, onEdgesReady);
        } else {
          for (const e of part) {
            emitMesh(group, e.geometry, bucket.color, e.name, edgeStyle, onEdgesReady);
          }
        }
      }
    }
  }

  return group;
}

// A stable key for a geometry's mergeability: sorted attribute names plus whether
// it's indexed. mergeGeometries requires every input to share the same attributes
// and be uniformly indexed or non-indexed, so geometries with matching keys are
// safe to merge together and mismatched ones must stay separate.
function signatureKey(geometry) {
  const attrs = Object.keys(geometry.attributes).sort().join(',');
  return `${attrs}|${geometry.index ? 'i' : 'n'}`;
}

// Build the shaded Mesh for one geometry+color, stash the base color + STEP name,
// schedule its deferred edge overlay, and add it to the group. Shared by both the
// merged (one mesh per colour) and per-mesh fallback paths so the material,
// userData, and edge behaviour are identical regardless of how the mesh was formed.
function emitMesh(group, geometry, color, name, edgeStyle, onEdgesReady) {
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
