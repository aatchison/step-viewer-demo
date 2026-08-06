// @ts-check
// Scene / geometry utilities extracted from the app's main module (issue #107).
// These are pure, dependency-free helpers for reasoning about a loaded model's
// geometry (finiteness guards, triangle / part counting, GPU teardown) and for
// the aspect-aware fit-distance math shared by Fit, the named-view presets, and
// fit-to-selection. Kept free of any renderer/scene closure state so they can be
// imported and unit-tested in isolation; the caller passes in the THREE objects
// (Box3/Vector3 built by the caller, the camera for fit math).

/** @typedef {import('three').Vector3} Vector3 */
/** @typedef {import('three').Box3} Box3 */
/** @typedef {import('three').PerspectiveCamera} PerspectiveCamera */
/** @typedef {import('three').Object3D} Object3D */
/** @typedef {import('three').Group} Group */

// Finiteness guards for degenerate geometry (issue #98). A partial/malformed
// parse can report success yet carry NaN/±Infinity vertex positions; the
// resulting Box3 is NOT empty, so isEmpty() misses it. isFiniteVec checks a
// Vector3's three components; isFiniteBox checks a Box3's min/max corners (its
// own getSize/getCenter are then guaranteed finite too).
/**
 * @param {Vector3} v - The vector to test.
 * @returns {boolean} `true` when x, y, and z are all finite numbers.
 */
export function isFiniteVec(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * @param {Box3} box - The bounding box to test.
 * @returns {boolean} `true` when the box is non-empty and both corners are finite.
 */
export function isFiniteBox(box) {
  return !box.isEmpty() && isFiniteVec(box.min) && isFiniteVec(box.max);
}

// Fit distance for a model of the given bounding radius at the current viewport
// aspect. Fit must respect the aspect ratio: a model as wide as it is tall
// overflows horizontally on portrait/narrow screens if we only satisfy the
// vertical FOV. Compute the distance for BOTH the vertical and horizontal FOV
// and take the larger, so the model fits in whichever dimension is tighter (the
// horizontal one when aspect < 1). The 1.18 is headroom padding. The named-view
// presets (applyView) and fit-to-selection frame at exactly this distance so
// only the direction differs.
/**
 * @param {number} radius - Bounding-sphere radius of the model to frame.
 * @param {PerspectiveCamera} camera - Camera supplying `fov` (degrees) and `aspect`.
 * @returns {number} Camera distance that fits the radius in whichever of the
 *   vertical/horizontal FOV is tighter, with 1.18× headroom padding.
 */
export function fitDistanceForRadius(radius, camera) {
  const fovV = camera.fov * Math.PI / 180;
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
  const distV = radius / Math.sin(fovV / 2);
  const distH = radius / Math.sin(fovH / 2);
  return Math.max(distV, distH) * 1.18;
}

// countTriangles moved to src/step-core.js (issue #108) so the CAD loader's
// edge-skip guard and the model-info HUD share ONE per-group triangle counter and
// can never drift; import it from there (main.js does).

// Count the solids (mesh children) in a group — used to note part count in the
// HUD while color-by-part is active. The edge overlay is a child of each mesh,
// not of the group, so group.children are exactly the solids.
/**
 * @param {Group | null | undefined} group - The loaded-model group, or nullish.
 * @returns {number} Count of direct mesh children (== solids), 0 when nullish.
 */
export function countParts(group) {
  if (!group) return 0;
  return group.children.filter((c) => /** @type {any} */ (c).isMesh).length;
}

// Free the GPU resources held by a THREE.Group of Meshes.
/**
 * Dispose every geometry and material held by the group's descendants, freeing
 * their GPU resources. Handles both single and array materials.
 * @param {Object3D} group - Root object whose subtree should be disposed.
 * @returns {void}
 */
export function disposeGroup(group) {
  group.traverse((obj) => {
    const o = /** @type {any} */ (obj);
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m.dispose());
    }
  });
}
