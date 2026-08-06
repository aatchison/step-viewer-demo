# Contributing to STEP Viewer Demo

Thanks for helping out! This project is a **zero-build static site** — plain ES
modules loaded from a CDN, served straight from the folder. That constraint is
the whole point of the demo, so most of this guide is about staying inside it.

## Table of contents

- [Local development](#local-development)
- [Zero-build ground rules](#zero-build-ground-rules)
- [Adding a sample](#adding-a-sample)
- [Bumping a dependency](#bumping-a-dependency)
- [Testing before a PR](#testing-before-a-pr)
- [PR conventions](#pr-conventions)

## Local development

There is **no install step and no build step**. Clone the repo and serve the
folder over HTTP with any static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Open `http://localhost:8000` (not the file directly). A plain `file://` open
**will not work**: occt-import-js fetches its `.wasm` binary over the network
relative to the page, and browsers block those cross-origin/opaque `file://`
fetches — the engine never initializes and you get the engine-error panel. Any
HTTP server fixes it; `python3 -m http.server` is just the zero-dependency
default.

> The `npm ci` / `npm test` / `npm run typecheck` commands in the README are
> **dev-only** (headless parse tests + JSDoc typechecking that run the same
> pinned occt engine under Node). They are **not** required to run the site and
> emit nothing into it — nothing under `node_modules` ever ships.

## Zero-build ground rules

These are hard constraints. A change that breaks any of them is out of scope for
this repo, no matter how small:

- **ES modules only.** `index.html` loads `src/main.js` as
  `<script type="module">`; the modules under `src/` `import` each other and
  `three` by name. No CommonJS, no `require`.
- **Dependencies come from the importmap / CDN.** Runtime libraries are pinned
  in the `<script type="importmap">` in `index.html` (three) and in
  `src/step.js` (occt-import-js), and resolved from the jsDelivr CDN at runtime.
  **No new runtime `node_modules` dependencies, no bundler, no transpile step.**
- **It must run as static files on GitHub Pages.** If a change needs a server,
  a build, or a backend, it does not belong here. `python3 -m http.server` and
  GitHub Pages serve the exact same bytes that are in the repo.
- **Inline `<style>` and `<script>` in `index.html` are intentional.** The whole
  UI shell — page markup, all CSS (design tokens, layout, light/dark theme,
  gizmo/HUD chrome), the importmap, and the entry `<script>` — lives inline in
  `index.html` on purpose. Keep it there; don't split the CSS out into a
  separate file or add a stylesheet `<link>`.

## Adding a sample

Bundled models live under [`samples/`](samples/) and are surfaced by the gallery
strip and the `1`–`5` number-key shortcuts.

1. **Drop the file in `samples/`** — e.g. `samples/widget.step` (`.step` /
   `.stp`, `.iges` / `.igs`, or `.brep` / `.brp` — the format occt can read).
   Keep it small so first load stays quick.
2. **Register it in the `SAMPLES` array** in
   [`src/step-core.js`](src/step-core.js). Each entry is
   `{ file, labelKey, reader }`:
   - `file` — the on-disk name under `samples/`.
   - `labelKey` — an i18n key, **not** a literal label. Add the display string
     for that key to **every** locale table in
     [`src/i18n.js`](src/i18n.js) (e.g. `sampleWidget: 'Widget'`).
   - `reader` — the occt method for the format: `ReadStepFile`,
     `ReadIgesFile`, or `ReadBrepFile` (must match the file's extension).
3. **Verify it parses.** Load the site and click the new sample, or run the
   headless parse test (`npm test`) — it reads the same `SAMPLES` list, so a new
   entry is covered automatically.
4. **Keep the gallery small.** The number-key shortcuts map `1`–`5` to the first
   five samples (`SAMPLES[0..4]` in `src/main.js`). Adding a sixth sample means
   it has no number-key shortcut — keep the gallery to **at most five** entries
   (or update the shortcut range and the README/help copy together).

## Bumping a dependency

Versions are pinned in **two** places — update both, plus anything that echoes
the version in the UI or docs:

- **three.js** — the `<script type="importmap">` in `index.html`
  (`three@0.160.0`). The addons (`three/addons/`) load from the **same**
  version's `examples/jsm/` path, so bump both importmap lines together. The
  dev-only `@types/three` in `package.json` should track the same version.
- **occt-import-js** — the `OCCT_VERSION` constant at the top of
  [`src/step.js`](src/step.js) (currently `'0.0.23'`). It's the single source of
  truth — the worker and the main-thread fallback both derive the CDN base from
  it, so change it here only.

The UI reads these versions live (three from `THREE.REVISION`, occt from the
`OCCT_VERSION` export) rather than hardcoding them, so a bump flows into the
About dialog automatically. Still, **update the code and any version mentioned
in the README together** so the docs never drift from the pinned runtime.

## Testing before a PR

There's no browser test harness — run this **manual checklist** locally
(`python3 -m http.server 8000`) before opening a PR:

- [ ] **Every sample loads.** Click through the gallery (or press `1`–`5`); each
      renders without an error toast.
- [ ] **Drag-and-drop.** Drop a `.step` / `.iges` / `.brep` file anywhere on the
      window — it loads. Drop an unsupported extension — it's rejected with a
      hint, not a failed parse.
- [ ] **Wireframe toggle.** The button and the `W` key both flip wireframe.
- [ ] **Fit / reset.** `F` / `R` / `Home` and double-click re-fit the camera to
      the model.
- [ ] **Resize / orientation.** Resize the window and rotate a device — the
      canvas aspect-fits and the HUD/gizmo stay in the top-right. Sanity-check
      narrow widths (360 / 390), tablet (768), and desktop (1440).
- [ ] **Offline behavior.** Block the network (DevTools → offline) and reload —
      the engine fails to init and you get the **persistent engine-error panel
      with a Retry** button (not a toast). Restore the network and Retry
      recovers.
- [ ] **Reduced motion.** With `prefers-reduced-motion: reduce` set (OS setting
      or DevTools emulation), transitions/animations are suppressed and the app
      still works.
- [ ] **Keyboard a11y.** `Tab` to the 3D view (focus ring shows), drive orbit /
      zoom / pan from the keyboard, and `?` opens the shortcuts help.

If you touched `src/`, also run the dev-only checks (`npm test` and
`npm run typecheck`) — they don't change the shipped site.

## PR conventions

- **Stay zero-build.** Re-read [the ground rules](#zero-build-ground-rules). No
  bundler, no transpile, no new runtime `node_modules` dependency, nothing that
  needs a server or backend.
- **Preserve accessibility.** Keep the `aria-live` regions, `:focus-visible`
  focus rings, and `prefers-reduced-motion` handling intact — verify with the
  keyboard and reduced-motion checklist items above.
- **Preserve the `err.kind` error taxonomy.** Any new code path that can fail
  must tag its throw with the right `err.kind` (`init` → persistent engine panel
  + Retry; `http` / `parse` / `empty` / `degenerate` → transient toast) so it
  lands on the correct surface. See the *Error handling* table in the README.
- **Update docs alongside code.** If you change behavior, shortcuts, versions,
  or the sample set, update the README (and this file / the in-app help) in the
  same PR so they never drift.
- **No CI/tooling assumptions.** Don't add workflows, hooks, or config that
  isn't already in the repo. Markdown and static files only.
