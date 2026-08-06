// STEP loader core — parses STEP (ISO 10303) into three.js geometry via
// occt-import-js (OpenCascade compiled to WebAssembly).
//
// occt-import-js ships as a UMD/global factory (not an ES module), so we inject
// it as a classic <script> and then call the exposed `occtimportjs` factory,
// pointing `locateFile` at the CDN so the sibling .wasm resolves correctly.

import * as THREE from 'three';

const OCCT_VERSION = '0.0.23';
const OCCT_BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;

// Run a low-priority task off the first-paint critical path. Prefer
// requestIdleCallback so edge-line generation waits for an idle slot after the
// mesh is on screen; fall back to a macrotask where it isn't available.
const runWhenIdle =
  typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => setTimeout(fn, 0);

let occtPromise = null;

function loadOcctFactory() {
  return new Promise((resolve, reject) => {
    if (window.occtimportjs) return resolve(window.occtimportjs);
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

// Loads and initializes the occt-import-js WASM module (idempotent).
// Any failure here is an engine/CDN/WASM problem (network or init), NOT a parse
// failure — tag it with `kind: 'init'` so callers can word the message right,
// and reset the cached promise so a later load can retry the download.
export async function initOcct() {
  if (!occtPromise) {
    occtPromise = loadOcctFactory()
      .then((factory) => factory({ locateFile: (path) => OCCT_BASE + path }))
      .catch((err) => {
        occtPromise = null; // allow a retry on the next load attempt
        const e = err instanceof Error ? err : new Error(String(err));
        e.kind = 'init';
        throw e;
      });
  }
  return occtPromise;
}

// Discard the cached engine-init promise so the next initOcct() starts a fresh
// download + init. Used by the UI's Retry after an engine/CDN load failure or a
// stall: initOcct only self-clears the cache on rejection, so a still-pending
// (hung) attempt would otherwise be re-awaited forever. Clearing it here lets a
// retry kick off a genuinely new attempt.
export function resetOcct() {
  occtPromise = null;
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
export async function loadStepFromArrayBuffer(buf, onPhase, edgeStyle = { color: 0x0a0d12, opacity: 0.35 }) {
  if (onPhase) onPhase('engine');
  const occt = await initOcct();
  const fileBuffer = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  if (onPhase) onPhase('parse');
  const result = occt.ReadStepFile(fileBuffer, null);
  if (!result || !result.success) {
    // The engine loaded but the bytes were not valid/parseable STEP — tag it as
    // a genuine parse failure so callers can distinguish it from a load failure.
    const e = new Error('occt ReadStepFile failed to parse the STEP data');
    e.kind = 'parse';
    throw e;
  }

  const group = new THREE.Group();
  for (const resultMesh of result.meshes) {
    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(resultMesh.attributes.position.array, 3)
    );

    if (resultMesh.attributes.normal && resultMesh.attributes.normal.array) {
      geometry.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(resultMesh.attributes.normal.array, 3)
      );
    }

    if (resultMesh.index && resultMesh.index.array) {
      geometry.setIndex(new THREE.Uint32BufferAttribute(resultMesh.index.array, 1));
    }

    if (!(resultMesh.attributes.normal && resultMesh.attributes.normal.array)) {
      geometry.computeVertexNormals();
    }

    let color = new THREE.Color(0x4f9dff);
    if (resultMesh.color && resultMesh.color.length >= 3) {
      color = new THREE.Color(resultMesh.color[0], resultMesh.color[1], resultMesh.color[2]);
    }

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
    if (resultMesh.name) mesh.name = resultMesh.name;

    // Faint edge lines for mechanical crispness. EdgesGeometry with a 30° crease
    // threshold keeps only real feature edges (not every triangle), so smooth
    // fillets stay clean. Added as a child so it inherits the mesh transform and
    // is disposed with the group; the wireframe toggle leaves it untouched
    // (LineBasicMaterial ignores `wireframe`).
    //
    // EdgesGeometry walks every triangle of the full mesh — on a dense CAD part
    // that's the single most expensive app-side step, and doing it inline blocks
    // the group (and thus first render) until every edge is computed. Defer it to
    // an idle slot so the shaded mesh appears as soon as it's parsed; the edges
    // pop in a beat later as non-essential polish. Guard on the parent still
    // being attached so a model swapped out before the idle callback fires
    // doesn't attach edges to (or leak geometry for) a discarded group.
    scheduleEdges(mesh, geometry, edgeStyle);

    group.add(mesh);
  }

  return group;
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

// Build the decorative feature-edge overlay for a mesh during an idle slot,
// after the shaded mesh is already on screen. Kept off the parse/first-render
// path so first display isn't blocked on it (see call site).
function scheduleEdges(mesh, geometry, edgeStyle) {
  runWhenIdle(() => {
    // The group may have been swapped out before this idle slot ran; if it's no
    // longer in the scene, skip so we don't build edges on a discarded model.
    if (!isInScene(mesh)) return;
    const edgeGeom = new THREE.EdgesGeometry(geometry, 30);
    const edges = new THREE.LineSegments(
      edgeGeom,
      new THREE.LineBasicMaterial({ color: edgeStyle.color, transparent: true, opacity: edgeStyle.opacity })
    );
    edges.raycast = () => {}; // decorative overlay — never a pick/hit target
    mesh.add(edges);
  });
}
