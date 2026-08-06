// STEP parse worker — runs occt-import-js (OpenCascade → WebAssembly) off the
// main thread so orbit/gizmo/UI stay responsive while a dense CAD part decodes.
//
// This is a CLASSIC worker (created with `new Worker(url)` — no { type: 'module' }),
// which is what lets it `importScripts()` the occt-import-js UMD/global factory
// straight from the CDN. That's the same script the main thread used to inject as a
// classic <script>, so the whole thing stays zero-build.
//
// Message protocol (main ⇄ worker):
//   main → { type: 'init', base }          load + init the WASM engine once
//   worker → { type: 'ready' }             engine initialized (cache this on main)
//   worker → { type: 'init-error', message }   importScripts / WASM / CDN failure
//   main → { type: 'parse', id, buffer }   parse these STEP bytes (buffer transferred)
//   worker → { type: 'result', id, meshes }    per-mesh typed arrays (transferred back)
//   worker → { type: 'parse-error', id, message }   engine ok, bytes were not valid STEP
//
// The base URL (CDN + OCCT_VERSION) is passed in from the main thread on 'init' so
// the version lives in exactly one place (src/step.js), never drifting from a copy
// duplicated here.

let occt = null;

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === 'init') {
    // Idempotent: a second 'init' after a successful one just re-confirms ready.
    if (occt) {
      self.postMessage({ type: 'ready' });
      return;
    }
    try {
      // importScripts is synchronous and throws on a network/parse failure — both
      // land in this catch and are reported as an engine (init) failure.
      importScripts(msg.base + 'occt-import-js.js');
      // occt-import-js is an Emscripten MODULARIZE UMD: `var occtimportjs = …`.
      // Loaded via importScripts that top-level `var` becomes a property of the
      // worker global, so it's reachable as self.occtimportjs; resolve it
      // defensively (self property → bare global binding → globalThis) so a quirk
      // in how any engine exposes the top-level var can't strand a working factory.
      const factory =
        self.occtimportjs ||
        (typeof occtimportjs !== 'undefined' ? occtimportjs : undefined) ||
        (typeof globalThis !== 'undefined' ? globalThis.occtimportjs : undefined);
      if (typeof factory !== 'function') {
        throw new Error('occt-import-js loaded but did not expose a factory');
      }
      // Point locateFile at the same CDN dir so the sibling .wasm resolves.
      occt = await factory({ locateFile: (path) => msg.base + path });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'init-error', message: errMessage(err) });
    }
    return;
  }

  if (msg.type === 'parse') {
    const { id, buffer } = msg;
    try {
      const fileBuffer = new Uint8Array(buffer);
      const result = occt.ReadStepFile(fileBuffer, null);
      if (!result || !result.success) {
        // Engine loaded fine but the bytes weren't valid/parseable STEP.
        self.postMessage({
          type: 'parse-error',
          id,
          message: 'occt ReadStepFile failed to parse the STEP data',
        });
        return;
      }

      // Repack each mesh's geometry into transferable typed arrays. occt returns
      // plain JS number arrays, so the Float32Array/Uint32Array.from() step copies
      // once here — but the resulting .buffer is handed to the transfer list below,
      // so the trip back to the main thread is zero-copy (no structured clone of
      // the bytes in either direction).
      const meshes = [];
      const transfer = [];
      for (const rm of result.meshes) {
        const position = Float32Array.from(rm.attributes.position.array);
        transfer.push(position.buffer);

        let normal = null;
        if (rm.attributes.normal && rm.attributes.normal.array) {
          normal = Float32Array.from(rm.attributes.normal.array);
          transfer.push(normal.buffer);
        }

        let index = null;
        if (rm.index && rm.index.array) {
          index = Uint32Array.from(rm.index.array);
          transfer.push(index.buffer);
        }

        let color = null;
        if (rm.color && rm.color.length >= 3) {
          color = Float32Array.from([rm.color[0], rm.color[1], rm.color[2]]);
          transfer.push(color.buffer);
        }

        meshes.push({ position, normal, index, color, name: rm.name || '' });
      }

      self.postMessage({ type: 'result', id, meshes }, transfer);
    } catch (err) {
      // A throw from ReadStepFile is still a bad-bytes / parse-side failure.
      self.postMessage({ type: 'parse-error', id, message: errMessage(err) });
    }
  }
};

function errMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
