// @ts-check
// STEP core — the pure, node-importable half of the CAD loader (issue #108).
//
// src/step.js used to couple two very different things: the browser-only engine
// loader (worker + importScripts, or a main-thread <script> injection pointing
// locateFile at jsdelivr) and the pure transform that turns the engine's per-mesh
// typed arrays into a THREE.Group. The pure transform is the load-bearing,
// testable logic, but it could not run outside a browser because importing step.js
// pulled in the worker/DOM/CDN loader. This module is that pure half: it imports
// ONLY `three` and touches no `window`/`document`/CDN, so it can be `import`-ed
// from a plain Node script (for unit tests, headless geometry checks, etc.)
// without throwing.
//
// The two engines (off-thread worker and main-thread fallback) both hand
// buildGroupFromOcctResult the SAME `{ meshes, root }` shape, so the Group it
// builds — geometry, materials, per-part userData, structural registry, and
// deferred edge overlays — is byte-for-byte identical no matter which engine
// parsed the CAD. countTriangles is the app's shared per-group triangle counter,
// moved here so the loader and the model-info HUD count tris the same way.

import * as THREE from 'three';

/**
 * One repacked result mesh — the flat typed-array shape both engines hand to
 * {@link buildGroupFromOcctResult} (see {@link repackResultMesh} and the worker).
 * @typedef {object} OcctMesh
 * @property {Float32Array} position - Flat XYZ vertex positions (3 per vertex).
 * @property {Float32Array | null} normal - Flat XYZ normals, or null (computed).
 * @property {Uint32Array | null} index - Triangle indices, or null (non-indexed).
 * @property {Float32Array | null} color - RGB in 0..1, or null (default blue).
 * @property {string} name - STEP product/solid label, or '' when unnamed.
 */

/**
 * A minimal, structured-clone-safe node of the occt assembly hierarchy.
 * @typedef {object} OcctNode
 * @property {string} [name] - The node's STEP label.
 * @property {number[]} [meshes] - Indices into the flat result-mesh array.
 * @property {OcctNode[]} [children] - Child nodes.
 */

/**
 * Stroke style for the deferred feature-edge overlay.
 * @typedef {object} EdgeStyle
 * @property {number} color - Line color as a THREE hex color number.
 * @property {number} opacity - Line opacity in 0..1.
 */

/**
 * One bundled sample-gallery entry.
 * @typedef {object} Sample
 * @property {string} file - On-disk name under ./samples/.
 * @property {string} labelKey - i18n key resolved to the display label at runtime.
 * @property {string} reader - occt reader method for the file's format.
 */

// Bundled sample gallery — the SINGLE SOURCE OF TRUTH for which models ship under
// ./samples/ (issue #109). Lives here, in the pure/node-importable core, so the app
// (src/main.js gallery + deep-link + number-key shortcuts) and the parse regression
// test (test/samples.test.js) read the exact same list and can never drift: a sample
// added or removed here is picked up by both without editing two places.
//
// Only stable, locale-independent data belongs here: the on-disk `file` name and the
// i18n `labelKey`. The localized display label is resolved by the app at runtime via
// t(labelKey) — the core stays free of the i18n/browser table so it keeps importing
// cleanly under Node. `reader` is the occt method the file's format needs, so a
// headless test (which has no file-extension→reader dispatch UI) can parse each
// sample with the right reader; it mirrors src/step.js's READER_BY_EXT.
/** @type {Sample[]} */
export const SAMPLES = [
  { file: 'sample.step',  labelKey: 'sampleGear',    reader: 'ReadStepFile' },
  { file: 'block.step',   labelKey: 'sampleBlock',   reader: 'ReadStepFile' },
  { file: 'tetra.step',   labelKey: 'sampleTetra',   reader: 'ReadStepFile' },
  { file: 'pyramid.step', labelKey: 'samplePyramid', reader: 'ReadStepFile' },
  // IGES sample — occt reads it for free via ReadIgesFile; kept in the same list so
  // the gallery, shortcuts, and the parse test all cover it too.
  { file: 'cube.iges',    labelKey: 'sampleCube',    reader: 'ReadIgesFile' },
];

// Run a low-priority task off the first-paint critical path. Prefer
// requestIdleCallback so edge-line generation waits for an idle slot after the
// mesh is on screen; fall back to a macrotask where it isn't available, and to a
// synchronous run where neither timer exists (a bare JS host). scheduleEdges
// additionally guards on a DOM before scheduling, so this only ever runs in a
// real browser context.
const runWhenIdle =
  typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : typeof setTimeout === 'function'
      ? (fn) => setTimeout(fn, 0)
      : (fn) => { fn(); };

// Build the THREE.Group from the (worker- or main-thread-produced) per-mesh typed
// arrays + the occt assembly hierarchy. Shared verbatim by both engines so the
// returned Group — geometry, materials, per-part userData, structural registry,
// and deferred edge overlays — is byte-for-byte identical no matter which engine
// parsed the STEP.
//
// PURE + HEADLESS-SAFE (issue #108): imports only `three` and never touches
// `window`/`document`/CDN, so it runs under Node. The only browser-specific step
// is the deferred edge overlay (scheduleEdges), which no-ops without a DOM.
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
/**
 * Build the THREE.Group (one Mesh per solid, per-part userData, non-enumerable
 * `parts`/`tree` registries, deferred edge overlays) from either engine's
 * per-mesh arrays plus the occt assembly hierarchy. Pure + headless-safe.
 * @param {OcctMesh[]} meshes - Repacked per-mesh typed arrays (one per solid).
 * @param {OcctNode | null} root - The sanitized occt assembly hierarchy, or null.
 * @param {EdgeStyle} [edgeStyle] - Feature-edge overlay stroke; defaults to the
 *   original faint line so an omitted argument is byte-for-byte unchanged.
 * @param {() => void} [onEdgesReady] - Called after each mesh's edge overlay is
 *   built in its idle slot (the app requests a redraw); no-op when omitted.
 * @returns {THREE.Group} A group of shaded meshes ready to add to the scene.
 */
export function buildGroupFromOcctResult(meshes, root, edgeStyle = { color: 0x0a0d12, opacity: 0.35 }, onEdgesReady) {
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
      .filter((c) => /** @type {any} */ (c).isMesh)
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

// Sum triangles across every Mesh in the group. Skips the decorative edge
// LineSegments (lines, not tris) and any non-mesh child: indexed geometry counts
// index/3, otherwise position-count/3. Moved here (issue #108) so the loader's
// edge-skip guard and the model-info HUD share ONE triangle counter and can never
// drift; the app imports it from this module instead of keeping a local copy.
/**
 * Sum triangles across every Mesh in the group (index.count/3 when indexed, else
 * position.count/3), skipping decorative edge LineSegments and non-mesh children.
 * @param {THREE.Object3D} group - Root object to traverse.
 * @returns {number} Total triangle count, rounded to an integer.
 */
export function countTriangles(group) {
  let tris = 0;
  group.traverse((/** @type {any} */ obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const g = obj.geometry;
    if (g.index) tris += g.index.count / 3;
    else if (g.attributes.position) tris += g.attributes.position.count / 3;
  });
  return Math.round(tris);
}

// Repack one raw occt result mesh (nested `attributes.position.array` shape the
// engine returns) into the flat { position, normal, index, color, name } typed-array
// shape buildGroupFromOcctResult consumes. This is the exact structure the parse
// worker transfers back to the main thread (see step.worker.js), so the group is
// built from a byte-for-byte-identical input regardless of engine. Lives here in the
// pure core (issue #108/#109) so both the browser main-thread loader (src/step.js)
// and the headless parse test import ONE repack and can't drift. Node-safe: only
// Float32Array/Uint32Array, no browser globals.
/**
 * Repack one raw occt result mesh (nested `attributes.*.array` shape) into the
 * flat {@link OcctMesh} typed-array shape {@link buildGroupFromOcctResult}
 * consumes — the same structure the parse worker transfers back.
 * @param {any} rm - A raw occt result mesh from `occt.Read*File(...).meshes[i]`.
 * @returns {OcctMesh} The flat, typed-array repacked mesh.
 */
export function repackResultMesh(rm) {
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

// Triangle count for a single geometry, matching how the app counts tris
// elsewhere (index.count/3 when indexed, else position.count/3 — see
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
//
// HEADLESS GUARD (issue #108): the overlay is browser-only polish. When there is
// no DOM (a Node import that calls buildGroupFromOcctResult for a geometry check),
// skip scheduling entirely so nothing runs off a background timer in a headless
// context — the shaded meshes are built exactly as in the browser; they just go
// without the decorative edge lines. In a real browser `document` is defined, so
// this is a no-op guard and browser behaviour is byte-for-byte unchanged.
function scheduleEdges(mesh, geometry, edgeStyle, onEdgesReady) {
  if (typeof document === 'undefined') return;
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
