# STEP Viewer Demo

A zero-build, browser-based viewer for **STEP** (ISO 10303, `.step`/`.stp`) CAD models —
rendered with [three.js](https://threejs.org) and parsed with
[occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade compiled to WebAssembly).

> **Status:** built incrementally via a merge train of feature PRs. This baseline renders a
> placeholder scene; STEP loading, file upload, a sample gallery, and viewer polish land as the
> train merges.

## Live demo

Once GitHub Pages finishes building: **https://aatchison.github.io/step-viewer-demo/**

## Run locally

It's a static site — serve the folder with any web server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(occt-import-js loads its WASM over the network, so a plain `file://` open won't work — use a server.)

## Feature train

| # | Feature |
|---|---------|
| 1 | Project scaffold — three.js scene, OrbitControls, lighting (this baseline) |
| 2 | STEP loader core — occt-import-js WASM → three.js meshes |
| 3 | File upload — drag-and-drop / picker for `.step`/`.stp` |
| 4 | Sample gallery — bundled sample models, one-click load |
| 5 | Viewer polish — auto-fit camera, wireframe toggle, spinner, error toast |
| 6 | Docs — usage, screenshot, credits |

## License

MIT — see [LICENSE](./LICENSE).
