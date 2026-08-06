// Regression test (issue #109): every bundled sample under ./samples/ must still
// parse and yield real geometry. Without this, a regenerated or corrupted sample
// would only surface when a human happened to load that pill in the browser — this
// catches it in CI with `npm test`, no browser required.
//
// occt-import-js is published to npm at the SAME version the site loads from the CDN
// (0.0.23, see index.html's importmap / src/step.js OCCT_VERSION), so the exact
// engine that runs in the browser parses the files here in Node. The geometry is
// then built through src/step-core.js's buildGroupFromOcctResult — the same pure
// transform the app uses — so a green test means the real load path produces
// triangles for every sample.
//
// Uses only the built-in node:test + node:assert (no test-framework dependency). The
// SAMPLES list, the occt→group repack, the group builder, and the triangle counter
// are all imported from src/step-core.js, so this test can't drift from the app.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import {
  SAMPLES,
  repackResultMesh,
  buildGroupFromOcctResult,
  countTriangles,
} from '../src/step-core.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const samplesDir = join(repoRoot, 'samples');

// The wasm sits next to the factory JS in the installed package's dist dir. Resolve
// the package entry through node's own resolver so this keeps working regardless of
// hoisting / install layout, then point occt's locateFile at that directory so it
// finds occt-import-js.wasm during init.
const occtFactory = require('occt-import-js');
const occtDistDir = dirname(require.resolve('occt-import-js'));

// Initialize the WASM engine ONCE for the whole file — init is the slow part and the
// engine is reusable across parses, exactly as the app keeps a single occt instance.
let occt;
before(async () => {
  occt = await occtFactory({
    locateFile: (path) => join(occtDistDir, path),
  });
});

// Sanity-check the shared list itself so an accidental empty/renamed manifest fails
// loudly rather than silently registering zero sample tests.
test('SAMPLES manifest is non-empty', () => {
  assert.ok(Array.isArray(SAMPLES) && SAMPLES.length > 0, 'SAMPLES must list at least one bundled model');
});

for (const sample of SAMPLES) {
  test(`parses ${sample.file} into geometry with triangles`, async () => {
    const reader = sample.reader || 'ReadStepFile';
    assert.equal(typeof occt[reader], 'function', `occt engine is missing reader ${reader}`);

    const bytes = new Uint8Array(await readFile(join(samplesDir, sample.file)));
    const result = occt[reader](bytes, null);

    assert.equal(result && result.success, true, `${sample.file}: ${reader} did not report success`);
    assert.ok(Array.isArray(result.meshes) && result.meshes.length > 0, `${sample.file}: engine returned no meshes`);

    // Build the THREE.Group through the app's real pure transform, feeding it the
    // same repacked mesh shape the browser worker/main-thread loader produces.
    const group = buildGroupFromOcctResult(result.meshes.map(repackResultMesh), result.root || null);

    const tris = countTriangles(group);
    assert.ok(tris > 0, `${sample.file}: expected triangles > 0, got ${tris}`);
  });
}
