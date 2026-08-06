# STEP Viewer Demo

A zero-build, browser-based viewer for **STEP** (ISO 10303) CAD models — rendered with
[three.js](https://threejs.org) and parsed with
[occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade compiled to
WebAssembly). No bundler, no `npm install`: it's plain ES modules loaded from a CDN, so
you serve the folder and it runs.

## What it does

- Loads a bundled **sample gallery** of STEP (and an IGES) model with one click.
- **Open your own** `.step` / `.stp` / `.iges` / `.igs` / `.brep` / `.brp` file via the
  picker or by dragging it anywhere onto the window — the loader routes each format to the
  matching occt-import-js reader (STEP / IGES / BREP).
- Parses the B-rep with occt-import-js (WASM) and renders the resulting meshes with
  three.js — orbit / pan / zoom via `OrbitControls`.
- Viewer polish: camera auto-fits to the model, a **wireframe** toggle (button or `W`
  key), a loading spinner while parsing, and a non-blocking error toast on bad input.
- **Keyboard-navigable camera** — Tab to the 3D view and drive orbit / zoom / pan
  entirely from the keyboard (see below), so the viewer is usable without a mouse.

## Keyboard controls

Most shortcuts work anywhere on the page. The **camera keys** are scoped to the 3D
view — `Tab` to it first (it shows a focus ring), then:

| Key | Action |
|-----|--------|
| `←` `→` `↑` `↓` | Orbit the camera (~5° per press) — Left/Right azimuth, Up/Down polar |
| `+` `−` | Zoom (dolly) the camera in / out, clamped to the fit bounds |
| `Shift` + arrows | Pan the view target |
| `Home` | Re-fit / reset the view |

Global shortcuts (work regardless of focus): `1`–`5` load the gallery samples,
`W` toggles wireframe, `F` / `R` fit the view, `?` opens the shortcuts help.

## Live demo

**https://aatchison.github.io/step-viewer-demo/**

## Screenshot

![STEP Viewer showing the bundled "Gear" sample rendered on a dark grid, with the header controls (Wireframe toggle, Fit view, "Open STEP file…"), an orientation gizmo and model-info card top-right, and the sample gallery strip along the bottom](docs/screenshot.png)

*The bundled `Gear` sample (2,696 tris, 52.0 × 52.0 × 20.0) loaded at a 1440×900 desktop
viewport. Pick another model from the gallery strip, drag in your own STEP / IGES / BREP
file, and orbit / pan / zoom with the mouse.*

## Run locally

It's a static site — serve the folder with any web server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(occt-import-js loads its WASM over the network, so a plain `file://` open won't work —
use a server.)

## Development / CI

The **site stays zero-build** — `index.html` loads three.js and occt-import-js from a
CDN via an importmap, and nothing here is bundled or shipped. Everything under
`package.json` / `node_modules` is **dev-only**: it exists so the sample-parse tests can
run the exact same occt-import-js engine (pinned to the CDN version) in Node.

```bash
npm ci               # install the dev-only test + typecheck dependencies
npm test             # run the node:test sample-parse regression suite (no browser)
npm run typecheck    # tsc --noEmit: JSDoc + checkJs across the split modules (no output)
```

`npm run typecheck` is **dev-only static type-checking** (issue #111): the ES
modules under `src/` are annotated with JSDoc `@param`/`@returns`/`@throws` and
topped with `// @ts-check`, and `tsc --noEmit` (config in `tsconfig.json`) catches
parameter/shape mismatches across the split files. It **emits no JavaScript** — the
shipped `index.html` / `src/*.js` are byte-for-byte unchanged and the site stays
zero-build. (three@0.160.0 doesn't bundle its own `.d.ts`, so three's types come
from the pinned `@types/three@0.160.0` devDependency — the same version as the CDN
runtime engine.)

A GitHub Actions workflow runs `npm ci`, then `npm test` and `npm run typecheck`, on
every push / PR to `main` (Node 20, `ubuntu-latest`, read-only `GITHUB_TOKEN` via
`permissions: contents: read`).

**Note:** this commit only *proposes* the workflow. The automation token that opened the
PR lacks GitHub's `workflow` scope — and GitHub refuses any push that touches
`.github/workflows/` without it — so the ready-to-run file ships at
[`.github/workflows-proposed/ci.yml`](.github/workflows-proposed/ci.yml). A **maintainer
with `workflow` scope enables it** by moving it into place:

```bash
git mv .github/workflows-proposed/ci.yml .github/workflows/ci.yml
git commit -m "ci: enable workflow" && git push
```

## Supported formats

occt-import-js bundles readers for three CAD formats, and the viewer dispatches on the
file extension to the matching one:

- **STEP** — `.step` / `.stp` (ISO 10303, AP203 / AP214 / AP242).
- **IGES** — `.iges` / `.igs`.
- **BREP** — `.brep` / `.brp` (OpenCascade native).

All six extensions are accepted by the picker and drag-and-drop; an unrecognized
extension is rejected up front with a hint rather than a failed parse. Other CAD formats
(STL, OBJ, …) are out of scope for this demo.

## Architecture

The viewer is a **zero-build** static site: `index.html` declares an
[importmap](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap)
that points `three` and `three/addons/` at the [jsDelivr](https://www.jsdelivr.com/)
CDN (pinned to `three@0.160.0` — the addons load from the *same* version's
`examples/jsm/` path), then loads `src/main.js` as an ES module. There is no
bundler, no transpile step, and nothing under `node_modules` ships — you serve the
folder and the browser resolves every import over the network.

`index.html` also carries the whole UI shell: all page markup, the entire inline
`<style>` (design tokens, layout, the light/dark theme, gizmo/HUD chrome), and the
importmap + entry `<script>`. The behaviour lives in a small set of ES modules
under `src/`, split so the pure geometry logic can be type-checked and unit-tested
outside a browser:

| File | Role |
|------|------|
| `index.html` | Markup, inline `<style>`, importmap, and the `<script type="module" src="./src/main.js">` entry point. |
| `src/main.js` | The app orchestrator: builds the three.js scene, lighting/IBL (`RoomEnvironment`), `OrbitControls`, the orientation gizmo (`ViewHelper`) + model-info HUD, the sample gallery, the loader/spinner/status UI, keyboard shortcuts, the help/About dialogs, and all error routing (engine panel vs. toast). |
| `src/step.js` | Browser-only CAD loader **orchestrator**: owns the occt engine lifecycle — a Web Worker (`src/step.worker.js`) with a transparent main-thread fallback — the file-extension→reader dispatch, `initOcct()` / `resetOcct()`, and `loadCadFromArrayBuffer()`. |
| `src/step.worker.js` | Classic Web Worker that `importScripts()` the occt UMD build from the CDN and runs the parse off the main thread, so a dense part never freezes orbit/UI. |
| `src/step-core.js` | The **pure, node-importable** half: `buildGroupFromOcctResult()` (per-mesh typed arrays → `THREE.Group`), `repackResultMesh()`, `countTriangles()`, and the `SAMPLES` gallery manifest. Imports only `three`; touches no `window`/`document`/CDN. |
| `src/scene.js` | Pure geometry helpers — finiteness guards, part counting, GPU teardown (`disposeGroup`), and the aspect-aware fit-distance math shared by Fit / view presets. |
| `src/ui.js` | Pure text/number formatters, the accepted-extension gate (`CAD_EXT_RE`), and `describeError()` — the cause-worded error copy keyed off `err.kind`. |
| `src/i18n.js` | The localization table and `t()` / `applyStaticI18n()`. |

> **Note (docs vs. code):** earlier rounds shipped as a literal two files
> (`index.html` + `src/step.js`). The loader has since been split into the modules
> above (pure core extracted for headless tests in #108, off-thread parse in the
> worker) — this section documents the code as it stands today.

## How STEP becomes a mesh

The path from raw CAD bytes to shaded triangles, end to end:

1. **Engine bootstrap.** occt-import-js ships as a UMD/global factory, not an ES
   module. `initOcct()` (in `src/step.js`) loads it — off the main thread it lives
   in `src/step.worker.js`, which `importScripts()` the CDN build; if the worker
   can't init or crashes, `step.js` transparently falls back to injecting the same
   occt `<script>` on the main thread. Either way the factory is called with
   **`locateFile`** pointed at the CDN `dist/` dir so the sibling `.wasm` resolves
   next to the `.js`. The resulting engine promise is **cached** — the ~10–15 s
   first-load cost is paid once — and is **resettable via `resetOcct()`** so the
   Retry button can start a genuinely fresh attempt after a stall.
2. **Read.** The file extension is mapped to the matching occt reader
   (`ReadStepFile` / `ReadIgesFile` / `ReadBrepFile`); all three return the same
   `{ success, meshes, root }` shape, so everything downstream is
   format-agnostic. `result.meshes[]` is the flat list of per-solid meshes.
3. **Repack + transfer.** `repackResultMesh()` (in `src/step-core.js`) flattens
   each raw mesh's nested `attributes.position.array` / `attributes.normal.array`
   / `index.array` / `color` into plain `Float32Array` / `Uint32Array` — the exact
   structured-clone-safe shape the worker zero-copy-transfers back to the main
   thread. Both engines hand `buildGroupFromOcctResult()` the identical input, so
   the built group is byte-for-byte the same no matter which engine parsed.
4. **Build the group.** `buildGroupFromOcctResult()` makes **one `THREE.Mesh` per
   result mesh** (== one solid — preserving assembly identity for the Parts panel).
   For each: `position` / `normal` map onto a `THREE.BufferGeometry`'s attributes,
   `index.array` sets the index, and `color` (RGB 0..1, defaulting to the accent
   blue) drives a `MeshStandardMaterial`. **Normals are computed** with
   `geometry.computeVertexNormals()` **only when the engine supplied none**.
5. **Deferred feature edges.** Crisp mechanical edges come from
   `EdgesGeometry(geometry, 30)` — a **30° crease threshold** keeps real feature
   edges while smooth fillets stay clean. Because `EdgesGeometry` walks every
   triangle, it's the most expensive app-side step, so it's **deferred to an idle
   slot** (`requestIdleCallback`, falling back to `setTimeout`) *after* the shaded
   mesh is already on screen; the edges pop in a beat later. A liveness guard skips
   the work if the model was swapped out first, and meshes above a triangle ceiling
   skip the overlay entirely.

## Error handling

Every loader error is tagged with a **cause** on `err.kind` at its throw site, so
the UI can word and route it by *why* it failed rather than blaming "parse" for an
engine or network problem:

| `err.kind` | Cause | UI routing |
|-----------|-------|-----------|
| `init` | occt/WASM engine or CDN download failure (worker or main thread), or a first-load **stall** | **Persistent** inline engine panel with a **Retry** button (Retry calls `resetOcct()` then re-runs the last attempt). |
| `http` | A `fetch`/HTTP status failure pulling the file bytes | **Transient** toast (auto-dismisses). |
| `parse` | The engine ran but the bytes weren't valid CAD for the reader | **Transient** toast. |

(Two finer tags also exist — `empty` for a parse that yields no renderable
geometry and `degenerate` for non-finite/NaN vertices — both routed to the toast.)
The dispatch is intentionally simple: `err.kind === 'init'` gets the persistent
panel, everything else gets a self-dismissing toast (see `src/main.js`). The
cause-worded copy lives in `describeError()` in `src/ui.js`. **Preserve this
taxonomy** when adding a code path that can fail — tag the throw with the right
`kind` so it lands on the correct surface.

## Extending it

**Add a bundled sample.** Drop a `.step` (or any occt-readable) file under
`samples/`, then add one entry to the `SAMPLES` array in `src/step-core.js`:

```js
{ file: 'widget.step', labelKey: 'sampleWidget', reader: 'ReadStepFile' },
```

`SAMPLES` is the single source of truth — the gallery, the deep-link handler, and
the parse regression test all read it, so there's nothing else to wire up. Add the
matching `labelKey` string to `src/i18n.js`. Note the number-key shortcuts map
**by position**: `1`–`5` load the first five gallery entries in order, so a new
sample is reachable via its slot without extra code.

**Add another OCCT format.** occt-import-js already bundles readers beyond STEP, so
supporting, say, IGES-only builds or a new occt reader is mostly wiring, not
parsing. To surface a format the demo didn't expose, you'd update three spots that
gate on the extension:

- `READER_BY_EXT` in `src/step.js` — map the new extension to its `Read*File`
  method (IGES is already `ReadIgesFile`).
- `CAD_EXT_RE` in `src/ui.js` — the regex the drag-drop guard and file-picker
  reject path both test against.
- The `accept="…"` filter on the `#file-input` element in `index.html`.

The mesh-build path (`repackResultMesh` → `buildGroupFromOcctResult`) is already
format-agnostic — every reader returns the same `{ success, meshes, root }` shape —
so no conversion code changes. (IGES and BREP are in fact *already* wired through
all three spots; they're the worked example.)

**Out of scope, honestly.** Formats OCCT doesn't read (STL, OBJ, glTF import, …)
are deliberately not supported — adding them would mean a second parser and a
second mesh-build path, which is more than this demo aims to be. Export *to* `.glb`
exists (via three's `GLTFExporter`); import from other ecosystems does not.

## Feature train

| # | Feature | Status |
|---|---------|--------|
| 1 | Project scaffold — three.js scene, IBL lighting, OrbitControls | ✅ |
| 2 | CAD loader core — occt-import-js WASM → three.js meshes (STEP/IGES/BREP) | ✅ |
| 3 | File input — drag-and-drop / picker across all supported extensions | ✅ |
| 4 | Sample gallery — bundled models, one-click / number-key load | ✅ |
| 5 | Viewer polish — auto-fit camera, wireframe, gizmo + HUD, material presets | ✅ |
| 6 | Robustness — off-thread parse worker, engine-error panel + Retry, error toasts | ✅ |
| 7 | A11y & i18n — keyboard-navigable camera, shortcuts/help, localized UI | ✅ |
| 8 | Dev tooling — node parse tests + JSDoc typecheck (zero-build preserved) | ✅ |
| 9 | Docs — usage, architecture, STEP→mesh pipeline, extension guide, credits | ✅ |

See [Architecture](#architecture), [How STEP becomes a mesh](#how-step-becomes-a-mesh),
and [Extending it](#extending-it) above for how these fit together.

## Credits

This demo stands on two open-source projects:

- **[three.js](https://threejs.org)** — WebGL 3D rendering
  ([source](https://github.com/mrdoob/three.js),
  [MIT License](https://github.com/mrdoob/three.js/blob/dev/LICENSE)).
- **[occt-import-js](https://github.com/kovacsv/occt-import-js)** — STEP/IGES import via
  OpenCascade compiled to WebAssembly
  ([MIT License](https://github.com/kovacsv/occt-import-js/blob/main/LICENSE.md)). It
  wraps **[Open CASCADE Technology](https://dev.opencascade.org/)**, which is licensed
  under the
  [LGPL-2.1 with an additional exception](https://dev.opencascade.org/resources/licensing).

Both libraries are loaded at runtime from the [jsDelivr](https://www.jsdelivr.com/) CDN.

## License

MIT — see [LICENSE](./LICENSE).
