// Scene / geometry utilities extracted from the app's main module (issue #107).
// These are pure, dependency-free helpers for reasoning about a loaded model's
// geometry (finiteness guards, triangle / part counting, GPU teardown) and for
// the aspect-aware fit-distance math shared by Fit, the named-view presets, and
// fit-to-selection. Kept free of any renderer/scene closure state so they can be
// imported and unit-tested in isolation; the caller passes in the THREE objects
// (Box3/Vector3 built by the caller, the camera for fit math).

// Finiteness guards for degenerate geometry (issue #98). A partial/malformed
// parse can report success yet carry NaN/±Infinity vertex positions; the
// resulting Box3 is NOT empty, so isEmpty() misses it. isFiniteVec checks a
// Vector3's three components; isFiniteBox checks a Box3's min/max corners (its
// own getSize/getCenter are then guaranteed finite too).
export function isFiniteVec(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

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
export function fitDistanceForRadius(radius, camera) {
  const fovV = camera.fov * Math.PI / 180;
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
  const distV = radius / Math.sin(fovV / 2);
  const distH = radius / Math.sin(fovH / 2);
  return Math.max(distV, distH) * 1.18;
}

// Sum triangles across every Mesh in the group. Skips the decorative edge
// LineSegments (lines, not tris) and any non-mesh child: indexed geometry counts
// index/3, otherwise position-count/3.
export function countTriangles(group) {
  let tris = 0;
  group.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const g = obj.geometry;
    if (g.index) tris += g.index.count / 3;
    else if (g.attributes.position) tris += g.attributes.position.count / 3;
  });
  return Math.round(tris);
}

// Count the solids (mesh children) in a group — used to note part count in the
// HUD while color-by-part is active. The edge overlay is a child of each mesh,
// not of the group, so group.children are exactly the solids.
export function countParts(group) {
  if (!group) return 0;
  return group.children.filter((c) => c.isMesh).length;
}

// Free the GPU resources held by a THREE.Group of Meshes.
export function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => m.dispose());
    }
  });
}
