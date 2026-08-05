// STEP loader core — parses STEP (ISO 10303) into three.js geometry via
// occt-import-js (OpenCascade compiled to WebAssembly).
//
// occt-import-js ships as a UMD/global factory (not an ES module), so we inject
// it as a classic <script> and then call the exposed `occtimportjs` factory,
// pointing `locateFile` at the CDN so the sibling .wasm resolves correctly.

import * as THREE from 'three';

const OCCT_VERSION = '0.0.23';
const OCCT_BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;

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
export async function initOcct() {
  if (!occtPromise) {
    occtPromise = loadOcctFactory().then((factory) =>
      factory({ locateFile: (path) => OCCT_BASE + path })
    );
  }
  return occtPromise;
}

// Parses a STEP file (as an ArrayBuffer / TypedArray) and returns a THREE.Group
// of Meshes. Throws on parse failure so callers can handle it.
export async function loadStepFromArrayBuffer(buf) {
  const occt = await initOcct();
  const fileBuffer = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  const result = occt.ReadStepFile(fileBuffer, null);
  if (!result || !result.success) {
    throw new Error('occt ReadStepFile failed to parse the STEP data');
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

    const material = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.35,
      roughness: 0.5,
      side: THREE.DoubleSide,
    });

    group.add(new THREE.Mesh(geometry, material));
  }

  return group;
}
