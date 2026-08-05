# Screenshot placeholder

A rendered screenshot (`docs/screenshot.png`) of a loaded STEP model is not yet
committed — this build environment has no browser/WebGL available to capture one.

To generate it yourself:

```bash
python3 -m http.server 8000
# open http://localhost:8000, let the "Cube" sample load, then take a screenshot
# and save it as docs/screenshot.png
```

What you'll see: the bundled `sample.step` model (7 meshes, ~4k vertices, verified
to parse via occt-import-js) rendered on a dark grid, with the header controls
(Wireframe toggle, "Open STEP file…") and the sample gallery strip along the bottom.

Once `docs/screenshot.png` exists, swap the note in `README.md` for:

```markdown
![STEP Viewer showing a loaded sample model](docs/screenshot.png)
```
