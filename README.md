# STEP Viewer Demo

A zero-build, browser-based viewer for **STEP** (ISO 10303) CAD models — rendered with
[three.js](https://threejs.org) and parsed with
[occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade compiled to
WebAssembly). No bundler, no `npm install`: it's plain ES modules loaded from a CDN, so
you serve the folder and it runs.

## What it does

- Loads a bundled **sample gallery** of STEP models with one click.
- **Open your own** `.step` / `.stp` file via the picker or by dragging it anywhere onto
  the window.
- Parses the B-rep with occt-import-js (WASM) and renders the resulting meshes with
  three.js — orbit / pan / zoom via `OrbitControls`.
- Viewer polish: camera auto-fits to the model, a **wireframe** toggle (button or `W`
  key), a loading spinner while parsing, and a non-blocking error toast on bad input.

## Live demo

**https://aatchison.github.io/step-viewer-demo/**

## Screenshot

> **Note:** a rendered screenshot (`docs/screenshot.png`) is not yet committed — capturing
> one needs a browser/WebGL context, which this build environment lacks. See
> [`docs/screenshot.md`](docs/screenshot.md) for what the loaded viewer shows and how to
> capture the image locally. (No broken image link is embedded here on purpose.)

## Run locally

It's a static site — serve the folder with any web server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(occt-import-js loads its WASM over the network, so a plain `file://` open won't work —
use a server.)

## Supported formats

- **STEP** — `.step` and `.stp` (ISO 10303, AP203 / AP214 / AP242), the formats
  occt-import-js reads. Both extensions are accepted by the picker and drag-and-drop.

Other CAD formats (IGES, BREP, STL, OBJ) are out of scope for this demo.

## Feature train

| # | Feature | Status |
|---|---------|--------|
| 1 | Project scaffold — three.js scene, OrbitControls, lighting | ✅ |
| 2 | STEP loader core — occt-import-js WASM → three.js meshes | ✅ |
| 3 | File upload — drag-and-drop / picker for `.step`/`.stp` | ✅ |
| 4 | Sample gallery — bundled sample models, one-click load | ✅ |
| 5 | Viewer polish — auto-fit camera, wireframe toggle, spinner, error toast | ✅ |
| 6 | Docs — usage, screenshot, credits, live demo link | ✅ |

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
