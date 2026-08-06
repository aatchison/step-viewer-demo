    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
    import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';
    import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
    import { loadCadFromArrayBuffer, readerForExtension, resetOcct } from './step.js';
    import { countTriangles, SAMPLES as SAMPLE_MANIFEST } from './step-core.js';
    import { t, applyStaticI18n } from './i18n.js';
    import {
      isFiniteVec, isFiniteBox, fitDistanceForRadius,
      countParts, disposeGroup,
    } from './scene.js';
    import {
      CAD_EXT_RE, extOf, fmtDim, fmtMB, roundSig,
      escapeAttr, captureBasename, describeError,
    } from './ui.js';

    // Populate all static markup strings from the localized table (and write the
    // resolved <html lang>, done at i18n.js import time). Runs before any JS
    // message builder below reads t(), and before the hint is composed, so the
    // whole UI renders in the chosen locale from first module execution.
    applyStaticI18n();

    // --- Offline / CDN-blip resilience (service worker) -----------------------
    // Every core dep loads from jsdelivr at runtime (three + addons, occt .js/
    // .wasm) and samples from the origin, so a reload while offline — or during a
    // transient CDN blip — would otherwise die on a blank engine-error panel. A
    // static, same-origin sw.js precaches the pinned URLs and serves them cache-
    // first (see sw.js), so a warm reload renders fully offline. Feature-detected
    // and guarded so it's a hard no-op where unsupported (file://, old browsers,
    // insecure contexts — navigator.serviceWorker only exists in a secure context)
    // and never allowed to throw into app startup. Registered on 'load' so it
    // doesn't contend with the initial multi-MB three.js + WASM download.
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
          console.warn('Service worker registration failed (offline cache disabled):', err);
        });
      });
    }

    // CAD_EXT_RE + extOf now live in ./ui.js (imported above).

    const app = document.getElementById('app');
    // Embed mode was resolved pre-paint by the head script (it added .embed to
    // <html> when the `embed` flag is present in the hash/query). Read it back
    // here so JS paths — the hash writer (keep the flag) and the copy-embed
    // action — can branch on it. The chrome hiding itself is pure CSS.
    const EMBED_MODE = document.documentElement.classList.contains('embed');
    // alpha:true so the canvas clears transparent — the page's radial-vignette
    // backdrop (CSS on html/body) shows through behind the model instead of a
    // flat opaque scene color, giving the scene depth.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    // Filmic tone mapping so the environment-lit metal highlights roll off
    // gracefully instead of clipping to flat white — key to reading curvature.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    // The orientation gizmo (ViewHelper) is drawn as a second overlay pass
    // after the main scene, so the renderer must not auto-clear between the two —
    // the render loop clears once up front instead.
    renderer.autoClear = false;
    app.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // No opaque scene.background: the canvas clears transparent (renderer alpha)
    // so the CSS radial-vignette backdrop reads through behind the model.
    const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1000);
    camera.position.set(3, 2.5, 4);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Make the touch gesture map explicit rather than relying on OrbitControls'
    // defaults (issue #105): one finger orbits, two fingers dolly + pan together
    // (DOLLY_PAN) so pinch-zoom and two-finger drag both work from the same
    // gesture. Documented in the help dialog's touch-gesture rows. OrbitControls
    // also sets touch-action:none on renderer.domElement so these gestures are
    // captured cleanly instead of triggering the browser's scroll / double-tap
    // zoom (the canvas CSS asserts the same, belt-and-braces).
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    // Image-based lighting: a prefiltered RoomEnvironment gives every surface a
    // soft studio reflection so curvature reads instead of a flat monochrome
    // fill. Built once at startup (RoomEnvironment is a tiny procedural scene, no
    // network fetch — stays zero-build) and assigned as scene.environment, which
    // all MeshStandardMaterials pick up automatically.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // Three-point-ish rig layered on top of the IBL: a warm key for primary
    // form, a cool fill to lift the shadow side without flattening, and a rim
    // from behind to separate the silhouette from the dark background.
    scene.add(new THREE.HemisphereLight(0xbdd7ff, 0x20242c, 0.5));
    const key = new THREE.DirectionalLight(0xfff2e0, 1.1);
    key.position.set(5, 8, 6); scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fc0ff, 0.35);
    fill.position.set(-6, 2, 4); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(-3, 5, -7); scene.add(rim);
    // Ground grid — rebuilt on every fit to sit at the model's base and scale to
    // its footprint (see groundTo), so it reads as a floor the model rests on
    // instead of a fixed 10-unit plane the model floats above or clips through.
    let groundGrid = null;
    // Last model size passed to groundTo, kept so the contrast toggle can rebuild
    // the grid (its line colors are baked into geometry, not the material) at the
    // same footprint without touching the camera.
    let lastGroundSize = null;
    // Soft contact shadow that sits under the model on the grid so it reads as
    // resting on the floor instead of floating. A radial-gradient sprite (one
    // textured quad) rather than a real shadow map: it needs no per-model shadow
    // camera to tune across the sample footprints and costs one transparent draw,
    // keeping the scene performant and zero-build. Rebuilt with the grid in
    // groundTo so it always matches the current model's base and footprint.
    let groundShadow = null;
    // Radial dark-to-transparent blob, built once and shared across rebuilds.
    const shadowTexture = (() => {
      const S = 256;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const ctx = cv.getContext('2d');
      const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      g.addColorStop(0, 'rgba(0,0,0,0.55)');
      g.addColorStop(0.5, 'rgba(0,0,0,0.22)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    })();
    // Screen-space orientation gizmo: a small fixed XYZ indicator drawn as an
    // overlay pass. Unlike a world-space AxesHelper it never gets swallowed by
    // geometry and stays the same size regardless of zoom.
    const viewHelper = new ViewHelper(camera, renderer.domElement);
    // ViewHelper hardcodes a 128px box in the *bottom-right* corner (both its
    // render viewport and its click hit-test). That corner collides with the
    // centered #bottom-cluster (gallery pills + hint) on narrow/medium widths.
    // Relocate the gizmo to the top-right, tucked just under the header, where
    // the canvas is always empty — clear of the bottom cluster at every width
    // and clear of the header row above it. GIZMO_TOP is the inset from the top
    // edge (must exceed the header height, ~60px on a compact touch header).
    const GIZMO_DIM = 128;
    const GIZMO_TOP = 68;
    // On a notched phone the header grows downward by env(safe-area-inset-top), so
    // the gizmo's inset must grow with it or the two collide. env() can't be read
    // from JS, so we read the laid-out height of the #safe-probe element (its CSS
    // height is bound to that inset). Recomputed on each call so an orientation
    // change (portrait↔landscape flips which edge carries the inset) is picked up
    // live. Resolves to 0 on desktop, so gizmoTop() == GIZMO_TOP there.
    const safeProbe = document.getElementById('safe-probe');
    const safeTop = () => (safeProbe ? safeProbe.getBoundingClientRect().height : 0);
    const gizmoTop = () => GIZMO_TOP + safeTop();
    // The framebuffer uses a bottom-left origin, so a box whose top edge sits
    // gizmoTop() px below the canvas top has its lower edge at this y.
    const gizmoViewportY = () => innerHeight - GIZMO_DIM - gizmoTop();
    // ViewHelper.render issues exactly one setViewport(x, 0, dim, dim) for the
    // gizmo pass (then restores the full viewport). Intercept that single call
    // and raise its y; everything else (the full-frame restore, width != dim)
    // passes through untouched.
    const vhRender = viewHelper.render.bind(viewHelper);
    viewHelper.render = (r) => {
      const setViewport = r.setViewport.bind(r);
      r.setViewport = (x, y, w, h) => {
        if (y === 0 && w === GIZMO_DIM && h === GIZMO_DIM) {
          setViewport(x, gizmoViewportY(), w, h);
        } else {
          setViewport(x, y, w, h);
        }
      };
      vhRender(r);
      r.setViewport = setViewport; // restore the un-patched method
    };

    // (Re)build the ground grid to rest at the model's base (bounding-box min-Y)
    // and span its footprint. `size` is the model's world-space dimensions; the
    // caller has already recentered the model on the origin, so the base sits at
    // y = -size.y/2. A tiny downward nudge avoids z-fighting with a flat base.
    function groundTo(size) {
      lastGroundSize = size.clone(); // remember for a contrast-driven rebuild
      if (groundGrid) {
        scene.remove(groundGrid);
        groundGrid.geometry.dispose();
        groundGrid.material.dispose();
      }
      if (groundShadow) {
        scene.remove(groundShadow);
        groundShadow.geometry.dispose();
        groundShadow.material.dispose(); // shared shadowTexture is NOT disposed here
      }
      const footprint = Math.max(size.x, size.z) || 1;
      const extent = footprint * 2.5; // a bit wider than the model so it reads as floor
      const baseY = -size.y / 2;
      const [gridCenterColor, gridLineColor] = gridColors();
      groundGrid = new THREE.GridHelper(extent, 20, gridCenterColor, gridLineColor);
      groundGrid.position.y = baseY - footprint * 0.001;
      scene.add(groundGrid);

      // Contact shadow: a flat quad carrying the radial blob, centered under the
      // recentered model (origin in X/Z) and scaled to ~1.8x the footprint so the
      // soft edge fades out before the grid boundary. depthWrite:false + a raised
      // renderOrder blend it over the grid lines without z-fighting; it sits a hair
      // above the grid (and just below the model base) so it grounds the part.
      const shadowSize = footprint * 1.8;
      groundShadow = new THREE.Mesh(
        new THREE.PlaneGeometry(shadowSize, shadowSize),
        new THREE.MeshBasicMaterial({
          map: shadowTexture, transparent: true, depthWrite: false,
          opacity: sceneTheme().shadowOpacity,
        })
      );
      groundShadow.rotation.x = -Math.PI / 2; // lay the quad flat on the ground plane
      groundShadow.position.y = baseY + footprint * 0.0005;
      groundShadow.renderOrder = 1;
      groundShadow.raycast = () => {}; // decorative — never a pick/hit target
      scene.add(groundShadow);

      // Blueprint mode reads as a clean technical drawing with no floor, so the
      // grid + contact shadow are hidden while it's on. groundTo rebuilds both
      // fresh (default-visible) on every fit / theme / contrast change, so re-hide
      // them here whenever the mode is active — this is the single choke point that
      // keeps them hidden across every rebuild path.
      if (blueprint) {
        groundGrid.visible = false;
        groundShadow.visible = false;
      }
    }

    // Placeholder object — shown while the sample loads and kept as a fallback
    // if STEP parsing fails, so the scene always stays alive.
    const placeholder = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.7, 0.24, 160, 24),
      // Match the loaded-mesh look (see src/step.js): machined-metal metalness /
      // roughness plus envMapIntensity so the RoomEnvironment reflections read.
      new THREE.MeshStandardMaterial({
        color: 0x4f9dff, metalness: 0.85, roughness: 0.3, envMapIntensity: 1.15,
      })
    );
    scene.add(placeholder);

    const hint = document.getElementById('hint');
    // Interaction-hint modality (issue #106). Touch devices orbit/zoom with
    // gestures, not a scroll wheel, and have no keyboard — so the wording differs
    // ('pinch to zoom' + no key hints vs 'scroll to zoom' + key hints). The
    // `(pointer: coarse)` media query only reports the device's *primary* pointer,
    // which lies on hybrids (touch laptop, tablet + trackpad, phone + paired
    // mouse). So we render the media-query guess immediately (no blank flash), then
    // correct it in place from the first real interaction that contradicts it.
    let coarsePointer = matchMedia('(pointer: coarse)').matches;
    let modalitySettled = false; // true once a real interaction has confirmed/corrected the guess
    // Modality-worded fragments, recomputed by computeModalityStrings() whenever
    // coarsePointer flips. `zoomHint` is also read by the loaded-model hint below.
    let zoomHint, dropHint, keyHint;
    function computeModalityStrings() {
      // drag to orbit · pinch|scroll to zoom
      zoomHint = coarsePointer ? t('zoomPinch') : t('zoomScroll');
      // First-paint discoverability guidance, worded for the current modality.
      dropHint = coarsePointer ? t('hintTapModel') : t('hintPickModel');
      // Key shortcuts only make sense with a keyboard — hidden for pure-touch.
      keyHint = coarsePointer ? '' : t('keyHint');
    }
    computeModalityStrings();
    hint.textContent = `${dropHint} · ${zoomHint}${keyHint}`;
    // Re-word the standing hint when the observed modality contradicts the guess.
    // We only rewrite when the current #hint text is exactly the standing hint we
    // last composed (intro, loaded-model, or reduced-data). If a transient message
    // (measure result, section toggle, selection, error…) is showing, none match,
    // so we leave it untouched rather than clobbering it. The #app aria-label is
    // deliberately kept modality-neutral (it names *both* "scroll or pinch"), so it
    // never contradicts the visible hint and needs no update here.
    function setModality(coarse) {
      // Idempotent: once settled to this modality, do nothing — this makes the
      // input listeners cheap no-ops after the modality is decided, and prevents
      // repeated events (every wheel tick / touch) from thrashing the text.
      if (modalitySettled && coarse === coarsePointer) return;
      // Snapshot the standing strings under the *old* modality so we can tell
      // which (if any) is currently on screen before we overwrite the fragments.
      const oldIntro = `${dropHint} · ${zoomHint}${keyHint}`;
      const oldLoaded = currentModelLabel != null
        ? t('loadedHint', { label: currentModelLabel, zoom: zoomHint }) : null;
      const oldReduced = coarsePointer ? t('reducedDataCoarse') : t('reducedDataFine');
      coarsePointer = coarse;
      modalitySettled = true;
      computeModalityStrings();
      const cur = hint.textContent;
      if (cur === oldIntro) {
        hint.textContent = `${dropHint} · ${zoomHint}${keyHint}`;
      } else if (oldLoaded != null && cur === oldLoaded) {
        hint.textContent = t('loadedHint', { label: currentModelLabel, zoom: zoomHint });
      } else if (cur === oldReduced) {
        hint.textContent = coarsePointer ? t('reducedDataCoarse') : t('reducedDataFine');
      }
    }
    // Passive, capture-phase listeners that classify the first (and any later)
    // real interaction. touch → coarse; wheel / mouse-or-pen pointerdown /
    // keydown → fine. They stay attached but no-op via setModality's guard once
    // the modality is settled, and may re-settle if the user switches input type.
    const onTouchInput = () => setModality(true);
    const onPointerInput = (e) => {
      if (e.pointerType === 'touch') setModality(true);
      else setModality(false); // mouse / pen → fine pointer
    };
    const onFineInput = () => setModality(false); // wheel / keyboard
    window.addEventListener('pointerdown', onPointerInput, { passive: true, capture: true });
    window.addEventListener('touchstart', onTouchInput, { passive: true, capture: true });
    window.addEventListener('wheel', onFineInput, { passive: true, capture: true });
    window.addEventListener('keydown', onFineInput, { passive: true, capture: true });
    const spinner = document.getElementById('spinner');
    const toast = document.getElementById('toast');
    let spin = placeholder; // object the render loop rotates (null once static model loads)
    // Render-on-demand latch: true while a frame is already queued via rAF, so the
    // many invalidate() call sites coalesce to a single draw per tick. Read/written
    // only by invalidate()/renderFrame() at the bottom of the module.
    let renderRequested = false;
    let currentModel = null; // the loaded STEP Group currently in the scene, if any
    let currentModelLabel = null; // label of the on-screen model (for the PNG filename)
    // File key of the bundled sample currently on screen, or null when a
    // user-opened/dropped file is shown. Drives the deep-link hash: only bundled
    // samples are encodable (a local blob can't be restored without a backend),
    // so a null here clears the sample part of the URL hash. Set by loadSample,
    // cleared by loadFile.
    let currentSampleFile = null;
    let wireframe = false; // wireframe render state, applied to loaded meshes
    // Blueprint / technical edge-only render state. When on, the shaded faces of
    // currentModel are hidden and only the high-contrast feature-edge overlay is
    // drawn against a blueprint backdrop. Declared here (with the other render-
    // state flags) because groundTo reads it to keep the grid/shadow hidden across
    // grid rebuilds while the mode is on. Transient like wireframe/measure/section
    // (not persisted): a viewing mode, not a saved preference.
    let blueprint = false;
    // prefers-reduced-motion query. Declared here (used by both the model swap-in
    // transition below and the placeholder-spin gate in the render loop). Live, so
    // a mid-session OS setting change is honored.
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

    // --- High-contrast scene state --------------------------------------------
    // Declared here (near the other render-state flags) because the initial load
    // path — groundTo (grid colors) and showStepFromArrayBuffer (edge style) —
    // reads it. The persisted / OS choice was already applied to <html
    // data-contrast> before first paint by the inline head script; the effective
    // state: an explicit high/normal choice wins, otherwise follow the OS query.
    const contrastQuery = matchMedia('(prefers-contrast: more)');
    function contrastIsHigh() {
      const attr = document.documentElement.getAttribute('data-contrast');
      if (attr === 'high') return true;
      if (attr === 'normal') return false;
      return contrastQuery.matches;
    }
    let highContrast = contrastIsHigh();

    // --- Light/dark scene state -----------------------------------------------
    // CSS themes the DOM chrome from custom properties (see the token blocks), but
    // the WebGL scene can't read CSS vars — so it is themed from this parallel JS
    // object, read at toggle time. The persisted / OS choice was applied to <html
    // data-theme> before first paint by the head script; effective state mirrors
    // contrastIsHigh(): an explicit light/dark wins, otherwise follow the OS query.
    const colorSchemeQuery = matchMedia('(prefers-color-scheme: light)');
    function themeIsLight() {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'light') return true;
      if (attr === 'dark') return false;
      return colorSchemeQuery.matches;
    }
    let lightTheme = themeIsLight();

    // Feature-edge line styles. High contrast uses a darker, far more opaque
    // stroke so the overlay reads crisply against the metal surface; the dark
    // default is the original faint line (byte-for-byte unchanged); light keeps a
    // dark stroke but a touch more opaque so edges read on the pale backdrop.
    const EDGE_NORMAL = { color: 0x0a0d12, opacity: 0.35 };
    const EDGE_HIGH = { color: 0x000000, opacity: 0.9 };
    const EDGE_LIGHT = { color: 0x2a3340, opacity: 0.45 };
    // Single source of truth for every scene color/level that can't live in CSS.
    // High contrast (an accessibility override) takes precedence; otherwise the
    // light/dark axis picks the values. grid = [centerLine, gridLines]; exposure
    // brightens the tone-mapped model against the pale backdrop; shadowOpacity /
    // captureBg keep the contact shadow and saved-PNG backdrop legible per theme.
    function sceneTheme() {
      if (highContrast) {
        return { grid: [0x8b98a8, 0x5a6472], edge: EDGE_HIGH,
                 exposure: lightTheme ? 1.15 : 1.0,
                 shadowOpacity: lightTheme ? 0.5 : 0.9,
                 captureBg: lightTheme ? 0xeef1f6 : 0x0e1116 };
      }
      if (lightTheme) {
        return { grid: [0x9aa6b4, 0xc4ccd6], edge: EDGE_LIGHT,
                 exposure: 1.15, shadowOpacity: 0.5, captureBg: 0xeef1f6 };
      }
      return { grid: [0x2a2f3a, 0x1b1f27], edge: EDGE_NORMAL,
               exposure: 1.0, shadowOpacity: 0.9, captureBg: 0x0e1116 };
    }
    const currentEdgeStyle = () => sceneTheme().edge;
    // Ground-grid line colors [centerLine, gridLines]; delegates to sceneTheme so
    // high contrast lifts them, light greys them for the pale floor, dark matches
    // today.
    const gridColors = () => sceneTheme().grid;
    // Apply the initial tone-mapping exposure for the resolved theme so the first
    // render (before any toggle) already sits right against the chosen backdrop.
    renderer.toneMappingExposure = sceneTheme().exposure;

    // Show/hide the centered loading spinner while a STEP file parses.
    function setLoading(on) { spinner.classList.toggle('active', on); }

    // Staged first-load status line under the spinner. Pass a phase string to
    // show it, or null to clear. Only the initial auto-load drives this (see
    // loadSample); subsequent loads keep the lighter bare spinner.
    const loadStatus = document.getElementById('load-status');
    function setLoadStatus(text) {
      if (text == null) { loadStatus.classList.remove('active'); return; }
      loadStatus.textContent = text;
      loadStatus.classList.add('active');
    }

    // --- Persistent engine-load failure + Retry --------------------------------
    // An occt/WASM engine failure (offline / CDN down) or a first-load stall is
    // not self-clearing, so — unlike a per-file parse error's transient toast —
    // it gets a persistent inline panel with a Retry button. `retryAction` holds
    // a closure that re-runs whatever the last load attempt was (a gallery sample
    // or a dropped/opened file); loadSample/loadFile set it before they run.
    const engineError = document.getElementById('engine-error');
    const engineRetry = document.getElementById('engine-retry');
    const engineErrorMsg = engineError.querySelector('.ee-msg');
    const ENGINE_ERROR_DEFAULT = t('engineErrorDefault');
    let retryAction = null;

    function showEngineError(msg) {
      engineErrorMsg.textContent = msg || ENGINE_ERROR_DEFAULT;
      engineError.hidden = false;
      // Don't spin forever behind the panel: stop the spinner and clear the
      // staged status line so the failure state is the single thing on screen.
      setLoading(false);
      setLoadStatus(null);
      engineRetry.focus(); // move focus to the action so it's reachable + announced
    }
    function hideEngineError() {
      engineError.hidden = true;
    }
    engineRetry.addEventListener('click', () => {
      hideEngineError();
      // Force a genuinely fresh engine attempt: a stall may have left the previous
      // init promise pending, which initOcct would otherwise re-await forever.
      resetOcct();
      if (retryAction) retryAction();
    });

    // --- Model-info HUD -------------------------------------------------------
    // Surface the current model's name, triangle count, and bounding-box size —
    // basic CAD stats that were previously computed then discarded.
    const modelInfo = document.getElementById('model-info');
    const miName = modelInfo.querySelector('.mi-name');
    const miStats = modelInfo.querySelector('.mi-stats');
    const miA11y = modelInfo.querySelector('.mi-a11y');

    // STEP header metadata "Details" disclosure (issue #96). The trigger lives in
    // the HUD; the dialog is a native <dialog> opened via showModal (Escape /
    // backdrop / × all dismiss, mirroring the help dialog).
    const miDetails = modelInfo.querySelector('.mi-details');
    const metaDialog = document.getElementById('meta-dialog');
    const metaList = document.getElementById('meta-list');
    const metaClose = document.getElementById('meta-close');
    miDetails.addEventListener('click', () => {
      if (!metaDialog.open && typeof metaDialog.showModal === 'function') metaDialog.showModal();
    });
    metaClose.addEventListener('click', () => metaDialog.close());
    // Backdrop click: showModal centers the panel, so a click whose target is the
    // <dialog> element itself (not its content) landed on the backdrop.
    metaDialog.addEventListener('click', (e) => { if (e.target === metaDialog) metaDialog.close(); });

    // Rebuild the "Details" disclosure from the freshly loaded model's parsed STEP
    // header (group.userData.stepHeader), reusing the dialog styling. Called on the
    // single load/swap path so it's cleared/replaced on every model swap. Values
    // are set via textContent (never HTML) so a hostile filename/author string in a
    // dropped file can't inject markup. Fields that are empty are omitted; when
    // there's no metadata at all (non-STEP formats, or a header miss) the trigger
    // is hidden and any open dialog is closed.
    function updateMetaDetails(group) {
      const h = group && group.userData && group.userData.stepHeader;
      metaList.replaceChildren(); // drop the previous model's rows
      const rows = [];
      if (h) {
        // Schema + AP read as one line: "AUTOMOTIVE_DESIGN (AP214)", or whichever
        // half is present.
        let schemaVal = '';
        if (h.schema && h.ap) schemaVal = h.schema === h.ap ? h.schema : h.schema + ' (' + h.ap + ')';
        else schemaVal = h.schema || h.ap || '';
        if (schemaVal) rows.push([t('metaSchema'), schemaVal]);
        if (h.author) rows.push([t('metaAuthor'), h.author]);
        if (h.organization) rows.push([t('metaOrg'), h.organization]);
        if (h.originatingSystem) rows.push([t('metaSystem'), h.originatingSystem]);
        if (h.preprocessor) rows.push([t('metaPreprocessor'), h.preprocessor]);
        if (h.timestamp) rows.push([t('metaTimestamp'), h.timestamp]);
      }
      if (!rows.length) {
        miDetails.hidden = true;
        if (metaDialog.open) metaDialog.close();
        return;
      }
      for (const [label, value] of rows) {
        const row = document.createElement('div');
        row.className = 'meta-row';
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value; // text content only — never innerHTML (XSS-safe)
        row.append(dt, dd);
        metaList.append(row);
      }
      miDetails.hidden = false;
    }

    // The canvas (#app, role=img) accessible name becomes a live per-model
    // summary after a load (updateModelInfo); on a failure with nothing on
    // screen it reverts to this non-model description rather than lying about a
    // stale model. (The markup default covers the pre-first-load window.)
    const APP_ARIA_EMPTY = t('appAriaEmpty');

    // fmtDim now lives in ./ui.js; countTriangles in ./step-core.js (imported above).

    // Refresh the HUD for the freshly loaded model. Called from the single
    // load/swap path (showStepFromArrayBuffer) so it covers gallery picks, number
    // keys, file-open, and drag-drop alike. getSize is translation-invariant, so
    // it's correct whether or not frameObject has recentered the group yet.
    function updateModelInfo(group, label) {
      const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
      const tris = countTriangles(group);
      miName.textContent = label;
      miName.title = label; // full name on hover when the label is ellipsized
      // Native length unit (issue #95): the loader stashes a short symbol on
      // group.userData.unit when it could detect the STEP length unit (mm/m/in/…).
      // Append it to the dimension line as " mm"; when unknown the suffix is '' so
      // the display stays exactly the current bare numbers (no fabricated unit).
      // Threaded via userData so every entry into this function — the load/swap
      // path AND the color-by-part re-render — shows the unit identically.
      const unitSym = group.userData && group.userData.unit ? group.userData.unit : '';
      const unitSuffix = unitSym ? ' ' + unitSym : '';
      let stats = t('modelStats', {
        tris: tris.toLocaleString(),
        x: fmtDim(size.x), y: fmtDim(size.y), z: fmtDim(size.z), unit: unitSuffix,
      });
      // While color-by-part is active, note how many solids the assembly has
      // (group child count) so the mode's per-part coloring has a read-out.
      if (colorByPart) {
        const parts = countParts(group);
        stats += ' · ' + t(parts === 1 ? 'modelPartsOne' : 'modelParts', { parts });
      }
      miStats.textContent = stats;
      modelInfo.hidden = false;

      // Compose a natural-language summary that reuses the same number/dimension
      // formatting as the visible HUD, then (a) make it the canvas accessible
      // name so AT users querying the view hear what's on screen, and (b) push it
      // into the polite #model-info live region (.mi-a11y) so it's announced once
      // per load. The visible .mi-name/.mi-stats are aria-hidden, so no duplicate.
      const summary = t('modelSummary', {
        label, tris: tris.toLocaleString(),
        x: fmtDim(size.x), y: fmtDim(size.y), z: fmtDim(size.z), unit: unitSuffix,
      });
      app.setAttribute('aria-label', summary);
      miA11y.textContent = summary;

      // Refresh the STEP header "Details" disclosure for this model (issue #96):
      // rebuilds/reveals it when the model carries parsed header metadata, hides it
      // otherwise. Threaded through the same load/swap entry as the rest of the HUD.
      updateMetaDetails(group);
    }

    // Revert the canvas accessible name + live summary to a non-model state.
    // Called on a load failure when nothing valid is on screen, so AT users are
    // told the view is empty instead of hearing a stale successful summary.
    function resetModelInfo() {
      app.setAttribute('aria-label', APP_ARIA_EMPTY);
      miA11y.textContent = '';
      miName.textContent = '';
      miStats.textContent = '';
      currentModelLabel = null; // no valid model on screen → no capture name
      modelInfo.hidden = true;
      // No valid model → drop any STEP header details and close the disclosure.
      miDetails.hidden = true;
      metaList.replaceChildren();
      if (metaDialog.open) metaDialog.close();
      disposePartsPanel(); // no valid model → drop any stale parts list
    }

    // --- Model swap-in transition ---------------------------------------------
    // A freshly parsed model eases in (slight scale-up + fade) instead of popping
    // hard. Cheap: it drives group.scale and material.opacity from the existing
    // render loop for ~260ms, then restores opaque rendering so there's no
    // lingering blend/z-order cost. Honors prefers-reduced-motion — opted-out
    // users get no animation; the model simply appears at full size/opacity.
    const SWAP_MS = 260;
    const SWAP_FROM = 0.92; // starting scale factor (eases up to 1.0)
    let swapAnim = null; // { group, mats, start } while a transition is in flight

    function startSwapIn(group) {
      if (reduceMotion.matches) return; // no motion for opt-out users
      // Fade only the shaded mesh materials. Deferred edge LineSegments aren't in
      // the group yet (built in an idle slot) and carry their own opacity, so
      // they're intentionally left out — they pop in a beat later regardless.
      const mats = [];
      group.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const arr = Array.isArray(obj.material) ? obj.material : [obj.material];
        arr.forEach((m) => {
          mats.push({ m, wasTransparent: m.transparent, base: m.opacity });
          m.transparent = true;
          m.opacity = 0;
        });
      });
      group.scale.setScalar(SWAP_FROM);
      swapAnim = { group, mats, start: performance.now() };
      invalidate(); // render-on-demand: drive the fade until updateSwapIn clears it
    }

    // Advance the in-flight swap-in transition; called once per frame from the
    // render loop. No-op when nothing is animating.
    function updateSwapIn(now) {
      if (!swapAnim) return;
      const t = Math.min((now - swapAnim.start) / SWAP_MS, 1);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      swapAnim.group.scale.setScalar(SWAP_FROM + (1 - SWAP_FROM) * e);
      swapAnim.mats.forEach(({ m, base }) => { m.opacity = base * e; });
      if (t >= 1) {
        // Settle exactly, and drop transparency back for materials that were
        // opaque before so full-opacity metal renders in the opaque pass again.
        swapAnim.mats.forEach(({ m, wasTransparent, base }) => {
          m.opacity = base;
          if (!wasTransparent) m.transparent = false;
        });
        swapAnim.group.scale.setScalar(1);
        swapAnim = null;
      }
    }

    // Non-blocking toast; auto-dismisses. A new message resets the timer. Defaults
    // to the soft-red error palette; pass ok=true for the calm-green success
    // variant (used by the share "Link copied!" confirmation). role=alert on the
    // element means either variant is announced to assistive tech.
    let toastTimer = null;
    function showToast(msg, ok) {
      toast.textContent = msg;
      toast.classList.toggle('toast-ok', !!ok);
      toast.classList.add('active');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('active'), 5000);
    }

    // describeError now lives in ./ui.js (imported above).

    // First-paint loader + stall watchdog. The static spinner is cleared once the
    // first model renders (markFirstRender). If the initial engine+model load has
    // not finished after STALL_MS, surface a real message instead of an eternal
    // spinner so a slow/broken CDN download doesn't look like a hang.
    const STALL_MS = 18000;
    let firstRenderDone = false;
    let stallTimer = null;
    function startStallWatch() {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (firstRenderDone) return;
        // Don't spin forever: a first-load that hasn't rendered by now is treated
        // as an engine-load failure. Surface the same persistent Retry panel the
        // 'init' error path uses (Retry resets the pending occt attempt), rather
        // than an eternal spinner plus a toast that self-dismisses.
        hint.textContent = t('engineErrorDefault');
        // No model ever rendered — keep the canvas accessible name in its
        // non-model state instead of the generic "loaded model" markup default.
        if (!currentModel) resetModelInfo();
        showEngineError(t('engineErrorStall'));
      }, STALL_MS);
    }
    function markFirstRender() {
      if (firstRenderDone) return;
      firstRenderDone = true;
      clearTimeout(stallTimer);
      setLoading(false); // clear the first-paint loader once real content is on screen
      setLoadStatus(null); // and the staged first-load status line
    }

    // Apply the current wireframe state to every mesh material in a group.
    function applyWireframe(group) {
      if (!group) return;
      group.traverse((obj) => {
        if (!obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => { m.wireframe = wireframe; });
      });
    }

    // disposeGroup now lives in ./scene.js (imported above).

    // Center a group on the origin and frame the camera around it.
    // Fit distance for a model of the given bounding radius at the current
    // viewport aspect. Fit must respect the aspect ratio: a model as wide as it
    // is tall overflows horizontally on portrait/narrow screens if we only
    // satisfy the vertical FOV. Compute the distance for BOTH the vertical and
    // horizontal FOV and take the larger, so the model fits in whichever
    // dimension is tighter (the horizontal one when aspect < 1). The 1.18 is
    // headroom padding. isFiniteVec/isFiniteBox and fitDistanceForRadius now live
    // in ./scene.js (imported above); fitDistanceForRadius takes the camera as an
    // explicit argument there instead of reading it from this closure.

    function frameObject(obj) {
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      // Non-finite guard (issue #98): a subtly-malformed parse can yield NaN/±Inf
      // vertex positions, giving a box that is NOT empty but whose size/center are
      // non-finite. Framing on it would set camera.position/near/far to NaN and
      // render the scene black with no recovery. Bail on the same contract as the
      // empty-box early return — leave the camera/controls/object untouched. The
      // swap path (showStepFromArrayBuffer) also pre-checks and aborts before this,
      // so this is a defensive second line for any other frameObject caller.
      if (!isFiniteVec(size) || !isFiniteVec(center)) return;
      obj.position.sub(center); // recenter at origin

      // Drop the ground grid to the (now recentered) model's base and size it to
      // the model so it grounds the object instead of floating in the void.
      groundTo(size);

      const radius = 0.5 * Math.max(size.x, size.y, size.z) || 1;
      const dist = fitDistanceForRadius(radius, camera);
      camera.position.set(dist * 0.6, dist * 0.5, dist * 0.8);
      camera.near = Math.max(dist / 1000, 0.01);
      camera.far = dist * 1000;
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      // Constrain zoom relative to the framed model so users can neither clip
      // through the surface nor fly off to nowhere, and keep panning bounded.
      controls.minDistance = radius * 0.4;
      controls.maxDistance = dist * 6;
      controls.screenSpacePanning = false; // pan in the ground plane, keeps it sane
      controls.update();
      invalidate(); // render-on-demand: framing moved the camera / grid / shadow
    }

    // Re-frame whatever object is currently on screen (loaded STEP model, or the
    // placeholder before/if no model loads). Recoverable from any lost/zoom state.
    function fitView() {
      // Documented interop: a global Fit collapses any exploded view first, so the
      // framing and the ground grid/shadow footprint (groundTo, inside frameObject)
      // are computed on the collapsed model rather than the spread-apart bounds.
      resetExplode();
      frameObject(currentModel || placeholder);
    }

    // --- Named standard-view presets ------------------------------------------
    // One-click canonical viewpoints for CAD inspection. Each preset points the
    // camera down a fixed direction at the SAME framed distance a Fit would use
    // (fitDistanceForRadius reused), with the orbit target snapped to the origin
    // (frameObject recenters every model there), so the part stays fully in frame
    // and only the direction changes. Ortho dirs are unit vectors → distance =
    // fit distance; the iso dir reuses the default 0.6/0.5/0.8 placement so the
    // Iso preset matches the default framed view exactly.
    const PRESET_DIRS = {
      front:  new THREE.Vector3(0, 0, 1),   // +Z
      back:   new THREE.Vector3(0, 0, -1),  // -Z
      top:    new THREE.Vector3(0, 1, 0),   // +Y
      bottom: new THREE.Vector3(0, -1, 0),  // -Y
      right:  new THREE.Vector3(1, 0, 0),   // +X
      left:   new THREE.Vector3(-1, 0, 0),  // -X
      iso:    new THREE.Vector3(0.6, 0.5, 0.8),
    };
    // Numpad → preset map. Keyed on e.code so it's NumLock-independent and never
    // collides with the top-row 1–4 sample keys (those match e.key).
    const NUMPAD_VIEWS = {
      Numpad0: 'iso',   Numpad1: 'front', Numpad2: 'back',
      Numpad3: 'right', Numpad4: 'left',  Numpad5: 'top', Numpad6: 'bottom',
    };
    const PRESET_MS = 250; // ease duration for the snap
    // easeInOutQuad — smooth accelerate/decelerate for the position/target lerp.
    const easePreset = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    // In-flight snap: { fromPos, toPos, fromTarget, toTarget, start } or null.
    // Advanced by the render loop (re-entrant with OrbitControls damping: it only
    // sets camera.position/target, which controls.update() reads back next).
    let presetAnim = null;

    function applyView(preset) {
      const dir = PRESET_DIRS[preset];
      if (!dir) return;
      // Works before any model loads: fall back to the placeholder's bounds.
      const obj = currentModel || placeholder;
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const radius = 0.5 * Math.max(size.x, size.y, size.z) || 1;
      const dist = fitDistanceForRadius(radius, camera);
      const toPos = dir.clone().multiplyScalar(dist);
      const toTarget = new THREE.Vector3(0, 0, 0);
      // Keep the clip planes sane for this distance (mirrors frameObject) so a
      // preset from a far-zoomed state doesn't near/far-clip the model.
      camera.near = Math.max(dist / 1000, 0.01);
      camera.far = dist * 1000;
      camera.updateProjectionMatrix();
      if (reduceMotion.matches) {
        // Reduced motion → instant jump, no tween.
        camera.position.copy(toPos);
        controls.target.copy(toTarget);
        controls.update();
        presetAnim = null;
        invalidate(); // render-on-demand: draw the instant jump
        return;
      }
      presetAnim = {
        fromPos: camera.position.clone(),
        toPos,
        fromTarget: controls.target.clone(),
        toTarget,
        start: performance.now(),
      };
      invalidate(); // render-on-demand: drive the ease until presetAnim clears
    }

    // Wire the preset toolbar buttons to their view. The debounced hash writer on
    // controls 'change' (scheduleHashWrite) persists the resulting camera to the
    // deep-link hash automatically, so no explicit writeHash is needed here.
    document.querySelectorAll('#view-presets .preset').forEach((btn) => {
      btn.addEventListener('click', () => applyView(btn.dataset.view));
    });

    // --- Point-to-point distance measurement ----------------------------------
    // A CAD inspection tool. With Measure mode on, a click raycasts (a
    // THREE.Raycaster from the pointer through the camera) against currentModel's
    // meshes only — the decorative feature-edge LineSegments already have raycast
    // disabled (see step.js), so they're naturally excluded — to place two markers,
    // draw a line between them, and read out the Euclidean distance in model units
    // (same fmtDim formatting as the bbox HUD). OrbitControls stays live, so a
    // measuring click is told apart from an orbit drag by pointer travel: a
    // pointerup within MEASURE_CLICK_TOL px of its pointerdown counts as a click.
    // Markers/line render with depthTest:false + a raised renderOrder so they stay
    // visible against the metal surface instead of being occluded by it. The
    // distance is an HTML overlay (#measure-label) projected each frame from the
    // segment midpoint in the render loop, so it tracks as the user orbits. All
    // measurement geometry lives directly in the scene (never inside currentModel),
    // so a model swap can't attach it to a discarded group; it's still torn down
    // explicitly on swap (clearMeasurement in showStepFromArrayBuffer) so a stale
    // measurement never lingers onto the next model.
    const measureBtn = document.getElementById('measure-btn');
    const measureClearBtn = document.getElementById('measure-clear');
    const measureLabel = document.getElementById('measure-label');
    const measureRay = new THREE.Raycaster();
    const _measNdc = new THREE.Vector2();
    const _measMid = new THREE.Vector3();
    const measurePoints = []; // world-space hit points (0, 1, or 2)
    let measureMarkers = [];  // marker Meshes currently in the scene
    let measureLine = null;   // the connecting Line, once two points exist
    let measureMode = false;  // Measure toggle state
    // pointerdown bookkeeping so pointerup can tell a click from an orbit drag.
    let measureDownX = 0, measureDownY = 0, measureDownId = -1;
    const MEASURE_CLICK_TOL = 6;    // px of travel still counted as a click
    const MEASURE_COLOR = 0xffd24a; // amber — reads against the blue metal + dark bg

    // Marker radius scaled to the current model so the spheres read at any part
    // size (a 0.8mm gear vs a 250mm block). getSize is translation/rotation-safe.
    function measureMarkerRadius() {
      if (!currentModel) return 0.02;
      const size = new THREE.Box3().setFromObject(currentModel).getSize(new THREE.Vector3());
      return (Math.max(size.x, size.y, size.z) || 1) * 0.02;
    }

    // Enable + show the Clear button only when it's useful: visible while Measure
    // mode is on OR a measurement lingers, and enabled only when there's something
    // to clear.
    function updateMeasureClearState() {
      if (!measureClearBtn) return;
      const has = measurePoints.length > 0;
      measureClearBtn.hidden = !(measureMode || has);
      measureClearBtn.disabled = !has;
    }

    // Remove markers + line + label and reset the point list, disposing every
    // geometry/material so nothing leaks. Safe to call when nothing is measured.
    function clearMeasurement() {
      measureMarkers.forEach((m) => {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
      });
      measureMarkers = [];
      if (measureLine) {
        scene.remove(measureLine);
        measureLine.geometry.dispose();
        measureLine.material.dispose();
        measureLine = null;
      }
      measurePoints.length = 0;
      measureLabel.hidden = true;
      updateMeasureClearState();
      invalidate(); // render-on-demand: redraw with the markers/line removed
    }

    // Drop a marker sphere at a world-space hit point. depthTest:false + a high
    // renderOrder keep it drawn over the shaded model.
    function addMeasureMarker(point) {
      const r = measureMarkerRadius();
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(r, 16, 12),
        new THREE.MeshBasicMaterial({ color: MEASURE_COLOR, depthTest: false })
      );
      marker.position.copy(point);
      marker.renderOrder = 999;   // draw last so it's never occluded
      marker.raycast = () => {};  // never a pick target itself
      scene.add(marker);
      measureMarkers.push(marker);
    }

    // Build the connecting line once both endpoints exist (same over-draw treatment
    // as the markers so it stays visible against the surface).
    function buildMeasureLine() {
      const geom = new THREE.BufferGeometry().setFromPoints(measurePoints);
      measureLine = new THREE.Line(
        geom,
        new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false })
      );
      measureLine.renderOrder = 999;
      measureLine.raycast = () => {};
      scene.add(measureLine);
    }

    // Handle a confirmed measuring click at NDC coords: raycast currentModel and,
    // on a hit, advance the two-point measurement. A click after a completed
    // measurement restarts a fresh one from that hit.
    function measureAt(ndcX, ndcY) {
      if (!currentModel) return;
      _measNdc.set(ndcX, ndcY);
      measureRay.setFromCamera(_measNdc, camera);
      const hits = measureRay.intersectObject(currentModel, true);
      if (!hits.length) return;
      const p = hits[0].point.clone();
      if (measurePoints.length >= 2) clearMeasurement(); // start a new measurement
      measurePoints.push(p);
      addMeasureMarker(p);
      updateMeasureClearState();
      invalidate(); // render-on-demand: draw the new marker (and line/label below)
      if (measurePoints.length === 1) {
        hint.textContent = t('measureFirst');
      } else {
        buildMeasureLine();
        const dist = measurePoints[0].distanceTo(measurePoints[1]);
        measureLabel.textContent = fmtDim(dist);
        measureLabel.hidden = false;
        hint.textContent = t('measureResult', { dist: fmtDim(dist) });
      }
    }

    // Turn Measure mode on/off. Toggling off clears an in-progress (single-point)
    // measurement; a completed one is left on screen until Clear / a model swap.
    function setMeasureMode(on) {
      measureMode = on;
      measureBtn.classList.toggle('is-active', on);
      measureBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) {
        hint.textContent = t('measureOn');
      } else {
        if (measurePoints.length === 1) clearMeasurement();
        hint.textContent = t('measureOff');
      }
      updateMeasureClearState();
    }
    function toggleMeasure() { setMeasureMode(!measureMode); }
    measureBtn.addEventListener('click', toggleMeasure);
    if (measureClearBtn) measureClearBtn.addEventListener('click', clearMeasurement);

    // Distinguish a measuring click from an orbit drag by pointer travel: remember
    // where the press started, then on release measure only if the pointer barely
    // moved. OrbitControls still gets the same events, so orbit keeps working.
    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (!measureMode || e.button !== 0) return;
      measureDownX = e.clientX; measureDownY = e.clientY; measureDownId = e.pointerId;
    });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!measureMode || e.button !== 0 || e.pointerId !== measureDownId) return;
      measureDownId = -1;
      // A press that traveled is an orbit drag, not a click — ignore it.
      if (Math.hypot(e.clientX - measureDownX, e.clientY - measureDownY) > MEASURE_CLICK_TOL) return;
      // Don't measure through the top-right gizmo box — its own handler owns it.
      const el = renderer.domElement;
      const inGizmoX = e.clientX >= el.clientWidth - GIZMO_DIM;
      const gTop = gizmoTop();
      const inGizmoY = e.clientY >= gTop && e.clientY <= gTop + GIZMO_DIM;
      if (inGizmoX && inGizmoY) return;
      const rect = el.getBoundingClientRect();
      measureAt(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
    });

    updateMeasureClearState(); // reflect the initial (nothing measured) state

    // --- Click-to-select a face + fit-to-selection ----------------------------
    // CAD inspection: a plain canvas click (when Measure isn't the active click
    // owner) raycasts currentModel's meshes and highlights the hit mesh by
    // emissive-tinting its OWN material — no overlay mesh/geometry is created, so
    // the "highlight resources" are just the saved material props we restore on
    // clear (nothing to dispose or leak). Emissive tint is orthogonal to
    // material.wireframe and material.opacity, so the highlight rides along with
    // the wireframe toggle and never disturbs the swap-in fade. The picked
    // sub-object name (mesh.name from the STEP child — set in src/step.js — or a
    // 'Face N' index fallback) shows in the model-info HUD. Decorative feature
    // edges already have raycast disabled (src/step.js) so they're never pickable.
    const selectFitBtn = document.getElementById('select-fit-btn');
    const miSel = document.querySelector('#model-info .mi-sel');
    const selectRay = new THREE.Raycaster();
    const _selNdc = new THREE.Vector2();
    const SELECT_EMISSIVE = 0x0f7a58;       // teal glow — distinct from measure amber
    const SELECT_EMISSIVE_INTENSITY = 0.9;
    // The current selection, or null: the picked mesh plus the material's
    // pre-highlight emissive so clearSelection restores it exactly.
    let selected = null;
    // pointerdown bookkeeping so pointerup tells a pick-click from an orbit drag
    // (mirrors the measurement tool).
    let selectDownX = 0, selectDownY = 0, selectDownId = -1;
    const SELECT_CLICK_TOL = 6; // px of travel still counted as a click

    // Resolve a human label for the picked mesh: the STEP sub-object name if the
    // loader carried one, else a 1-based index among the model's mesh children
    // (edges are children of each mesh, not of the group, so group.children are
    // all meshes).
    function selectionName(mesh) {
      if (mesh.name) return mesh.name;
      const i = currentModel ? currentModel.children.indexOf(mesh) : -1;
      return t('selectFallback', { index: i >= 0 ? i + 1 : 1 });
    }

    // Restore the previously highlighted material and drop the selection + its HUD
    // readout / Fit button. Safe to call with nothing selected. Restoring a
    // material prop (not disposing an overlay) IS the whole cleanup — no leak.
    function clearSelection(announce) {
      if (selected) {
        const m = selected.mesh.material;
        if (m && !Array.isArray(m) && m.emissive) {
          m.emissive.setHex(selected.emissive);
          m.emissiveIntensity = selected.emissiveIntensity;
          m.needsUpdate = true;
        }
        selected = null;
      }
      if (miSel) { miSel.hidden = true; miSel.textContent = ''; }
      if (selectFitBtn) selectFitBtn.hidden = true;
      if (announce) hint.textContent = t('selectCleared');
      invalidate(); // render-on-demand: redraw with the highlight emissive cleared
    }

    // Highlight `mesh` and surface its name. Clears any prior selection first so
    // only one face is ever lit. Our loaded meshes always carry a single
    // MeshStandardMaterial (see src/step.js); guard anyway.
    function selectMesh(mesh) {
      const m = mesh.material;
      if (!m || Array.isArray(m) || !m.emissive) return;
      clearSelection(false);
      selected = { mesh, emissive: m.emissive.getHex(), emissiveIntensity: m.emissiveIntensity };
      m.emissive.setHex(SELECT_EMISSIVE);
      m.emissiveIntensity = SELECT_EMISSIVE_INTENSITY;
      m.needsUpdate = true;
      const name = selectionName(mesh);
      if (miSel) { miSel.textContent = t('selectReadout', { name }); miSel.hidden = false; }
      if (selectFitBtn) selectFitBtn.hidden = false;
      hint.textContent = t('selectHint', { name });
      invalidate(); // render-on-demand: draw the selection highlight emissive
    }

    // Raycast currentModel at NDC coords: a hit selects that mesh; a miss clears
    // any current selection (click empty space to deselect).
    function pickAt(ndcX, ndcY) {
      if (!currentModel) return;
      _selNdc.set(ndcX, ndcY);
      selectRay.setFromCamera(_selNdc, camera);
      const hits = selectRay.intersectObject(currentModel, true);
      const hit = hits.find((h) => h.object && h.object.isMesh);
      if (hit) selectMesh(hit.object);
      else if (selected) clearSelection(true);
    }

    // Reframe the camera on the selected mesh's own bounds — the same aspect-aware
    // distance math and default view direction as frameObject, but with the orbit
    // target set to the selection CENTER (not the origin) so a small feature fills
    // the frame. Distinct from the global Fit, which reframes the whole model.
    function fitToSelection() {
      if (!selected) return;
      const box = new THREE.Box3().setFromObject(selected.mesh);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = 0.5 * Math.max(size.x, size.y, size.z) || 1;
      const dist = fitDistanceForRadius(radius, camera);
      camera.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.8);
      camera.near = Math.max(dist / 1000, 0.01);
      camera.far = dist * 1000;
      camera.updateProjectionMatrix();
      controls.target.copy(center);          // frame the feature, not the origin
      controls.minDistance = radius * 0.4;
      controls.maxDistance = dist * 6;
      controls.update();
    }

    if (selectFitBtn) selectFitBtn.addEventListener('click', fitToSelection);

    // Tell a pick-click from an orbit drag by pointer travel (mirrors the measure
    // tool). Selection is inert while Measure owns the click.
    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (measureMode || e.button !== 0) return;
      selectDownX = e.clientX; selectDownY = e.clientY; selectDownId = e.pointerId;
    });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (measureMode || e.button !== 0 || e.pointerId !== selectDownId) return;
      selectDownId = -1;
      // A press that traveled is an orbit drag, not a click — ignore it.
      if (Math.hypot(e.clientX - selectDownX, e.clientY - selectDownY) > SELECT_CLICK_TOL) return;
      // Don't pick through the top-right gizmo box — its own handler owns it.
      const el = renderer.domElement;
      const inGizmoX = e.clientX >= el.clientWidth - GIZMO_DIM;
      const gTop = gizmoTop();
      const inGizmoY = e.clientY >= gTop && e.clientY <= gTop + GIZMO_DIM;
      if (inGizmoX && inGizmoY) return;
      const rect = el.getBoundingClientRect();
      pickAt(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
    });

    // --- Section / cross-section clip plane ------------------------------------
    // A core CAD-inspection capability: cut through the model to inspect internal
    // geometry (wall thickness, bores, pockets). three.js does this natively with
    // no extra dependency via material clipping planes, so it stays zero-build.
    //
    // Approach — DoubleSide back-faces, not solid caps: the loaded materials
    // already render with side: THREE.DoubleSide (see src/step.js), so the cut
    // reveals the model's back-facing interior surfaces as a visible cross-section
    // rather than leaving black holes where the front faces were removed. We
    // deliberately do NOT build solid cap geometry (stencil capping is a much
    // larger, non-zero-build effort); the double-sided interior read is the chosen,
    // dependency-free approach.
    //
    // One shared THREE.Plane drives the cut for every mesh material. Because the
    // array assigned to material.clippingPlanes holds that same plane object,
    // mutating the plane's constant/normal in place (on slider drag / axis / flip)
    // is reflected on the very next render — no reassignment, so the drag is live.
    const sectionBtn = document.getElementById('section-btn');
    const sectionPanel = document.getElementById('section-panel');
    const sectionSlider = document.getElementById('section-slider');
    const sectionFlipBtn = document.getElementById('section-flip');
    const sectionAxisBtns = Array.from(document.querySelectorAll('#section-panel .sp-axis'));
    const SECTION_AXES = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
    };
    const sectionPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
    let sectionMode = false;
    let sectionAxis = 'x';
    let sectionFlip = false;

    // Assign (or clear) the shared clip plane on every material in a group. When
    // Section is on, each material gets the shared [sectionPlane]; when off, an
    // empty array restores normal, un-clipped rendering. Traverses all materials
    // (shaded meshes and, if already built, the decorative edge overlay) so the
    // cut is consistent. Called on toggle and on every fresh load/swap so a model
    // change mid-section keeps clipping.
    function applyClipping(group) {
      if (!group) return;
      const planes = sectionMode ? [sectionPlane] : [];
      group.traverse((obj) => {
        if (!obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => { m.clippingPlanes = planes; });
      });
    }

    // Position the shared plane from the current axis, flip, and slider value. The
    // model is recentered on the origin by frameObject, so the slider value is a
    // world-space cut coordinate along the axis. For an axis unit normal n and cut
    // coordinate c, the plane keeps n·p + constant > 0; with constant = -c that
    // keeps the +axis half (p·axis > c). Flip negates BOTH normal and constant so
    // the opposite half is kept instead. Mutates the plane in place (live drag).
    function updateSectionPlane() {
      const sign = sectionFlip ? -1 : 1;
      sectionPlane.normal.copy(SECTION_AXES[sectionAxis]).multiplyScalar(sign);
      const c = parseFloat(sectionSlider.value);
      sectionPlane.constant = -c * sign;
      invalidate(); // render-on-demand: redraw the moved cut plane (live drag)
    }

    // Re-derive the slider min/max from the current model's bounding box along the
    // active axis (the same Box3 math frameObject/updateModelInfo use), then place
    // the plane. `resetToMid` recenters the cut (used on enable / axis change /
    // model swap) so a fresh section starts as a clean half-cut through the middle.
    function updateSectionRange(resetToMid) {
      if (!currentModel) return;
      const box = new THREE.Box3().setFromObject(currentModel);
      if (box.isEmpty()) return;
      const lo = box.min[sectionAxis];
      const hi = box.max[sectionAxis];
      const span = (hi - lo) || 1;
      sectionSlider.min = lo;
      sectionSlider.max = hi;
      sectionSlider.step = span / 200;
      const v = parseFloat(sectionSlider.value);
      if (resetToMid || !isFinite(v) || v < lo || v > hi) {
        sectionSlider.value = (lo + hi) / 2;
      }
      updateSectionPlane();
    }

    // Turn Section mode on/off. Enabling flips on the renderer's local clipping,
    // shows the axis/slider/flip panel, derives the slider range from the model,
    // and assigns the shared plane to every material. Disabling clears the planes
    // (empty array) and turns local clipping back off, restoring normal rendering.
    function setSectionMode(on) {
      sectionMode = on;
      renderer.localClippingEnabled = on;
      sectionBtn.classList.toggle('is-active', on);
      sectionBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      sectionPanel.hidden = !on;
      if (on) {
        updateSectionRange(true);      // derive range + place the plane
        applyClipping(currentModel);   // assign the shared plane to all materials
        hint.textContent = t('sectionOn');
      } else {
        applyClipping(currentModel);   // planes = [] → restore normal rendering
        hint.textContent = t('sectionOff');
      }
      invalidate(); // render-on-demand: redraw with clipping on/off
    }
    function toggleSection() { setSectionMode(!sectionMode); }
    sectionBtn.addEventListener('click', toggleSection);

    // Axis radios: set the plane normal and re-derive the slider range for the new
    // axis (which resets the cut to the middle of that axis's extent).
    sectionAxisBtns.forEach((b) => {
      b.addEventListener('click', () => {
        sectionAxis = b.dataset.axis;
        sectionAxisBtns.forEach((o) => {
          const active = o === b;
          o.classList.toggle('is-active', active);
          o.setAttribute('aria-checked', active ? 'true' : 'false');
        });
        updateSectionRange(true);
      });
    });

    // Flip button: reverse which half of the model is kept (negate normal +
    // constant, handled by updateSectionPlane reading sectionFlip).
    sectionFlipBtn.addEventListener('click', () => {
      sectionFlip = !sectionFlip;
      sectionFlipBtn.setAttribute('aria-pressed', sectionFlip ? 'true' : 'false');
      sectionFlipBtn.classList.toggle('is-active', sectionFlip);
      updateSectionPlane();
    });

    // Slider drag: move the cut live. Only the shared plane's constant changes, so
    // the render loop shows the new cut on the next frame without reassignment.
    sectionSlider.addEventListener('input', updateSectionPlane);

    // --- Exploded view --------------------------------------------------------
    // A standard assembly-inspection tool. STEP files often hold multiple solids,
    // which occt already returns as separate meshes in the group (see step.js) but
    // renders coincident. The Explode slider (0→1) translates each top-level child
    // mesh outward along the unit vector from the group's overall bbox center to
    // that child's own bbox center, by slider × model-size × EXPLODE_SPREAD, so
    // parts spread apart and collapse cleanly back at 0.
    //
    // We cache each child's ORIGINAL local position and its (unit) explode direction
    // ONCE per loaded model (recomputed in the swap path), then drive positions from
    // the slider by writing child.position only — source geometry is never touched,
    // so it's fully reversible and costs one vector add per child per frame of drag.
    //
    // Fit interop (documented choice): a global Fit (fitView — button / F / R / Home
    // / double-click) RESETS explode to 0 before framing. That keeps frameObject's
    // bbox — and therefore groundTo's grid/shadow footprint — on the collapsed
    // model, so the ground always sits under the collapsed footprint and the fit
    // frames the real (un-spread) part. The slider snaps back to 0 to match.
    const explodePanel = document.getElementById('explode-panel');
    const explodeSlider = document.getElementById('explode-slider');
    const explodeHint = document.getElementById('explode-hint');
    const EXPLODE_SPREAD = 0.6; // fraction of the model's max dimension a part travels at slider=1
    let explodeEntries = [];    // [{ mesh, base: Vector3, dir: Vector3 }] for the live model
    let explodeScale = 1;       // model max-dimension — scales the spread distance
    let explodeMulti = false;   // true only when the model has >1 solid (enables the control)

    // Cache the per-child original position + outward explode direction and the
    // model size, from the current model's world-space bounds converted into the
    // group's local frame (child.position space). Runs after frameObject has
    // recentered the group at scale 1 and before the swap-in scale animation, so
    // the captured base positions and directions are stable. Rebuilt on every load/
    // swap so a new model never inherits the previous cache.
    function computeExplode() {
      explodeEntries = [];
      explodeScale = 1;
      explodeMulti = false;
      if (!currentModel) return;
      currentModel.updateWorldMatrix(true, true);
      const groupBox = new THREE.Box3().setFromObject(currentModel);
      if (groupBox.isEmpty()) return;
      const size = groupBox.getSize(new THREE.Vector3());
      explodeScale = Math.max(size.x, size.y, size.z) || 1;
      // Overall center, expressed in the group's local coordinate space so the
      // resulting direction can be added straight onto child.position.
      const overall = currentModel.worldToLocal(groupBox.getCenter(new THREE.Vector3()));
      const meshes = currentModel.children.filter((c) => c.isMesh);
      explodeMulti = meshes.length > 1;
      for (const mesh of meshes) {
        const cbox = new THREE.Box3().setFromObject(mesh);
        if (cbox.isEmpty()) continue;
        const center = currentModel.worldToLocal(cbox.getCenter(new THREE.Vector3()));
        const dir = center.sub(overall); // group-local translation cancels → world-space direction
        if (dir.lengthSq() > 1e-10) dir.normalize();
        else dir.set(0, 0, 0); // a solid centered on the overall center simply doesn't move
        explodeEntries.push({ mesh, base: mesh.position.clone(), dir });
      }
    }

    // Drive child positions from a slider value t in [0,1]. Writes only
    // child.position (no geometry mutation), so t=0 restores every base exactly.
    function applyExplode(t) {
      const amt = t * explodeScale * EXPLODE_SPREAD;
      for (const e of explodeEntries) {
        e.mesh.position.copy(e.base).addScaledVector(e.dir, amt);
      }
      invalidate(); // render-on-demand: redraw the spread/collapsed parts
    }

    // Reset the slider to 0, collapse the parts, and set the control's enabled/hint
    // state for the freshly loaded model. Called from the swap path after
    // computeExplode so a new model always starts collapsed and never inherits the
    // previous explode state or enabled/disabled state.
    function refreshExplodeControl() {
      explodeSlider.value = '0';
      applyExplode(0);
      explodeSlider.disabled = !explodeMulti;
      explodeHint.hidden = explodeMulti;
      explodePanel.classList.toggle('is-disabled', !explodeMulti);
      if (explodeMulti) explodePanel.removeAttribute('title');
      else explodePanel.title = t('explodeSingle'); // tooltip on the panel for the disabled control
    }

    // Collapse the model and snap the slider back to 0. Used by the global Fit so
    // framing + ground footprint are computed on the collapsed model.
    function resetExplode() {
      if (!explodeEntries.length) return;
      explodeSlider.value = '0';
      applyExplode(0);
    }

    explodeSlider.addEventListener('input', () => {
      applyExplode(parseFloat(explodeSlider.value) || 0);
    });

    // --- Parts panel (assembly / multi-solid part list) -----------------------
    // step.js builds one THREE.Mesh per occt solid and exposes them (index + name
    // + mesh) on group.userData.parts. This panel lists them and drives each
    // mesh's `visible` live so a user can hide one body to inspect another — the
    // core assembly-inspection need (issue #94). Rebuilt from scratch on every
    // model swap (buildPartsPanel) so a previous model's rows/mesh references
    // never leak; shown only when the model has more than one part.
    //
    // model-info tris count is deliberately TOTAL-MODEL and is NOT recomputed when
    // parts are toggled here (updateModelInfo runs only on load). The panel's own
    // "visible/total" badge is the live per-visibility read-out, so the two
    // read-outs stay consistent and unambiguous.
    const partsPanel = document.getElementById('parts-panel');
    const partsToggle = document.getElementById('parts-toggle');
    const partsCountEl = partsPanel.querySelector('.pp-count');
    const partsList = document.getElementById('parts-list');
    const partsShowAll = document.getElementById('parts-show-all');
    const partsHideAll = document.getElementById('parts-hide-all');
    const PARTS_COLLAPSED_KEY = 'stepviewer.partscollapsed';
    let partsCollapsed = false;
    (function readStoredPartsCollapsed() {
      try {
        const v = localStorage.getItem(PARTS_COLLAPSED_KEY);
        // Default: collapsed on a narrow (<600px) viewport so the panel never
        // overruns the cramped layout; expanded otherwise. An explicit stored
        // choice wins over the width default.
        partsCollapsed = v === null ? window.matchMedia('(max-width: 600px)').matches : v === '1';
      } catch (e) {}
    })();
    let partRows = []; // [{ mesh, input, row }] for the live model — cleared on swap

    // Reflect the current collapse state onto the panel + toggle button.
    function applyPartsCollapsed() {
      partsPanel.classList.toggle('is-collapsed', partsCollapsed);
      partsToggle.setAttribute('aria-expanded', partsCollapsed ? 'false' : 'true');
    }

    // Update the header badge to visible/total (e.g. "3 / 5") so the live count
    // reflects toggles without touching the model-info tris semantics.
    function refreshPartsCount() {
      const total = partRows.length;
      const shown = partRows.reduce((n, r) => n + (r.mesh.visible ? 1 : 0), 0);
      partsCountEl.textContent = t('partsCount', { count: shown === total ? String(total) : `${shown} / ${total}` });
    }

    // Set one part's visibility and reflect it in its row. The deferred edge-lines
    // overlay is a child of the mesh, so toggling mesh.visible hides/shows the
    // edges with it — no separate handling needed.
    function setPartVisible(entry, visible) {
      entry.mesh.visible = visible;
      entry.input.checked = visible;
      entry.row.classList.toggle('is-hidden', !visible);
    }

    // Tear down the panel: drop all rows (and their mesh references, so a swapped-
    // out model can be GC'd) and hide it. Called on reset and at the top of every
    // rebuild.
    function disposePartsPanel() {
      partRows = [];
      partsList.replaceChildren();
      partsPanel.hidden = true;
    }

    // Rebuild the panel for the freshly loaded model. No-op-hides for a single-part
    // model (nothing to differentiate). One row per part, checkbox reflecting the
    // mesh's current visibility (always visible on a fresh load).
    function buildPartsPanel(model) {
      disposePartsPanel();
      const parts = (model && model.userData && model.userData.parts) || [];
      if (parts.length <= 1) return; // single body → nothing to list
      const frag = document.createDocumentFragment();
      parts.forEach((part) => {
        const label = part.name || t('partsFallback', { n: part.index + 1 });
        const li = document.createElement('li');
        li.className = 'pp-row';
        const lab = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = part.mesh.visible !== false;
        input.setAttribute('aria-label', t('partsRowAria', { name: label }));
        const name = document.createElement('span');
        name.className = 'pp-name';
        name.textContent = label;
        name.title = label; // full name on hover when ellipsized
        lab.append(input, name);
        li.append(lab);
        frag.append(li);
        const entry = { mesh: part.mesh, input, row: li };
        input.addEventListener('change', () => {
          setPartVisible(entry, input.checked);
          refreshPartsCount();
          invalidate(); // render-on-demand: reflect the visibility change live
        });
        partRows.push(entry);
      });
      partsList.append(frag);
      refreshPartsCount();
      applyPartsCollapsed();
      partsPanel.hidden = false;
    }

    function setAllParts(visible) {
      for (const entry of partRows) setPartVisible(entry, visible);
      refreshPartsCount();
      invalidate();
    }

    partsShowAll.addEventListener('click', () => setAllParts(true));
    partsHideAll.addEventListener('click', () => setAllParts(false));
    partsToggle.addEventListener('click', () => {
      partsCollapsed = !partsCollapsed;
      applyPartsCollapsed();
      try { localStorage.setItem(PARTS_COLLAPSED_KEY, partsCollapsed ? '1' : '0'); } catch (e) {}
    });

    // Parse an ArrayBuffer and swap it into the scene, disposing whatever model
    // (or placeholder) is currently shown. `label` is used for the hint text.
    async function showStepFromArrayBuffer(buf, label, ext, onPhase, camState) {
      // Pass the active feature-edge style so a fresh load in high contrast builds
      // its (idle-deferred) edge overlay crisp from the start, not faint-then-fixed.
      // Pass invalidate as onEdgesReady so the idle-deferred edge overlay triggers
      // a redraw when it attaches — the render-on-demand loop may have parked after
      // first render, so the edges would otherwise wait for the next camera move.
      // `ext` selects the occt reader (STEP / IGES / BREP) inside the loader; the
      // rest of the swap path is format-agnostic (all three yield the same meshes).
      const model = await loadCadFromArrayBuffer(buf, ext, onPhase, currentEdgeStyle(), invalidate);
      // Non-finite bounding-box guard (issue #98): a partial/subtly-malformed file
      // can parse to success yet carry NaN/±Infinity vertex positions. The empty-
      // geometry guard (#97) in the loader only catches a zero-vertex mesh list —
      // a box built from NaN coordinates is NOT empty, so it slips through. If we
      // let it reach frameObject it would set camera.position/near/far to NaN and
      // black out the scene with no recovery. Check the parsed group's Box3 HERE,
      // before any teardown: if it's non-finite, throw kind:'degenerate' so the
      // catch surfaces a toast and the previous model/placeholder + active pill are
      // all preserved (nothing below runs — no dispose, no camera move).
      const parsedBox = new THREE.Box3().setFromObject(model);
      if (!isFiniteBox(parsedBox)) {
        disposeGroup(model); // free the just-built (unusable) GPU buffers; not added to the scene
        const e = new Error('parsed geometry has non-finite bounding box');
        e.kind = 'degenerate';
        throw e;
      }
      // Only tear down the old scene contents once the new parse succeeds.
      if (placeholder.parent) {
        scene.remove(placeholder);
        placeholder.geometry.dispose();
        placeholder.material.dispose();
      }
      // Drop any face selection from the outgoing model while its material is
      // still valid (restores the emissive, hides the readout / Fit button) so a
      // stale highlight/selection can't carry onto the incoming model.
      clearSelection(false);
      if (currentModel) {
        scene.remove(currentModel);
        disposeGroup(currentModel);
      }
      // Tear down any measurement from the outgoing model so markers/line/label
      // never linger onto — or measure against — the incoming one.
      clearMeasurement();
      spin = null;
      currentModel = model;
      currentModelLabel = label; // remember for the Save-image PNG filename
      scene.add(model);
      applyWireframe(model); // honor the current toggle on the freshly loaded model
      applyMaterialPreset(model); // adopt the persisted material/lighting preset
      applyColorByPart(model); // re-apply color-by-part hues over the preset finish
      // Re-assert blueprint mode on the freshly loaded model: force-build its edges
      // (idle build hasn't run yet), hide its faces, recolor edges + backdrop. The
      // outgoing model's force-built edges were freed by disposeGroup above (no
      // GPU leak across the swap). frameObject's groundTo below re-hides the grid
      // via its own blueprint guard.
      if (blueprint) applyBlueprint(true);
      frameObject(model); // frame at scale 1 before the transition shrinks it
      // Reapply the section clip plane to the freshly loaded meshes so switching
      // models mid-section keeps cutting. frameObject has just recentered the model
      // on the origin, so re-derive the slider range from the new model's bbox and
      // re-center the cut. When section is off, applyClipping assigns [] (no-op cut).
      if (sectionMode) updateSectionRange(true);
      applyClipping(model);
      // Cache each solid's base position + outward explode direction from the
      // freshly framed (recentered, scale-1) model, then reset the control to 0 so
      // the new model starts collapsed and never inherits the previous explode
      // state. Multi-solid enables the slider; single-solid disables it with a hint.
      computeExplode();
      refreshExplodeControl();
      explodePanel.hidden = false; // reveal the control now a model is on screen
      // Deep-link restore: if a saved camera state came with the load (from the
      // URL hash), override frameObject's default placement with it, then let
      // controls.update() settle (and clamp to the just-set min/maxDistance). A
      // link with only a sample key (no camera) leaves the auto-fit framing.
      if (camState) applyCameraState(camState);
      updateModelInfo(model, label); // refresh the name/tris/dims HUD for the swap
      buildPartsPanel(model); // rebuild the per-part visibility list for the swap
      updateExportState(); // a real model is now loaded — enable the Export GLB button
      startSwapIn(model); // ease the new model in (scale + fade) instead of popping
      markFirstRender(); // first successful render clears the loader + stall watch
      hideEngineError(); // a successful load supersedes any engine-failure panel
      hint.textContent = t('loadedHint', { label, zoom: zoomHint });
    }

    // --- Large-file guard (issues #90, #100) -----------------------------------
    // occt-import-js reads a whole file into memory and tessellates it against the
    // tab's memory budget, so a multi-hundred-MB STEP (common for full assemblies)
    // can spike memory and freeze the tab for tens of seconds behind the spinner —
    // indistinguishable from a hang — or OOM the WASM heap outright. Guard on the
    // user-supplied byte size BEFORE the blob is read/parsed. This is a pure,
    // client-side length check (File.size needs no read) — no backend, no streaming,
    // zero-build.
    //
    // Applies ONLY to user File objects (open / drag-drop / the switchable pills of
    // a multi-file drop, all of which read through loadFile). The bundled gallery
    // samples are deliberately NOT gated (issue #100): they are known-small, shipped
    // fetches, not user Files, so prompting on them would be pure noise.
    //
    // Two tiers so the feedback is proportionate:
    //   • SOFT (≥ 40 MB): a non-blocking toast — "getting large, may be slow" — then
    //     parse anyway. Purely informational.
    //   • HARD (≥ 50 MB): a blocking confirm() naming the file + size in MB; parse
    //     ONLY on confirm. This is the LARGE_FILE threshold issue #100 calls out —
    //     50 MB is where a synchronous main-thread parse starts risking multi-second
    //     freezes / OOM on modest devices, so it's the defensible line to make the
    //     user reconsider. A cancel returns false and the caller must be a true
    //     no-op (no read, no spinner, current model untouched — see loadFile).
    const SOFT_LIMIT_BYTES = 40 * 1024 * 1024;  // 40 MB — non-blocking warn, then parse
    const HARD_LIMIT_BYTES = 50 * 1024 * 1024;  // 50 MB — explicit confirm before parsing
    // fmtMB now lives in ./ui.js (imported above).

    // Gate a load by byte size. Returns true to proceed, false to abort (the
    // caller must leave the current model, hint, and spinner untouched). Soft-over:
    // surface a non-blocking toast via the existing channel, then proceed.
    // Hard-over: require an explicit confirm(); a cancel returns false so nothing
    // is read or parsed.
    function guardFileSize(bytes, label) {
      if (bytes >= HARD_LIMIT_BYTES) {
        return window.confirm(t('sizeHardConfirm', { label, size: fmtMB(bytes) }));
      }
      if (bytes >= SOFT_LIMIT_BYTES) {
        showToast(t('sizeSoftWarn', { label, size: fmtMB(bytes) }));
      }
      return true;
    }

    // Read a user-supplied File and load it, reporting failures via the hint.
    async function loadFile(file) {
      retryAction = () => loadFile(file); // Retry re-reads + re-loads this file
      // Reject a file whose extension isn't a CAD format occt can read BEFORE
      // reading bytes or touching the engine — the file picker's `accept` filter
      // isn't enforced (a user can still choose "All files"), so surface the same
      // not-a-CAD-file hint the drag-drop guard uses instead of a doomed parse.
      const ext = extOf(file.name);
      if (!readerForExtension(ext)) {
        hint.textContent = t('notStepFile', { name: file.name });
        return;
      }
      // Guard on File.size before reading the blob into memory or parsing. A
      // hard-limit cancel returns immediately — the current model, hint, and
      // loader are all left untouched (the loader was never armed for this load).
      if (!guardFileSize(file.size, file.name)) return;
      hint.textContent = t('loading', { label: file.name });
      armStallOnFirstUserLoad(); // reduced-data: arm the watchdog on this first real load
      setLoading(true);
      try {
        const buf = await file.arrayBuffer();
        await showStepFromArrayBuffer(buf, file.name, ext);
        // A user file is a local blob with no restorable URL — clear the sample
        // part of the hash so a stale sample link can't be shared for this view.
        currentSampleFile = null;
        writeHash();
        updateShareState(); // a user file isn't shareable — disable the copy-link button
        updateEmbedState(); // …nor embeddable — disable the copy-embed-code button
      } catch (err) {
        console.error('STEP load failed:', err);
        hint.textContent = t('couldNotLoadConsole', { label: file.name });
        // Nothing valid rendered (a prior model, if any, is still on screen and
        // keeps its accurate summary) — reset the accessible name so AT users
        // aren't told a stale successful model is loaded.
        if (!currentModel) resetModelInfo();
        // An engine/CDN failure isn't self-clearing — surface the persistent
        // Retry panel. Per-file parse/http errors stay on the lighter toast.
        if (err && err.kind === 'init') showEngineError();
        else showToast(describeError(err, file.name));
      } finally {
        setLoading(false);
      }
    }

    // --- Sample gallery ---
    // Bundled models under ./samples/. Each parses via occt-import-js (verified
    // in CI-style node checks) and loads through the same path as user files.
    // Labels route through the string table so gallery pills, the hint, and the
    // model-info HUD all read the model name in the active locale.
    // Gallery models come from the shared SAMPLE_MANIFEST (src/step-core.js) — the
    // single source of truth the parse test also reads (issue #109), so the app's
    // list and the test's list can never drift. The manifest carries only stable
    // data (on-disk file name + i18n labelKey); resolve the localized display label
    // here via t() so a locale switch relabels the pills. Shape ({ file, label }) is
    // exactly what loadSample/parseHash/the pills already consume — including the
    // IGES sample, which the manifest carries alongside the STEP ones.
    const SAMPLES = SAMPLE_MANIFEST.map((s) => ({ file: s.file, label: t(s.labelKey) }));

    const gallery = document.getElementById('gallery');

    // --- Deep-link / shareable-view hash --------------------------------------
    // The only durable state channel on a static GitHub Pages site is the URL, so
    // encode a compact restorable view in location.hash: the bundled sample key
    // (stable file name, locale-independent — never the localized label) plus the
    // camera position + orbit target needed to reproduce the shot. Coordinates are
    // rounded to a few significant digits to keep the hash short. Only bundled
    // samples are encoded; user-opened blobs can't be restored without a backend.

    // roundSig now lives in ./ui.js (imported above).

    // Apply a restored camera state (arrays of 3 numbers): set the camera position
    // and orbit target, refresh the projection, and let OrbitControls settle. Runs
    // after frameObject, so it overrides the default auto-fit placement.
    function applyCameraState(cam) {
      camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
      controls.target.set(cam.target[0], cam.target[1], cam.target[2]);
      camera.updateProjectionMatrix();
      controls.update();
    }

    // Serialize the current view into location.hash via replaceState (so it never
    // spams the back-stack). With no bundled sample on screen (a user file, or
    // nothing) the sample part is cleared: strip the hash entirely. Encodes as
    // `#m=<file>&c=x,y,z,tx,ty,tz`.
    function writeHash() {
      if (!currentSampleFile) {
        if (location.hash) {
          history.replaceState(null, '', location.pathname + location.search);
        }
        return;
      }
      const p = camera.position;
      const tg = controls.target;
      const c = [p.x, p.y, p.z, tg.x, tg.y, tg.z].map(roundSig).join(',');
      // Preserve the `embed` flag across camera-settle rewrites so an embedded
      // frame's own URL stays a valid embed link (this replaceState would
      // otherwise drop the flag the head script read at startup). Detecting
      // embed mode from the <html> class avoids re-parsing the hash each write.
      const embedSuffix = EMBED_MODE ? '&embed=1' : '';
      const hash = `#m=${encodeURIComponent(currentSampleFile)}&c=${c}${embedSuffix}`;
      history.replaceState(null, '', hash);
    }

    // Parse location.hash into a restore descriptor, or null to fall back to the
    // normal default auto-load. Returns { sample, cam } where cam is null when the
    // link carries only a sample key (→ normal auto-fit framing) or when the camera
    // values are malformed. An unknown/garbage sample key returns null (graceful
    // fallback). Never throws.
    function parseHash() {
      try {
        const h = location.hash.replace(/^#/, '');
        if (!h) return null;
        const params = new URLSearchParams(h);
        const key = params.get('m');
        if (!key) return null;
        const sample = SAMPLES.find((s) => s.file === key);
        if (!sample) return null; // unknown/garbage sample key → default auto-load
        let cam = null;
        const c = params.get('c');
        if (c) {
          const nums = c.split(',').map(Number);
          // Only accept a complete, all-finite 6-tuple; anything malformed falls
          // through as cam=null so the sample still loads at auto-fit framing.
          if (nums.length === 6 && nums.every((n) => Number.isFinite(n))) {
            cam = { pos: nums.slice(0, 3), target: nums.slice(3, 6) };
          }
        }
        return { sample, cam };
      } catch (e) {
        return null;
      }
    }

    // Debounced hash refresh on camera settle. OrbitControls fires 'change' on
    // every mutated frame (pointer orbit/zoom/pan, wheel, damping tail, the
    // keyboard camera keys, and gizmo snaps — all of which call controls.update()),
    // so coalesce with a timer and write once the view has settled instead of
    // thrashing history every frame. writeHash uses replaceState, so no back-stack
    // spam. No-op while no bundled sample is on screen (writeHash guards on it).
    let hashWriteTimer = null;
    function scheduleHashWrite() {
      clearTimeout(hashWriteTimer);
      hashWriteTimer = setTimeout(writeHash, 500);
    }
    controls.addEventListener('change', scheduleHashWrite);
    // Render-on-demand: every camera mutation (orbit/zoom/pan, wheel, keyboard
    // camera keys, gizmo/preset snaps) and the damping tail fire 'change', so this
    // single wiring both draws the change and keeps the loop alive until the
    // OrbitControls damping settles — then it goes quiet on its own.
    controls.addEventListener('change', invalidate);

    // Fetch + parse + render a bundled sample, reusing the model-swap path so the
    // placeholder / previous model is disposed exactly as with user files.
    async function loadSample(sample, camState) {
      retryAction = () => loadSample(sample, camState); // Retry re-fetches + re-loads this sample
      const buttons = gallery.querySelectorAll('.sample');
      buttons.forEach((b) => { b.disabled = true; });
      // Keep the first-paint guidance visible during the initial auto-load; only
      // swap to a per-load "Loading…" message once the user is past first render.
      if (firstRenderDone) hint.textContent = t('loading', { label: sample.label });
      // The initial auto-load (before first render) gets staged textual status —
      // engine init then parse — beneath the spinner; subsequent loads keep the
      // lighter bare spinner. onPhase is only wired for that first load.
      const staged = !firstRenderDone;
      const onPhase = staged
        ? (phase) => setLoadStatus(
            phase === 'parse' ? t('loadStatusParse') : t('loadStatusEngine'))
        : null;
      if (staged) setLoadStatus(t('loadStatusEngine'));
      armStallOnFirstUserLoad(); // reduced-data: arm the watchdog on this first real load
      setLoading(true);
      try {
        const res = await fetch(`./samples/${sample.file}`);
        if (!res.ok) {
          // Non-2xx is a fetch/HTTP problem, not a parse failure — tag it so the
          // toast doesn't wrongly blame parsing.
          const e = new Error(`${sample.file} HTTP ${res.status}`);
          e.kind = 'http';
          throw e;
        }
        const buf = await res.arrayBuffer();
        // NOTE (issue #100): bundled gallery samples are intentionally NOT run
        // through guardFileSize. They are known-small assets we ship and fetch (not
        // user-supplied File objects), so a size prompt here would only be noise —
        // the guard exists to protect the tab from arbitrarily large USER files.
        // Derive the reader from the bundled file name (the label is localized and
        // has no extension) so an .iges/.brep sample routes to the right occt reader.
        await showStepFromArrayBuffer(buf, sample.label, extOf(sample.file), onPhase, camState);
        // This bundled sample is now on screen and restorable — record its key and
        // update the shareable hash (auto-fit camera, or the restored one if this
        // load came from a deep link).
        currentSampleFile = sample.file;
        writeHash();
        updateShareState(); // a bundled sample is shareable — enable the copy-link button
        updateEmbedState(); // …and embeddable — enable the copy-embed-code button
        // Highlight the pill for the model now on screen.
        buttons.forEach((b) => {
          const active = b.dataset.file === sample.file;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      } catch (err) {
        console.error('STEP load failed:', err);
        hint.textContent = t('couldNotLoadConsole', { label: sample.label });
        // Revert the accessible name only when nothing valid is on screen; a
        // previously loaded model keeps its own (still-accurate) summary.
        if (!currentModel) resetModelInfo();
        // Engine/CDN failure → persistent Retry panel; parse/http → light toast.
        if (err && err.kind === 'init') showEngineError();
        else showToast(describeError(err, sample.label));
      } finally {
        buttons.forEach((b) => { b.disabled = false; });
        setLoading(false);
        // Clear the staged status line too; on success markFirstRender already
        // cleared it, on failure this ensures it doesn't linger past the toast.
        if (staged) setLoadStatus(null);
      }
    }

    SAMPLES.forEach((sample, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sample';
      btn.textContent = sample.label;
      btn.dataset.file = sample.file;
      btn.setAttribute('aria-pressed', 'false');
      // Surface the number-key shortcut (1–4) on the pill so it's discoverable.
      btn.title = t('sampleTitle', { label: sample.label, n: i + 1 });
      btn.addEventListener('click', () => loadSample(sample));
      gallery.appendChild(btn);
    });

    // Respect prefers-reduced-data: on metered/limited connections, the heavy
    // startup cost (three.js + occt/WASM engine + a multi-MB sample STEP file)
    // must not be paid before the user asks. Read the query once at boot.
    const reduceData = matchMedia('(prefers-reduced-data: reduce)').matches;

    if (reduceData) {
      // Nothing is downloading yet — clear the static "Loading 3D engine…"
      // spinner + status line so the page doesn't imply a fetch is underway,
      // and invite the user to pick a model. The gallery pills are keyboard-
      // focusable buttons, so the reworded #hint prompt plus the pills form the
      // keyboard-first entry point. The stall watchdog and the staged engine-
      // loading spinner stay disarmed until the user's first real load (see
      // armStallOnFirstUserLoad + the `staged` path in loadSample/loadFile),
      // exactly honoring the reduced-data intent.
      setLoading(false);
      setLoadStatus(null);
      hint.textContent = coarsePointer ? t('reducedDataCoarse') : t('reducedDataFine');
    } else {
      // Show a bundled sample on page load. Arm the stall watchdog for this
      // initial engine + model download so a slow/broken CDN doesn't hang forever.
      // Parse a deep-link hash FIRST: a valid sample key loads that sample (with
      // its saved camera, if any) instead of SAMPLES[0]; an unknown key or a
      // malformed hash falls through to the normal default auto-load.
      startStallWatch();
      const restore = parseHash();
      if (restore) loadSample(restore.sample, restore.cam);
      else loadSample(SAMPLES[0]);
    }

    // In reduced-data mode the boot-time stall watchdog is deferred, so the
    // FIRST user-initiated load arms it (once) — a slow/broken engine download
    // on that genuine request still can't spin forever. No-op after the first
    // render, and in default mode (where boot already armed it) since reduceData
    // is false. Called from both loadSample and loadFile.
    function armStallOnFirstUserLoad() {
      if (reduceData && !firstRenderDone) startStallWatch();
    }

    // --- Wireframe toggle (checkbox + `W` key) ---
    const wireCheck = document.getElementById('wire-check');
    const wireToggle = document.getElementById('wire-toggle');
    function setWireframe(on) {
      wireframe = on;
      wireCheck.checked = on;
      // Accent the whole control when on (mirrors the gallery is-active pill) so
      // the state reads beyond the checkbox tick.
      wireToggle.classList.toggle('is-active', on);
      applyWireframe(currentModel);
      invalidate(); // render-on-demand: redraw the toggled wireframe
    }
    wireCheck.addEventListener('change', () => setWireframe(wireCheck.checked));

    // --- Material & lighting presets (Studio / Technical / Clay / X-ray) -------
    // The mesh materials are built as a single machined-metal look in src/step.js
    // (each mesh also stashing its resolved occt color on
    // `mesh.userData.baseColor`). These presets recolor + re-shade every mesh
    // material in place — mutating the existing MeshStandardMaterial rather than
    // replacing it — so the wireframe toggle, the section clip planes
    // (material.clippingPlanes), and any live face-selection emissive glow all
    // ride along untouched. Each preset writes the FULL set of props it varies so
    // switching back to Studio fully restores the default look. The choice is
    // persisted and re-applied to every newly loaded model (gallery/file/drop) via
    // showStepFromArrayBuffer's applyMaterialPreset call.
    const MATERIAL_KEY = 'stepviewer.material';
    const MAT_TECHNICAL_BASE = 0xb8bfc7; // neutral light-grey for uniform readable shading
    const MAT_CLAY_BASE = 0xb06a43;      // warm terracotta
    const MATERIAL_PRESETS = {
      // Studio — the original machined-metal PBR (matches src/step.js exactly).
      studio: (m, base) => {
        m.color.copy(base);
        m.metalness = 0.85; m.roughness = 0.3; m.envMapIntensity = 1.15;
        m.transparent = false; m.opacity = 1; m.depthWrite = true;
      },
      // Technical — flat neutral grey, near-zero metalness + high roughness so the
      // IBL barely reflects: uniform matte shading that reads surface form.
      technical: (m) => {
        m.color.setHex(MAT_TECHNICAL_BASE);
        m.metalness = 0.05; m.roughness = 0.85; m.envMapIntensity = 0.3;
        m.transparent = false; m.opacity = 1; m.depthWrite = true;
      },
      // Clay — matte warm terracotta, no metalness or reflections (shape review).
      clay: (m) => {
        m.color.setHex(MAT_CLAY_BASE);
        m.metalness = 0.0; m.roughness = 1.0; m.envMapIntensity = 0.0;
        m.transparent = false; m.opacity = 1; m.depthWrite = true;
      },
      // X-ray — translucent so overlapping solids read as see-through; depthWrite
      // off so back faces show through (DoubleSide is kept by applyMaterialPreset).
      xray: (m, base) => {
        m.color.copy(base);
        m.metalness = 0.1; m.roughness = 0.6; m.envMapIntensity = 0.5;
        m.transparent = true; m.opacity = 0.25; m.depthWrite = false;
      },
    };

    // Resolve the persisted preset (default Studio so the out-of-the-box look is
    // unchanged). Read before the first model loads so the initial
    // showStepFromArrayBuffer applies it.
    let materialPreset = 'studio';
    (function readStoredMaterial() {
      let stored = null;
      try { stored = localStorage.getItem(MATERIAL_KEY); } catch (e) {}
      if (MATERIAL_PRESETS[stored]) materialPreset = stored;
    })();

    // Apply the active preset over every mesh material in a group. Skips the
    // deferred feature-edge LineSegments (they're children of each mesh, not
    // meshes themselves) so the edge overlay is never disposed or restyled here.
    function applyMaterialPreset(group) {
      if (!group) return;
      const apply = MATERIAL_PRESETS[materialPreset] || MATERIAL_PRESETS.studio;
      const xray = materialPreset === 'xray';
      group.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        // Fall back to the live color if a mesh somehow lacks a stashed base
        // (older group / non-STEP mesh) so recolor-then-restore is still stable.
        const base = obj.userData.baseColor || obj.material.color;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          apply(m, base);
          m.side = THREE.DoubleSide; // every preset keeps DoubleSide (esp. X-ray)
          m.needsUpdate = true;
        });
        // X-ray is transparent with depthWrite off: draw it after the ground grid
        // (renderOrder 0) and contact shadow (renderOrder 1) so it blends over
        // them without z-fighting. Opaque presets render in the normal order.
        obj.renderOrder = xray ? 3 : 0;
      });
    }

    const materialSelect = document.getElementById('material-select');
    const materialToggle = document.getElementById('material-toggle');
    function setMaterialPreset(preset, persist) {
      if (!MATERIAL_PRESETS[preset]) preset = 'studio';
      materialPreset = preset;
      materialSelect.value = preset;
      // Accent the pill for any non-default preset (mirrors the wireframe toggle's
      // is-active on-state) so a non-Studio look reads at a glance.
      materialToggle.classList.toggle('is-active', preset !== 'studio');
      if (persist) { try { localStorage.setItem(MATERIAL_KEY, preset); } catch (e) {} }
      applyMaterialPreset(currentModel);
      // The preset repaints every mesh from its base/preset color, so re-assert the
      // color-by-part hues on top when the mode is active (preset owns the finish,
      // color-by-part owns the hue). No-op when the mode is off.
      applyColorByPart(currentModel);
      invalidate(); // render-on-demand: redraw the re-shaded materials
    }
    // Sync the control to the resolved initial preset (no persist, no model yet).
    materialSelect.value = materialPreset;
    materialToggle.classList.toggle('is-active', materialPreset !== 'studio');
    materialSelect.addEventListener('change', () => setMaterialPreset(materialSelect.value, true));

    // --- Color-by-part mode (multi-solid assemblies) --------------------------
    // occt-import-js returns one resultMesh per solid, and step.js builds one
    // THREE.Mesh per solid straight into the group — so a multi-body assembly is
    // already `group.children` of separate meshes, but they all share the same
    // accent/occt color and render as one indistinguishable blob. Color-by-part
    // gives each mesh a distinct hue by child index so the parts read apart, a
    // core CAD-inspection need. It drives ONLY material.color — the active
    // material preset still owns metalness/roughness/opacity (the finish) — so it
    // composes with Studio/Technical/Clay/X-ray rather than replacing them.
    //
    // Palette: a qualitative, colorblind-considerate set (Paul Tol's 'muted'
    // scheme plus a couple of extra hues — 10 distinct colors chosen to stay
    // separable under the common deutan/protan/tritan confusions). Indices cycle
    // with `% length` so assemblies with more parts than colors still get a legal
    // color for every mesh.
    const PART_PALETTE = [
      0x332288, // indigo
      0x88ccee, // cyan
      0x44aa99, // teal
      0x117733, // green
      0x999933, // olive
      0xddcc77, // sand
      0xcc6677, // rose
      0x882255, // wine
      0xaa4499, // purple
      0xee8866, // orange
    ];
    const COLORPART_KEY = 'stepviewer.colorbypart';

    // Assign each mesh a palette color by child index (cycling), touching only
    // material.color so the current preset's finish (metalness/roughness/opacity)
    // is preserved. No-ops when the mode is off — the OFF restore path re-runs the
    // material preset (see setColorByPart), which repaints each mesh from its
    // captured `userData.baseColor` (Studio) or the preset's own hue, making the
    // toggle fully non-destructive. Iterates group.children directly (all group
    // children are meshes; the deferred edge LineSegments are children of each
    // mesh, not of the group) so the per-part index matches the visible solids.
    function applyColorByPart(group) {
      if (!group || !colorByPart) return;
      let i = 0;
      group.children.forEach((mesh) => {
        if (!mesh.isMesh || !mesh.material) return;
        const hex = PART_PALETTE[i % PART_PALETTE.length];
        i += 1;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => { m.color.setHex(hex); m.needsUpdate = true; });
      });
    }

    // countParts now lives in ./scene.js (imported above).

    // Resolve the persisted toggle (default off so the out-of-the-box look is the
    // machined-metal accent). Read before the first model loads so the initial
    // showStepFromArrayBuffer applies it.
    let colorByPart = false;
    (function readStoredColorByPart() {
      try { colorByPart = localStorage.getItem(COLORPART_KEY) === '1'; } catch (e) {}
    })();

    const colorPartBtn = document.getElementById('colorpart-btn');
    function setColorByPart(on, persist) {
      colorByPart = on;
      colorPartBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      colorPartBtn.classList.toggle('is-active', on);
      if (persist) { try { localStorage.setItem(COLORPART_KEY, on ? '1' : '0'); } catch (e) {} }
      // ON: paint palette hues over the current preset finish. OFF: re-run the
      // material preset, which restores each mesh's captured baseColor (Studio) or
      // the preset's own color + finish — a non-destructive round-trip.
      if (on) applyColorByPart(currentModel);
      else applyMaterialPreset(currentModel);
      // Refresh the HUD so the part-count note appears/disappears with the mode.
      if (currentModel && currentModelLabel != null) updateModelInfo(currentModel, currentModelLabel);
      invalidate(); // render-on-demand: redraw with/without per-part hues
    }
    // Sync the control to the resolved initial state (no persist, no model yet).
    colorPartBtn.setAttribute('aria-pressed', colorByPart ? 'true' : 'false');
    colorPartBtn.classList.toggle('is-active', colorByPart);
    function toggleColorByPart() { setColorByPart(!colorByPart, true); }
    colorPartBtn.addEventListener('click', toggleColorByPart);

    // --- High-contrast theme toggle (header button + `C` key) ---
    // CSS themes the DOM via the data-contrast attribute (set pre-paint by the
    // head script); here we wire the toggle, keep aria-pressed in sync, persist
    // the choice, and push the higher-contrast colors into the WebGL scene
    // (feature edges + ground grid) which CSS can't reach.
    const contrastBtn = document.getElementById('contrast-btn');
    const CONTRAST_KEY = 'step-viewer-contrast';

    // Re-style the current model's feature-edge overlay in place for the active
    // contrast mode. Edges are decorative LineSegments children of each mesh
    // (built in an idle slot by step.js). The ground grid is a sibling in the
    // scene, not inside currentModel, so traversing the model never touches it.
    function applyEdgeContrast(group) {
      if (!group) return;
      const style = currentEdgeStyle();
      group.traverse((obj) => {
        if (!obj.isLineSegments || !obj.material) return;
        obj.material.color.setHex(style.color);
        obj.material.opacity = style.opacity;
        obj.material.needsUpdate = true;
      });
    }

    // Apply a high/normal choice: flip the flag, set the DOM attribute (drives the
    // CSS palette), sync aria-pressed, optionally persist, then recolor the scene
    // — rebuild the grid at its last framed size (no camera change; the swap-in
    // fade is untouched and still reduced-motion aware) and recolor model edges.
    function applyContrast(on, persist) {
      highContrast = on;
      document.documentElement.setAttribute('data-contrast', on ? 'high' : 'normal');
      contrastBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (persist) {
        try { localStorage.setItem(CONTRAST_KEY, on ? 'high' : 'normal'); } catch (e) {}
      }
      if (lastGroundSize) groundTo(lastGroundSize);
      refreshEdgeStyling();
      invalidate(); // render-on-demand: redraw the recolored grid + edges
    }

    contrastBtn.setAttribute('aria-pressed', highContrast ? 'true' : 'false');
    function toggleContrast() { applyContrast(!highContrast, true); }
    contrastBtn.addEventListener('click', toggleContrast);
    // Follow a live OS contrast change only while the user hasn't made an explicit
    // choice (nothing stored) — an explicit toggle stays authoritative.
    contrastQuery.addEventListener('change', (e) => {
      let stored = null;
      try { stored = localStorage.getItem(CONTRAST_KEY); } catch (err) {}
      if (stored !== 'high' && stored !== 'normal') applyContrast(e.matches, false);
    });

    // --- Light/dark theme toggle (header button + `T` key) ---
    // CSS themes the DOM chrome via the data-theme attribute + the token blocks
    // (set pre-paint by the head script); here we wire the toggle, keep aria-pressed
    // and the ☀/🌙 glyph in sync, persist the choice, and push the theme into the
    // WebGL scene (grid colors, feature-edge stroke, tone-mapping exposure, contact-
    // shadow opacity) which CSS can't reach.
    const themeBtn = document.getElementById('theme-btn');
    const themeGlyph = themeBtn.querySelector('.tb-glyph');
    const THEME_KEY = 'stepviewer.theme';

    // Re-theme the WebGL scene for the active light/dark choice, without a reload:
    // bump the tone-mapping exposure, rebuild the ground grid + contact shadow at
    // the last framed size (no camera change — the swap-in fade is untouched and
    // still reduced-motion aware), and recolor the current model's feature edges.
    function applyThemeScene() {
      renderer.toneMappingExposure = sceneTheme().exposure;
      if (lastGroundSize) groundTo(lastGroundSize);
      refreshEdgeStyling();
      invalidate(); // render-on-demand: redraw the re-themed scene
    }

    // Show the glyph of the theme the button switches TO... actually of the ACTIVE
    // theme: ☀ while light is on, 🌙 while dark — a familiar at-a-glance indicator.
    function updateThemeGlyph() { themeGlyph.textContent = lightTheme ? '☀' : '🌙'; }

    function applyTheme(light, persist) {
      lightTheme = light;
      document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
      themeBtn.setAttribute('aria-pressed', light ? 'true' : 'false');
      updateThemeGlyph();
      if (persist) {
        try { localStorage.setItem(THEME_KEY, light ? 'light' : 'dark'); } catch (e) {}
      }
      applyThemeScene();
    }

    // Sync the control to the resolved initial state (persisted or OS) without
    // persisting or re-theming the scene (the initial scene already used it).
    themeBtn.setAttribute('aria-pressed', lightTheme ? 'true' : 'false');
    updateThemeGlyph();
    function toggleTheme() { applyTheme(!lightTheme, true); }
    themeBtn.addEventListener('click', toggleTheme);
    // Follow a live OS light/dark change only while the user hasn't made an explicit
    // choice (nothing stored) — an explicit toggle stays authoritative.
    colorSchemeQuery.addEventListener('change', (e) => {
      let stored = null;
      try { stored = localStorage.getItem(THEME_KEY); } catch (err) {}
      if (stored !== 'light' && stored !== 'dark') applyTheme(e.matches, false);
    });

    // --- Blueprint / technical edge-only view (header button + `B` key) --------
    // A clean drafting look: hide the shaded faces of currentModel and draw only
    // the high-contrast feature-edge overlay against a blueprint backdrop —
    // blueprint-blue in dark theme, white paper with dark lines in light theme.
    // Reads geometry far more clearly than shaded metal, and is a distinctive
    // presentation mode. The mode is transient (not persisted) and layers cleanly
    // over the material preset (faces just hide, so exiting returns to the preset),
    // wireframe (faces are hidden either way; edges still read), and section.
    const blueprintBtn = document.getElementById('blueprint-btn');
    // Blueprint backdrops, applied via scene.background (the canvas is otherwise
    // alpha:true / transparent — see the WebGLRenderer setup). Deep blueprint-blue
    // for dark theme; a near-white paper for light theme.
    const BLUEPRINT_BG_DARK = 0x0e2a4d;
    const BLUEPRINT_BG_LIGHT = 0xf4f6fb;
    // Edge strokes at FULL opacity: a near-white cyan on the blue backdrop, dark
    // navy ink on the white-paper backdrop — high contrast either way.
    const BLUEPRINT_EDGE_DARK = { color: 0xdcefff, opacity: 1 };
    const BLUEPRINT_EDGE_LIGHT = { color: 0x12233f, opacity: 1 };
    const blueprintBg = () => (lightTheme ? BLUEPRINT_BG_LIGHT : BLUEPRINT_BG_DARK);
    const blueprintEdge = () => (lightTheme ? BLUEPRINT_EDGE_LIGHT : BLUEPRINT_EDGE_DARK);

    // Force-build the feature-edge overlay for every mesh in the group that lacks
    // one. Edges are normally deferred to an idle slot (step.js scheduleEdges), so
    // when blueprint mode switches on they may not exist yet — without them the
    // mode would show nothing. Meshes are collected first (not built mid-traverse)
    // and skipped if they already carry a LineSegments child, so this never doubles
    // up an overlay; step.js's own idle build carries the mirror guard, so a build
    // here and a pending idle build can't both land. Built with the current
    // (non-blueprint) edge style; the caller recolors to the blueprint stroke next.
    function forceBuildEdges(group) {
      if (!group) return;
      const style = currentEdgeStyle();
      const meshes = [];
      group.traverse((o) => { if (o.isMesh && o.geometry) meshes.push(o); });
      meshes.forEach((mesh) => {
        if (mesh.children.some((c) => c.isLineSegments)) return;
        const edgeGeom = new THREE.EdgesGeometry(mesh.geometry, 30);
        const edges = new THREE.LineSegments(
          edgeGeom,
          new THREE.LineBasicMaterial({ color: style.color, transparent: true, opacity: style.opacity })
        );
        edges.raycast = () => {}; // decorative overlay — never a pick/hit target
        mesh.add(edges);
      });
    }

    // Show/hide the shaded faces of a group by toggling each mesh material's
    // `visible`, NOT the mesh's own `visible` — the edge overlay is a child of the
    // mesh, so hiding the mesh would hide the edges too. material.visible=false
    // drops the shaded faces from the render while the LineSegments children keep
    // drawing. Leaves every other material property (preset color/shading,
    // wireframe, clipping planes, selection emissive) untouched, so exiting
    // blueprint restores the exact prior look.
    function setFacesVisible(group, visible) {
      if (!group) return;
      group.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => { m.visible = visible; });
      });
    }

    // Recolor the model's feature-edge overlay to the blueprint stroke (full
    // opacity, theme-appropriate color). Mirrors applyEdgeContrast but for the
    // blueprint palette so the same edge LineSegments serve both looks.
    function applyBlueprintEdges(group) {
      if (!group) return;
      const style = blueprintEdge();
      group.traverse((obj) => {
        if (!obj.isLineSegments || !obj.material) return;
        obj.material.color.setHex(style.color);
        obj.material.transparent = style.opacity < 1;
        obj.material.opacity = style.opacity;
        obj.material.needsUpdate = true;
      });
    }

    // Single choke point for edge stroke + backdrop, called by the theme/contrast
    // scene refreshers: in blueprint mode keep the blueprint backdrop + stroke
    // (re-derived for the now-current theme); otherwise restore the normal faint
    // theme edge (applyEdgeContrast) — scene.background is left as-is because it's
    // only ever set by blueprint mode (null the rest of the time).
    function refreshEdgeStyling() {
      if (blueprint) {
        scene.background = new THREE.Color(blueprintBg());
        applyBlueprintEdges(currentModel);
      } else {
        applyEdgeContrast(currentModel);
      }
    }

    // Enter/leave blueprint mode. On enter: ensure edges exist, hide the shaded
    // faces, recolor the edges to the blueprint stroke, swap the backdrop, and
    // hide the ground grid + contact shadow. On leave: restore face visibility,
    // the normal theme edge color/opacity, the transparent backdrop, and the grid/
    // shadow — leaving the material preset, wireframe, section, and theme states
    // fully intact. GPU resources: force-built edges are children of currentModel,
    // so the existing disposeGroup path frees them on the next model swap (no leak);
    // this only ever mutates the live currentModel (an isInScene object), never a
    // discarded group.
    function applyBlueprint(on) {
      blueprint = on;
      blueprintBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      blueprintBtn.classList.toggle('is-active', on);
      if (on) {
        forceBuildEdges(currentModel);   // edges may be idle-deferred / absent
        setFacesVisible(currentModel, false);
        applyBlueprintEdges(currentModel);
        scene.background = new THREE.Color(blueprintBg());
        if (groundGrid) groundGrid.visible = false;
        if (groundShadow) groundShadow.visible = false;
      } else {
        setFacesVisible(currentModel, true);
        applyEdgeContrast(currentModel); // restore the faint theme edge
        scene.background = null;          // restore the transparent backdrop
        if (groundGrid) groundGrid.visible = true;
        if (groundShadow) groundShadow.visible = true;
      }
      invalidate(); // render-on-demand: redraw entering/leaving blueprint
    }

    function toggleBlueprint() { applyBlueprint(!blueprint); }
    blueprintBtn.addEventListener('click', toggleBlueprint);

    // --- Save image / PNG capture (header ⤓ button + `S` key) -----------------
    // Export the current framed render (scene + orientation gizmo) as a PNG the
    // user can drop into a doc or ticket. The live renderer is alpha:true with no
    // preserveDrawingBuffer, so the drawing buffer is cleared between rAF frames
    // and a bare renderer.domElement.toDataURL() reads back blank/transparent.
    // Instead we render synchronously here and read the pixels back in the SAME
    // tick — JS is single-threaded, so no rAF/compositor pass can clear the
    // drawing buffer between the render and the toDataURL. This keeps the loop
    // cheap (no permanently-on preserveDrawingBuffer). Because the canvas clears
    // transparent, we composite an opaque #0e1116 backdrop (the CSS radial-
    // vignette mid-tone) behind the model for the capture so the PNG matches what
    // the user sees instead of a floating model on black/transparent, then
    // restore the transparent clear immediately. The captured buffer is already
    // sized at the live setPixelRatio(min(devicePixelRatio, 2)), so the PNG is
    // crisp at the current DPR without any resize. Wireframe / camera orientation
    // / framing are whatever's live at capture time, since we draw the real scene.
    const saveBtn = document.getElementById('save-btn');
    // Opaque backdrop composited behind the model for the PNG capture so the saved
    // image matches the on-screen backdrop tone rather than a transparent/black
    // void. Theme-aware (dark vignette mid-tone vs. the light backdrop) so a save
    // taken in light theme isn't a model floating on near-black.
    const captureBg = () => sceneTheme().captureBg;

    // captureBasename now lives in ./ui.js (imported above).

    function saveImage() {
      // Nothing meaningful to capture before a real model is on screen (the
      // spinning placeholder isn't a model) — nudge instead of saving a torus.
      if (!currentModel) { showToast(t('captureNothing')); return; }
      let url;
      // Snapshot the live clear color/alpha so we can restore the transparent
      // clear the render loop depends on, even if toDataURL throws.
      const prevAlpha = renderer.getClearAlpha();
      const prevColor = new THREE.Color();
      renderer.getClearColor(prevColor);
      try {
        renderer.setClearColor(captureBg(), 1); // opaque backdrop for the capture
        // Redraw scene + gizmo (autoClear is off, so clear once up front) exactly
        // as the render loop does, then read back before yielding to the browser.
        renderer.clear();
        renderer.render(scene, camera);
        viewHelper.render(renderer);
        url = renderer.domElement.toDataURL('image/png');
      } finally {
        renderer.setClearColor(prevColor, prevAlpha); // restore the live transparent clear
        // The capture left an opaque-backdrop frame in the buffer; under render-on-
        // demand the loop won't repaint on its own, so redraw the live transparent
        // scene now instead of leaving the capture backdrop on screen until input.
        invalidate();
      }
      // A lost WebGL context yields a blank data URI ('data:,') rather than throwing.
      if (!url || url === 'data:,') throw new Error('empty capture (context lost?)');
      const a = document.createElement('a');
      a.href = url;
      a.download = `step-viewer-${captureBasename(currentModelLabel)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    // Wrapper: any capture failure (context lost, blank read-back, blocked
    // download) surfaces the existing non-blocking toast rather than downloading
    // a broken file.
    function saveImageSafe() {
      try {
        saveImage();
      } catch (err) {
        console.error('Image capture failed:', err);
        showToast(t('captureFailed'));
      }
    }
    saveBtn.addEventListener('click', saveImageSafe);

    // --- Export GLB (header 📦 button + `E` key) -------------------------------
    // Export the loaded model — the shaded MeshStandardMaterial meshes with their
    // normals — as a binary glTF (.glb) so users can drop the tessellated result
    // into Blender, a game engine, model-viewer, or another three.js scene.
    // three's GLTFExporter is reachable through the existing three/addons/
    // importmap entry, so this stays zero-build.
    //
    // We export currentModel only (never the scene), which already excludes the
    // scene-level chrome (the ground grid and the contact-shadow quad are scene
    // siblings, not children of currentModel). The one piece of decorative chrome
    // that DOES live inside currentModel is the deferred feature-edge overlay —
    // a LineSegments child added to each mesh by step.js — so we temporarily
    // detach those before the export and re-attach them after, leaving the file
    // with the actual part geometry and none of the viewer's line overlay.
    const exportBtn = document.getElementById('export-btn');

    // Enable the Export button only once a real STEP model is on screen (the
    // spinning placeholder is not currentModel). Applies to both bundled samples
    // and user-opened files — unlike Share, an export needs no restorable URL.
    // The disabled title/aria-label explains that a model must be loaded first.
    function updateExportState() {
      const ready = !!currentModel;
      exportBtn.disabled = !ready;
      exportBtn.title = ready ? t('exportTitle') : t('exportTitleDisabled');
      exportBtn.setAttribute('aria-label', ready ? t('exportAria') : t('exportTitleDisabled'));
    }

    function exportGLB() {
      // Nothing meaningful to export before a real model is on screen.
      if (!currentModel) { showToast(t('exportNothing')); return; }

      // Temporarily lift the decorative feature-edge overlays out of the model so
      // they don't land in the exported file. They're LineSegments children whose
      // raycast was neutered (see step.js); collect them with their parents so we
      // can restore the exact graph afterward.
      const detached = [];
      currentModel.traverse((obj) => {
        if (obj.isLineSegments && obj.parent) {
          detached.push({ node: obj, parent: obj.parent });
        }
      });
      detached.forEach(({ node, parent }) => parent.remove(node));
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        detached.forEach(({ node, parent }) => parent.add(node));
      };

      const finishFailure = (err) => {
        restore();
        console.error('GLB export failed:', err);
        showToast(t('exportFailed'));
      };

      try {
        const exporter = new GLTFExporter();
        exporter.parse(
          currentModel,
          (result) => {
            // Re-attach the edge overlay before touching the download so the live
            // scene is whole again regardless of what happens next.
            restore();
            try {
              // binary:true → result is an ArrayBuffer of GLB bytes.
              const blob = new Blob([result], { type: 'model/gltf-binary' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${captureBasename(currentModelLabel)}.glb`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              // Revoke on the next tick: revoking synchronously can cancel the
              // just-started download in some browsers, and never revoking leaks
              // the object URL. A macrotask clears it after the download begins.
              setTimeout(() => URL.revokeObjectURL(url), 0);
            } catch (err) {
              console.error('GLB export failed:', err);
              showToast(t('exportFailed'));
            }
          },
          finishFailure, // onError (GLTFExporter can reject asynchronously)
          { binary: true }
        );
      } catch (err) {
        // exporter.parse threw synchronously.
        finishFailure(err);
      }
    }

    exportBtn.addEventListener('click', exportGLB);
    updateExportState(); // reflect the initial (no-model) disabled state

    // --- Copy shareable link (header 🔗 button) --------------------------------
    // Compose the full absolute URL for the current view and copy it to the
    // clipboard so users don't have to hunt the address bar (which can show a
    // stale/truncated hash). Only bundled gallery samples encode a restorable
    // hash — a user-opened local blob can't be reconstructed without a backend —
    // so the button is disabled while such a file is on screen (updateShareState),
    // with a title that says why.
    const shareBtn = document.getElementById('share-btn');
    const embedBtn = document.getElementById('embed-btn');
    const shareFallback = document.getElementById('share-fallback');
    const shareFallbackUrl = document.getElementById('share-fallback-url');
    const shareFallbackLabel = document.getElementById('share-fallback-label');
    const shareFallbackClose = document.getElementById('share-fallback-close');

    // Reflect whether the on-screen model is a shareable bundled sample. Called
    // whenever currentSampleFile changes (loadSample success / loadFile) and once
    // at init. The disabled title/aria-label explains that only gallery samples
    // produce shareable links.
    function updateShareState() {
      const shareable = !!currentSampleFile;
      shareBtn.disabled = !shareable;
      const label = shareable ? t('shareAria') : t('shareTitleDisabled');
      shareBtn.title = shareable ? t('shareTitle') : t('shareTitleDisabled');
      shareBtn.setAttribute('aria-label', label);
    }

    // Manual-copy fallback: surface the text in a selectable, auto-focused field
    // so a non-secure context (no navigator.clipboard) or a rejected write never
    // loses it silently. Shared by both the copy-link and copy-embed-code paths;
    // labelKey swaps the field's instruction ("Copy this link:" vs "Copy this
    // embed code:") so the panel reads correctly for whichever action opened it.
    function showShareFallback(text, labelKey) {
      shareFallbackLabel.textContent = t(labelKey || 'shareFallbackLabel');
      shareFallbackUrl.value = text;
      shareFallback.hidden = false;
      shareFallbackUrl.focus();
      shareFallbackUrl.select();
    }
    function hideShareFallback() {
      shareFallback.hidden = true;
      shareFallbackUrl.value = '';
    }
    shareFallbackClose.addEventListener('click', () => {
      hideShareFallback();
      shareBtn.focus(); // return focus to the trigger
    });
    // Escape dismisses the fallback while it's focused within.
    shareFallback.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { hideShareFallback(); shareBtn.focus(); }
    });

    async function copyShareLink() {
      // Guard: only shareable while a bundled sample is on screen (button is
      // disabled otherwise, but keep the guard defensive).
      if (!currentSampleFile) return;
      // Force the hash to reflect the CURRENT camera before reading the URL, so the
      // copied link is never a stale debounced value.
      writeHash();
      const url = location.href;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          // Success: announce via the toast (role=alert) and briefly swap the
          // visible button label so the confirmation reads at every width.
          showToast(t('shareCopied'), true);
          flashCopied();
          return;
        }
      } catch (err) {
        // Fall through to the manual-copy fallback below.
        console.warn('Clipboard write failed:', err);
      }
      // No Clipboard API, or the write was rejected (e.g. non-secure context).
      showShareFallback(url);
    }
    shareBtn.addEventListener('click', copyShareLink);

    // Transient "Copied!" swap on the button's visible label. The label is hidden
    // at narrow widths (icon-only), so this is a progressive nicety — the toast
    // above is the primary, width-independent confirmation. Restores the original
    // label after a short delay.
    const shareLabelEl = shareBtn.querySelector('.btn-label');
    let copiedTimer = null;
    function flashCopied() {
      if (!shareLabelEl) return;
      const original = t('shareLabel');
      shareLabelEl.textContent = t('shareCopiedShort');
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { shareLabelEl.textContent = original; }, 1800);
    }

    // --- Copy embed code (header <> button) ------------------------------------
    // Compose a ready-to-paste <iframe> snippet so people writing docs / blogs /
    // wikis can drop the live viewer inline. The snippet is fully self-contained
    // and points ONLY at the public GitHub Pages origin (canonical og:url) — no
    // backend, no build step — so pasting it into any plain HTML page renders a
    // working embedded viewer. Like Copy link it's only offered for restorable
    // bundled samples (a user-opened local blob can't be reconstructed remotely),
    // so the button is disabled while such a file is on screen (updateEmbedState).

    // escapeAttr now lives in ./ui.js (imported above).

    // Canonical public base URL for the embed src: prefer the og:url meta (the
    // published GitHub Pages URL) so a snippet copied from a local/dev checkout
    // still points at the public origin; fall back to the live origin+path if the
    // meta is missing. Any existing hash on the meta value is stripped — the
    // current view hash is appended by buildEmbedUrl.
    function canonicalBase() {
      try {
        const meta = document.querySelector('meta[property="og:url"]');
        if (meta && meta.content) return meta.content.replace(/#.*$/, '');
      } catch (e) {}
      return location.origin + location.pathname;
    }

    // Absolute viewer URL for the embed src: the canonical public base + the
    // current view hash (sample key + camera, refreshed from the live camera) +
    // the `embed` flag so the framed viewer opens chrome-less at the intended
    // view. writeHash first syncs the hash to the CURRENT camera so the embed
    // link is never a stale debounced value.
    function buildEmbedUrl() {
      writeHash();
      let hash = location.hash; // '#m=<file>&c=<coords>' (+ '&embed=1' if already embedded)
      if (!/(^|[#&])embed(=|&|$)/.test(hash)) hash += '&embed=1';
      return canonicalBase() + hash;
    }

    // The pasteable <iframe> snippet: absolute public src, sensible default
    // dimensions, lazy loading, no border, and a per-model title for a11y.
    function buildEmbedSnippet() {
      const url = buildEmbedUrl();
      const title = t('embedIframeTitle', { label: currentModelLabel || t('appName') });
      return `<iframe src="${escapeAttr(url)}" width="640" height="480" `
        + `loading="lazy" style="border:0" title="${escapeAttr(title)}"></iframe>`;
    }

    // Reflect whether the on-screen model is an embeddable bundled sample. Mirrors
    // updateShareState (called from the same load/init sites): disable + retitle
    // the button while a non-restorable user file is on screen.
    function updateEmbedState() {
      const embeddable = !!currentSampleFile;
      embedBtn.disabled = !embeddable;
      embedBtn.title = embeddable ? t('embedTitle') : t('embedTitleDisabled');
      embedBtn.setAttribute('aria-label', embeddable ? t('embedAria') : t('embedTitleDisabled'));
    }

    async function copyEmbedCode() {
      if (!currentSampleFile) return; // guard: only bundled samples are embeddable
      const snippet = buildEmbedSnippet();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(snippet);
          showToast(t('embedCopied'), true); // role=alert announces success to AT
          flashEmbedCopied();
          return;
        }
      } catch (err) {
        console.warn('Clipboard write failed:', err);
      }
      // No Clipboard API, or the write was rejected — surface the snippet in the
      // selectable manual-copy fallback (same channel as Copy link).
      showShareFallback(snippet, 'embedFallbackLabel');
    }
    embedBtn.addEventListener('click', copyEmbedCode);

    // Transient "Copied!" swap on the embed button's visible label (hidden at
    // narrow widths, so the toast above is the primary confirmation).
    const embedLabelEl = embedBtn.querySelector('.btn-label');
    let embedCopiedTimer = null;
    function flashEmbedCopied() {
      if (!embedLabelEl) return;
      const original = t('embedLabel');
      embedLabelEl.textContent = t('shareCopiedShort');
      clearTimeout(embedCopiedTimer);
      embedCopiedTimer = setTimeout(() => { embedLabelEl.textContent = original; }, 1800);
    }

    updateShareState(); // reflect the initial (no-model) disabled state
    updateEmbedState();

    // --- Shortcuts help dialog (header "?" button + `?` key) ---
    // Native <dialog>.showModal() gives Escape-to-close and focus trapping for
    // free; the × button and a backdrop click also dismiss it.
    const helpBtn = document.getElementById('help-btn');
    const helpDialog = document.getElementById('help-dialog');
    const helpClose = document.getElementById('help-close');
    function openHelp() { if (!helpDialog.open) helpDialog.showModal(); }
    helpBtn.addEventListener('click', openHelp);
    helpClose.addEventListener('click', () => helpDialog.close());
    // Dismiss on a backdrop click: showModal centers the panel, so a click whose
    // target is the <dialog> element itself (not its content) landed on the
    // backdrop area.
    helpDialog.addEventListener('click', (e) => {
      if (e.target === helpDialog) helpDialog.close();
    });

    // --- First-visit guided tour (issue #112) --------------------------------
    // A pure-DOM/CSS/JS coach-mark overlay (no <dialog>, no new deps). It walks a
    // short ordered sequence anchored to real controls, spotlighting each via
    // getBoundingClientRect(), and shows automatically once on the first visit
    // (gated by localStorage) — re-triggerable from the help dialog. Escape / a
    // scrim click dismiss; Enter/→ advance; ←/Back step back; focus is trapped in
    // the card and restored on close.
    (function initTour() {
      const TOUR_SEEN_KEY = 'stepviewer.tourSeen';
      const tour = document.getElementById('tour');
      const scrim = document.getElementById('tour-scrim');
      const spot = document.getElementById('tour-spot');
      const card = document.getElementById('tour-card');
      const titleEl = document.getElementById('tour-title');
      const bodyEl = document.getElementById('tour-body');
      const counterEl = document.getElementById('tour-counter');
      const backBtn = document.getElementById('tour-back');
      const nextBtn = document.getElementById('tour-next');
      const skipBtn = document.getElementById('tour-skip');
      const startBtn = document.getElementById('tour-start');
      if (!tour || !card || !spot || !scrim) return; // markup absent — no-op

      const GAP = 12;     // gap between the spotlight and the card
      const PAD = 6;      // spotlight padding around the target
      const MARGIN = 10;  // keep the card this far from the viewport edges

      // The orientation gizmo is a WebGL overlay pass (not a DOM node), so its
      // screen rect is synthesized from the same constants the gizmo uses
      // (GIZMO_DIM 128, GIZMO_TOP 68 + the safe-area inset), pinned top-right.
      function gizmoRect() {
        const dim = 128;
        const top = 68 + safeTop();
        const w = Math.min(dim, innerWidth - 2 * MARGIN);
        const left = Math.max(MARGIN, innerWidth - 16 - dim);
        return { left, top, width: w, height: dim, right: left + w, bottom: top + dim };
      }

      // Ordered coach-marks. Each anchors to a real control (or a synthesized
      // rect); steps whose target is missing/off-screen at show-time are skipped.
      const STEPS = [
        { el: () => gallery, title: 'tourGalleryTitle', body: 'tourGalleryBody' },
        { el: () => document.getElementById('wire-toggle'), title: 'tourWireTitle', body: 'tourWireBody' },
        { el: () => document.getElementById('fit-btn'), title: 'tourFitTitle', body: 'tourFitBody' },
        { el: () => document.getElementById('open-btn'), title: 'tourOpenTitle', body: 'tourOpenBody' },
        { rect: gizmoRect, title: 'tourGizmoTitle', body: 'tourGizmoBody' },
      ];

      let active = [];        // steps visible for this run
      let idx = 0;
      let prevFocus = null;
      let rafId = 0;

      function seen() {
        try { return localStorage.getItem(TOUR_SEEN_KEY) === '1'; } catch (e) { return false; }
      }
      function markSeen() {
        try { localStorage.setItem(TOUR_SEEN_KEY, '1'); } catch (e) { /* private mode */ }
      }

      // Resolve a step to a viewport rect, or null if its target is absent or
      // entirely off-screen (e.g. a control that collapsed into a hidden sheet).
      function rectFor(step) {
        if (step.rect) return step.rect();
        const el = step.el && step.el();
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return null;
        if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return null;
        return { left: r.left, top: r.top, width: r.width, height: r.height,
                 right: r.right, bottom: r.bottom };
      }

      // Place the spotlight over the active target and the card beside it —
      // preferring below, then above, then clamped within the viewport.
      function layout() {
        const step = active[idx];
        if (!step) return;
        const r = rectFor(step) || gizmoRect();
        const sl = Math.max(0, r.left - PAD);
        const st = Math.max(0, r.top - PAD);
        const sw = Math.min(innerWidth, r.right + PAD) - sl;
        const sh = Math.min(innerHeight, r.bottom + PAD) - st;
        spot.style.left = sl + 'px';
        spot.style.top = st + 'px';
        spot.style.width = sw + 'px';
        spot.style.height = sh + 'px';

        const cw = card.offsetWidth, ch = card.offsetHeight;
        let top;
        if (st + sh + GAP + ch <= innerHeight - MARGIN) top = st + sh + GAP;      // below
        else if (st - GAP - ch >= MARGIN) top = st - GAP - ch;                    // above
        else top = Math.max(MARGIN, Math.min(innerHeight - ch - MARGIN, st));     // clamp
        let left = sl + sw / 2 - cw / 2;                                          // center on spot
        left = Math.max(MARGIN, Math.min(innerWidth - cw - MARGIN, left));
        card.style.left = left + 'px';
        card.style.top = top + 'px';
      }

      function render() {
        const step = active[idx];
        if (!step) return;
        titleEl.textContent = t(step.title);
        bodyEl.textContent = t(step.body);
        counterEl.textContent = t('tourCounter', { n: idx + 1, total: active.length });
        backBtn.disabled = idx === 0;
        nextBtn.textContent = idx === active.length - 1 ? t('tourDone') : t('tourNext');
        layout();
      }

      function focusables() {
        return Array.from(card.querySelectorAll('button:not([disabled])'));
      }
      function trapTab(e) {
        const f = focusables();
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); return; }
        if (e.key === 'Tab') { trapTab(e); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); next(); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); return; }
        if (e.key === 'Enter') {
          // Let a focused footer button take its native activation; otherwise
          // Enter advances the tour.
          if (e.target === backBtn || e.target === skipBtn || e.target === nextBtn) return;
          e.preventDefault(); next();
        }
      }

      function onResize() {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(layout);
      }

      function next() {
        if (idx >= active.length - 1) { end(); return; }
        idx += 1;
        render();
        nextBtn.focus();
      }
      function prev() {
        if (idx === 0) return;
        idx -= 1;
        render();
        (backBtn.disabled ? nextBtn : backBtn).focus();
      }

      // End the tour (finish OR skip): persist the seen flag so it never
      // auto-shows again, tear down listeners, and restore focus.
      function end() {
        if (tour.hidden) return;
        tour.hidden = true;
        document.removeEventListener('keydown', onKey, true);
        removeEventListener('resize', onResize);
        cancelAnimationFrame(rafId);
        markSeen();
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (e) { /* element gone */ }
        }
      }

      // Open the tour. `force` replays it regardless of the persisted flag (the
      // help-dialog re-trigger); the auto path passes no force and bails if seen.
      function start(force) {
        if (!tour.hidden) return;
        if (!force && seen()) return;
        active = STEPS.filter((s) => rectFor(s));
        if (!active.length) return;
        idx = 0;
        prevFocus = document.activeElement;
        tour.hidden = false;
        document.addEventListener('keydown', onKey, true);
        addEventListener('resize', onResize);
        render();                       // sizes the card so layout() can measure it
        requestAnimationFrame(() => { layout(); nextBtn.focus(); });
      }

      nextBtn.addEventListener('click', next);
      backBtn.addEventListener('click', prev);
      skipBtn.addEventListener('click', end);
      scrim.addEventListener('click', end);
      if (startBtn) {
        startBtn.addEventListener('click', () => {
          if (helpDialog.open) helpDialog.close();
          // Let the dialog's top-layer/backdrop tear down before opening the tour.
          requestAnimationFrame(() => start(true));
        });
      }

      // Auto-show once on the first visit, after the initial paint/model settle so
      // the anchored controls have a stable layout to measure.
      addEventListener('load', () => { setTimeout(() => start(false), 500); });
    })();

    addEventListener('keydown', (e) => {
      // Ignore when typing in a field or with modifier keys held. `?` is Shift+/,
      // so allow Shift through (checked after the modifier guard below).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // While the guided tour overlay is open it owns the keyboard (its own
      // capture-phase handler drives Next/Back/Skip/Escape); don't fire the
      // viewer shortcuts underneath it (issue #112).
      const tourEl = document.getElementById('tour');
      if (tourEl && !tourEl.hidden) return;
      // `?` opens the shortcuts help from anywhere. Handle before the dialog-open
      // guard so it still works, and independent of the viewer shortcuts.
      if (e.key === '?') { openHelp(); return; }
      // While the modal help is open, let the platform own the keys (Escape
      // closes it, Tab cycles its focus) instead of firing viewer shortcuts.
      if (helpDialog.open) return;
      // Same for the STEP-details modal — let the platform own its keys.
      if (metaDialog.open) return;
      if (e.key === 'w' || e.key === 'W') setWireframe(!wireframe);
      // C toggles the high-contrast theme (mirrors the header toggle).
      if (e.key === 'c' || e.key === 'C') toggleContrast();
      // B toggles the blueprint / edge-only view (mirrors the header 📐 button).
      if (e.key === 'b' || e.key === 'B') toggleBlueprint();
      // P toggles color-by-part (mirrors the header 🎨 button).
      if (e.key === 'p' || e.key === 'P') toggleColorByPart();
      // T toggles the light/dark theme (mirrors the header ☀/🌙 toggle).
      if (e.key === 't' || e.key === 'T') toggleTheme();
      // S saves the current view as a PNG (mirrors the header ⤓ button).
      if (e.key === 's' || e.key === 'S') saveImageSafe();
      // E exports the loaded model as a binary GLB (mirrors the header 📦 button).
      if (e.key === 'e' || e.key === 'E') exportGLB();
      // M toggles the point-to-point distance measurement tool.
      if (e.key === 'm' || e.key === 'M') toggleMeasure();
      // Esc clears any current measurement (markers + line + label). Only acts when
      // there's something to clear, so it never swallows Escape otherwise; the help
      // dialog's own Escape-to-close already returned above when it was open.
      if (e.key === 'Escape' && measurePoints.length) { clearMeasurement(); return; }
      // Esc also clears a face selection (after any measurement above). Only acts
      // when something is selected, so it never swallows Escape otherwise.
      if (e.key === 'Escape' && selected) { clearSelection(true); return; }
      // Z fits the view to the selected face (mirrors the ⊹ button); distinct from
      // the global Fit on F/R below.
      if (e.key === 'z' || e.key === 'Z') fitToSelection();
      // R and F both re-fit/reset the view (same as the Fit button).
      if (e.key === 'f' || e.key === 'F' || e.key === 'r' || e.key === 'R') fitView();
      // Numpad keys snap to a standard camera view (Front/Back/Top/Bottom/Right/
      // Left/Iso). Keyed on e.code so NumLock state is irrelevant and this never
      // collides with the top-row 1–4 sample keys below (which match e.key).
      if (NUMPAD_VIEWS[e.code]) { applyView(NUMPAD_VIEWS[e.code]); return; }
      // Number keys 1–5 load the matching gallery sample (Gear/Block/Tetra/
      // Pyramid/Cube) and update the active pill via loadSample. Skip while a load is
      // already in flight (pills are disabled during a fetch) so rapid key
      // presses don't stack concurrent loads — mirrors the disabled-click guard.
      if (e.key >= '1' && e.key <= '5') {
        const sample = SAMPLES[Number(e.key) - 1];
        const loading = gallery.querySelector('.sample:disabled');
        if (sample && !loading) loadSample(sample);
      }
    });

    // --- Reset / fit view (button, `F` key, double-click canvas) ---
    document.getElementById('fit-btn').addEventListener('click', fitView);
    // Double-click re-fits — but not while measuring, where two quick clicks are a
    // pair of measurement picks, not a fit gesture. On hybrid touch+mouse devices
    // a touch double-tap can still emit a synthetic dblclick; suppressDblclickUntil
    // (set by the touch handler below) swallows it so the fit never double-fires.
    renderer.domElement.addEventListener('dblclick', () => {
      if (measureMode) return;
      if (performance.now() < suppressDblclickUntil) return;
      fitView();
    });

    // --- Touch double-tap to fit (issue #105) --------------------------------
    // dblclick is unreliable on touchscreens — many mobile browsers suppress or
    // debounce the synthetic event and it collides with the browser's own
    // double-tap-to-zoom — so touch gets its own detector off touchend timing.
    // Two clean single-finger taps within DBLTAP_MS and DBLTAP_PX of each other
    // call fitView(). Any multi-touch lift (pinch / two-finger pan) is ignored
    // and resets the pending tap, so a fit can never fire mid-gesture. The canvas
    // carries touch-action:none (CSS + OrbitControls), so the browser's native
    // double-tap-zoom is already suppressed; preventDefault() on the second tap is
    // a belt-and-braces guard for stragglers.
    const DBLTAP_MS = 300;   // max gap between the two taps
    const DBLTAP_PX = 30;    // max movement between taps (single finger)
    let lastTapTime = 0;
    let lastTapX = 0, lastTapY = 0;
    let suppressDblclickUntil = 0;  // ignore synthetic dblclick until this time
    renderer.domElement.addEventListener('touchend', (e) => {
      // Only a clean single-finger lift with no fingers still down is a tap:
      // anything else is (the tail of) a pinch / two-finger gesture — drop it and
      // cancel any pending first tap so the pair can't span a gesture.
      if (e.touches.length > 0 || e.changedTouches.length !== 1 || measureMode) {
        lastTapTime = 0;
        return;
      }
      const touch = e.changedTouches[0];
      const now = performance.now();
      const dt = now - lastTapTime;
      const moved = Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY);
      if (lastTapTime && dt < DBLTAP_MS && moved < DBLTAP_PX) {
        e.preventDefault();                 // stop any native double-tap-to-zoom
        suppressDblclickUntil = now + 700;  // swallow the trailing synthetic dblclick
        lastTapTime = 0;                    // consume the pair; a 3rd tap starts fresh
        fitView();
      } else {
        lastTapTime = now;
        lastTapX = touch.clientX;
        lastTapY = touch.clientY;
      }
    }, { passive: false });

    // --- Keyboard-driven camera navigation -----------------------------------
    // OrbitControls only listens to pointer/wheel events, so a keyboard-only user
    // could never orbit, zoom, or pan. #app carries tabindex=0 (focusable) and
    // this handler is attached to it, so the camera keys ONLY fire while the 3D
    // view has focus — Tab still moves focus normally, and the document-level
    // 1–4 / W / F / R / ? shortcuts (window keydown handler above) keep working
    // regardless of focus because those keys aren't handled here. enableDamping
    // is on; we mutate camera.position then call controls.update(), and the
    // render loop's own controls.update() eases the damping out next frames.
    const ORBIT_STEP = THREE.MathUtils.degToRad(5); // ~5° per Arrow press
    const DOLLY_IN = 0.9;          // multiply distance to dolly in (zoom in)
    const DOLLY_OUT = 1 / DOLLY_IN; // and its inverse to dolly out
    const PAN_PIXELS = 40;          // Shift+Arrow pan step, in screen pixels
    const POLAR_EPS = 0.000001;     // keep phi off the exact poles (avoids flip)
    // Scratch vectors reused across presses so key handling allocates nothing.
    const _offset = new THREE.Vector3();
    const _spherical = new THREE.Spherical();
    const _panOffset = new THREE.Vector3();
    const _panV = new THREE.Vector3();

    // Orbit around controls.target by spherical deltas: dTheta = azimuth (Left/
    // Right), dPhi = polar (Up/Down). Clamps phi to the OrbitControls polar
    // limits so the camera can't flip over the poles.
    function orbitCamera(dTheta, dPhi) {
      _offset.copy(camera.position).sub(controls.target);
      _spherical.setFromVector3(_offset);
      _spherical.theta += dTheta;
      _spherical.phi += dPhi;
      const minPhi = Math.max(controls.minPolarAngle, POLAR_EPS);
      const maxPhi = Math.min(controls.maxPolarAngle, Math.PI - POLAR_EPS);
      _spherical.phi = Math.max(minPhi, Math.min(maxPhi, _spherical.phi));
      _spherical.makeSafe();
      _offset.setFromSpherical(_spherical);
      camera.position.copy(controls.target).add(_offset);
      controls.update();
    }

    // Dolly the camera along its view ray by scaling the target distance,
    // clamped to the existing controls.minDistance / maxDistance so keyboard
    // zoom respects the same bounds as wheel zoom.
    function dollyCamera(factor) {
      _offset.copy(camera.position).sub(controls.target);
      const r = Math.max(controls.minDistance,
                         Math.min(controls.maxDistance, _offset.length() * factor));
      _offset.setLength(r);
      camera.position.copy(controls.target).add(_offset);
      controls.update();
    }

    // Pan target + camera together by screen-space pixel deltas, mirroring
    // OrbitControls' own pan math so it honors screenSpacePanning=false (vertical
    // pan rides the ground plane, not the camera's tilted up axis).
    function panCamera(deltaX, deltaY) {
      _offset.copy(camera.position).sub(controls.target);
      // Half the view height in world units at the target distance (perspective).
      const targetDistance = _offset.length() * Math.tan((camera.fov / 2) * Math.PI / 180);
      _panOffset.set(0, 0, 0);
      // panLeft: along the camera's local X axis.
      _panV.setFromMatrixColumn(camera.matrix, 0);
      _panV.multiplyScalar(-(2 * deltaX * targetDistance / innerHeight));
      _panOffset.add(_panV);
      // panUp: screenSpacePanning=false → cross(up, cameraX) rides the ground.
      if (controls.screenSpacePanning) {
        _panV.setFromMatrixColumn(camera.matrix, 1);
      } else {
        _panV.setFromMatrixColumn(camera.matrix, 0);
        _panV.crossVectors(camera.up, _panV);
      }
      _panV.multiplyScalar(2 * deltaY * targetDistance / innerHeight);
      _panOffset.add(_panV);
      camera.position.add(_panOffset);
      controls.target.add(_panOffset);
      controls.update();
    }

    app.addEventListener('keydown', (e) => {
      // Let platform/global handlers own modified combos (except our own Shift
      // pan) and the modal help state.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (helpDialog.open) return;
      if (metaDialog.open) return;
      // Numpad view-preset keys are owned by the global handler (applyView). With
      // NumLock OFF they also carry Arrow/Home e.key values, so defer them here to
      // avoid a double-fire (orbit + snap) when the 3D view is focused.
      if (NUMPAD_VIEWS[e.code]) return;
      const shift = e.shiftKey;
      let handled = true;
      switch (e.key) {
        case 'ArrowLeft':  shift ? panCamera(-PAN_PIXELS, 0) : orbitCamera(ORBIT_STEP, 0); break;
        case 'ArrowRight': shift ? panCamera(PAN_PIXELS, 0) : orbitCamera(-ORBIT_STEP, 0); break;
        case 'ArrowUp':    shift ? panCamera(0, PAN_PIXELS) : orbitCamera(0, -ORBIT_STEP); break;
        case 'ArrowDown':  shift ? panCamera(0, -PAN_PIXELS) : orbitCamera(0, ORBIT_STEP); break;
        case '+': case '=': dollyCamera(DOLLY_IN); break;   // '=' is the unshifted '+' key
        case '-': case '_': dollyCamera(DOLLY_OUT); break;
        case 'Home': fitView(); break;
        default: handled = false;
      }
      // Swallow only the keys we act on, so Arrow-scroll / default zoom don't also
      // fire; Tab, Escape, and every other key pass through untouched.
      if (handled) e.preventDefault();
    });

    // Clicking a face/axis of the gizmo snaps the camera to that view. Because
    // we moved the gizmo's render to the top-right but ViewHelper.handleClick
    // still hit-tests its original bottom-right box, translate the click into
    // that box before forwarding. The X box is identical (both right-aligned),
    // so only Y shifts: a click at actualY maps to the same fractional position
    // in the bottom-right box by adding the constant gap between the two boxes.
    // Only clicks that actually fall inside the visible top-right gizmo box are
    // forwarded, so ordinary canvas clicks/drags pass through untouched.
    renderer.domElement.addEventListener('pointerup', (e) => {
      const el = renderer.domElement;
      const inX = e.clientX >= el.clientWidth - GIZMO_DIM;
      const gTop = gizmoTop();
      const inY = e.clientY >= gTop && e.clientY <= gTop + GIZMO_DIM;
      if (!inX || !inY) return;
      viewHelper.handleClick({
        clientX: e.clientX,
        clientY: e.clientY + (innerHeight - GIZMO_DIM - gTop),
      });
      // Render-on-demand: arm the loop so the gizmo's snap animation
      // (viewHelper.animating) plays; renderFrame self-sustains it until it lands.
      invalidate();
    });

    // --- Multi-file intake (issue #99) -----------------------------------------
    // BOTH entry points — the file picker and full-window drag-drop — used to keep
    // only files[0], silently discarding the rest of a multi-file drop/selection
    // with no signal. They now funnel through ingestFiles(), which filters the set
    // to the CAD extensions occt reads (the same CAD_EXT_RE the single-file guard
    // uses) and then, uniformly for both sources:
    //   • 0 valid  → reject the whole set — the lone-file wording for a single
    //                wrong-extension file, a count-aware line for a larger set.
    //   • 1 valid  → load it exactly as before (no queue to switch between).
    //   • >1 valid → load the first AND render every valid file as a temporary
    //                gallery pill (reusing the .sample markup, backed by the
    //                in-memory File) so the user can switch between them without
    //                re-dropping. Session-only: the Files are never persisted and
    //                the pills are replaced by the next intake / single-file load.

    // Temporary File-backed gallery pills from the last multi-file intake. Each
    // entry is { file, pill }. Cleared by clearDroppedPills().
    let droppedEntries = [];

    function clearDroppedPills() {
      droppedEntries.forEach((e) => e.pill.remove());
      droppedEntries = [];
    }

    // Build one temporary pill per valid File and append it to the gallery. No
    // dataset.file: loadSample marks its active pill by matching dataset.file to a
    // bundled sample name, so leaving it unset keeps these pills out of that match
    // — loading a bundled sample then correctly deactivates every dropped pill.
    function renderDroppedPills(files) {
      clearDroppedPills();
      files.forEach((file) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sample dropped'; // reuse the gallery-pill styling
        btn.textContent = file.name;
        btn.setAttribute('aria-pressed', 'false');
        btn.title = t('droppedTitle', { name: file.name });
        const entry = { file, pill: btn };
        // Ignore clicks while a load is in flight (spinner active) so two files
        // can't race; a bundled-sample load also disables .sample buttons.
        btn.addEventListener('click', () => {
          if (!spinner.classList.contains('active')) loadDroppedFile(entry);
        });
        gallery.appendChild(btn);
        droppedEntries.push(entry);
      });
    }

    // Load one File-backed pill: make it the active pill (deactivating every other
    // gallery pill, bundled or dropped), then load through the same loadFile path a
    // drag-drop/open uses, so the size guard, hash/share reset, and error handling
    // are all identical to a single-file load.
    function loadDroppedFile(entry) {
      gallery.querySelectorAll('.sample').forEach((b) => {
        const active = b === entry.pill;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      loadFile(entry.file);
    }

    // Shared intake for a FileList (or File[]) from either entry point.
    function ingestFiles(fileList) {
      const all = Array.from(fileList || []);
      if (!all.length) return;
      const valid = all.filter((f) => CAD_EXT_RE.test(f.name));
      if (!valid.length) {
        // Nothing readable in the selection. Keep the original single-file hint for
        // a lone wrong-extension file; generalize (with the count) for a real set.
        hint.textContent = all.length === 1
          ? t('notStepFile', { name: all[0].name })
          : t('noValidInSet', { count: all.length });
        return;
      }
      if (valid.length === 1) {
        clearDroppedPills(); // a single valid file has no queue to offer
        loadFile(valid[0]);
        return;
      }
      // Multiple valid files: build the switchable queue and load the first.
      renderDroppedPills(valid);
      loadDroppedFile(droppedEntries[0]);
      showToast(t('multiDropQueued', { count: valid.length }));
    }

    // --- File picker ---
    const fileInput = document.getElementById('file-input');
    document.getElementById('open-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      ingestFiles(fileInput.files);
      fileInput.value = ''; // allow re-selecting the same file(s)
    });

    // --- Full-window drag-and-drop ---
    const overlay = document.getElementById('drop-overlay');
    let dragDepth = 0; // dragenter/dragleave fire per child; count to avoid flicker

    function hasFiles(e) {
      return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    }
    addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      overlay.classList.add('active');
    });
    addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove('active'); }
    });
    addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      overlay.classList.remove('active');
      // Same multi-file logic as the picker: filter the whole drop to CAD files
      // and either load one, queue several as pills, or reject the set — never
      // silently keep files[0] and drop the rest.
      ingestFiles(e.dataTransfer && e.dataTransfer.files);
    });

    addEventListener('resize', () => {
      camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
      // Re-frame so the fit distance is recomputed for the new aspect ratio;
      // otherwise an orientation change (landscape->portrait) leaves the model
      // overflowing horizontally even though the projection was updated.
      fitView();
      invalidate(); // render-on-demand: a resize changes the picture
    });

    // --- Render on demand -----------------------------------------------------
    // A loaded model is a static scene, so redrawing every display frame forever
    // (the old setAnimationLoop) pins the GPU and drains battery for nothing. We
    // draw only when something actually changed: invalidate() queues a single
    // frame (deduped), renderFrame() draws it, and — while any motion is still in
    // flight — re-queues the next one, then goes quiet. The drivers:
    //   • OrbitControls 'change' → invalidate (wired below): covers every camera
    //     mutation (pointer orbit/zoom/pan, wheel, the keyboard camera keys, the
    //     gizmo/preset snaps) AND the damping tail — controls.update() keeps
    //     firing 'change' each frame until damping settles, so the loop naturally
    //     keeps drawing through the settle and stops the frame it goes still.
    //   • animationsActive(): the placeholder idle spin, an in-flight swap-in
    //     fade, a gizmo snap, or a named-view snap — these drive the loop
    //     frame-to-frame on their own, so renderFrame re-queues while any is live.
    //   • explicit invalidate() from the load / fit / resize / scene-mutation
    //     paths (wireframe, material, section, explode, contrast, theme, etc.),
    //     which change the picture without touching the camera.
    // Steady state (static model, no input) issues zero render calls.
    const clock = new THREE.Clock();
    // True while any self-driving animation needs another frame. The placeholder
    // spin only counts while the placeholder is the active object (spin ===
    // placeholder) and motion isn't reduced — once a static model loads (spin =
    // null), or reduced-motion parks the spin, this drops the loop to idle.
    function animationsActive() {
      return (!!spin && !reduceMotion.matches) ||
             !!swapAnim ||
             viewHelper.animating ||
             !!presetAnim;
    }
    // Request exactly one frame. Deduped via renderRequested (declared up with the
    // render-state flags) so N callers in a tick still schedule a single rAF.
    function invalidate() {
      if (renderRequested) return;
      renderRequested = true;
      requestAnimationFrame(renderFrame);
    }
    function renderFrame() {
      renderRequested = false;
      const delta = clock.getDelta();
      if (spin && !reduceMotion.matches) spin.rotation.y += 0.005;
      updateSwapIn(performance.now()); // advance any in-flight model swap-in ease
      // Advance the gizmo's snap-to-axis animation (armed by clicking a gizmo
      // axis); it drives camera.position, which OrbitControls.update reads back.
      if (viewHelper.animating) viewHelper.update(delta);
      // Advance an in-flight named-view snap: ease camera.position + orbit target
      // toward the preset pose. Runs BEFORE controls.update(), which reads the
      // mutated position/target back (same cooperative pattern as the keyboard
      // camera keys), so it never fights the OrbitControls damping tail.
      if (presetAnim) {
        const p = Math.min(1, (performance.now() - presetAnim.start) / PRESET_MS);
        const e = easePreset(p);
        camera.position.lerpVectors(presetAnim.fromPos, presetAnim.toPos, e);
        controls.target.lerpVectors(presetAnim.fromTarget, presetAnim.toTarget, e);
        if (p >= 1) presetAnim = null;
      }
      // Applies damping and, while the camera is still moving, fires 'change' →
      // invalidate, so the damping tail re-queues itself until it settles. Once
      // settled it fires nothing and, absent an active animation, the loop parks.
      controls.update();
      // Track the measurement label to the segment midpoint: project the world-
      // space midpoint to normalized device coords, then to screen px. Runs after
      // controls.update() so the camera matrices are current for this frame. A
      // midpoint behind the camera / beyond the far plane (|z| > 1) is hidden so
      // the label never jumps to a mirrored on-screen position.
      if (measurePoints.length === 2) {
        _measMid.copy(measurePoints[0]).add(measurePoints[1]).multiplyScalar(0.5).project(camera);
        if (_measMid.z <= 1) {
          measureLabel.style.left = (_measMid.x * 0.5 + 0.5) * innerWidth + 'px';
          measureLabel.style.top = (-_measMid.y * 0.5 + 0.5) * innerHeight + 'px';
          measureLabel.style.visibility = 'visible';
        } else {
          measureLabel.style.visibility = 'hidden';
        }
      }
      // autoClear is off: clear once, draw the scene, then overlay the gizmo.
      renderer.clear();
      renderer.render(scene, camera);
      viewHelper.render(renderer);
      // Keep drawing while a self-driving animation is still running. The damping
      // tail is re-queued by the 'change' listener above, so it isn't checked here.
      if (animationsActive()) invalidate();
    }
    // Draw the first frame (the spinning placeholder / initial scene). Every later
    // frame is pulled by invalidate() from a camera 'change', an animation, a
    // resize, a load/fit, or a scene-mutating control.
    invalidate();
    // Resume the loop if the OS reduced-motion setting is turned OFF while the
    // placeholder is parked (spin still points at it), so the idle spin comes back
    // to life; turning it ON simply lets the loop park on its next quiet frame.
    reduceMotion.addEventListener('change', invalidate);

    // --- Mobile bottom-sheet control surface (issue #104) -------------------
    // Relocates the primary actions (Open / Fit / Wireframe) and the sample
    // #gallery into a bottom-anchored sheet on phone-width viewports, then moves
    // them back to the header on wider screens. Nodes are MOVED, never cloned,
    // so their existing handlers and live state (wireframe on/off, active sample
    // pill) are preserved with zero duplicate wiring — a load can't double-fire.
    // Collapsed/expanded is a class toggle driving a translateY; the collapse
    // distance is the body's measured height, republished on resize and whenever
    // the gallery/body reflows (async sample population, orientation change).
    (function initControlSheet() {
      const sheet = document.getElementById('control-sheet');
      const handle = document.getElementById('sheet-handle');
      const peek = document.getElementById('sheet-peek');
      const body = document.getElementById('sheet-body');
      if (!sheet || !handle || !peek || !body) return;

      const openBtn = document.getElementById('open-btn');
      const fitBtn = document.getElementById('fit-btn');
      const wireEl = document.getElementById('wire-toggle');
      const galleryEl = document.getElementById('gallery');
      if (!openBtn || !fitBtn || !wireEl || !galleryEl) return;

      // Record each relocatable node's original slot so it can be restored to
      // the exact header / bottom-cluster position when leaving phone width.
      const record = (el) => ({ parent: el.parentNode, next: el.nextElementSibling });
      const homes = [
        [openBtn, record(openBtn)],
        [fitBtn, record(fitBtn)],
        [wireEl, record(wireEl)],
        [galleryEl, record(galleryEl)],
      ];

      let mounted = false;
      let expanded = false;

      function mount() {
        if (mounted) return;
        // Peek row order: Open → Fit → Wireframe (primary → secondary).
        peek.append(openBtn, fitBtn, wireEl);
        body.append(galleryEl);
        sheet.classList.add('is-active');
        mounted = true;
        setExpanded(false); // start collapsed (peek only)
        measure();
      }
      function unmount() {
        if (!mounted) return;
        for (const [el, h] of homes) {
          if (h.next && h.next.parentNode === h.parent) h.parent.insertBefore(el, h.next);
          else h.parent.appendChild(el);
        }
        sheet.classList.remove('is-active', 'is-expanded', 'is-dragging');
        sheet.style.transform = '';
        body.setAttribute('inert', '');
        mounted = false;
        expanded = false;
      }

      // Collapse distance = the body's laid-out height (it's the bottom-most
      // child, so translating the sheet down by this hides the gallery exactly
      // while the handle + peek + safe-area gap stay on screen).
      function measure() {
        if (!mounted) return;
        sheet.style.setProperty('--sheet-shift', body.offsetHeight + 'px');
        // Publish the collapsed peek height so #bottom-cluster (the hint) sits
        // just above it rather than hiding behind the sheet.
        document.documentElement.style.setProperty(
          '--sheet-peek-h', (handle.offsetHeight + peek.offsetHeight) + 'px');
      }

      function setExpanded(next) {
        expanded = next;
        sheet.classList.toggle('is-expanded', next);
        handle.setAttribute('aria-expanded', String(next));
        handle.setAttribute('aria-label', next ? t('sheetCollapseAria') : t('sheetExpandAria'));
        // Keep the off-screen gallery out of the tab order when collapsed.
        if (next) body.removeAttribute('inert'); else body.setAttribute('inert', '');
      }

      // A drag already snapped in endDrag, so its trailing click must not toggle
      // again — consume it and reset, which keeps later keyboard (Enter/Space)
      // activations working since they arrive with dragMoved already cleared.
      handle.addEventListener('click', () => {
        if (dragMoved) { dragMoved = false; return; }
        setExpanded(!expanded);
      });

      // Optional vertical drag: track the finger, move the sheet 1:1, then snap
      // to the nearer state on release. Plain pointer events; no library. A drag
      // sets dragMoved so the trailing click doesn't also toggle.
      let dragging = false, dragStartY = 0, dragDy = 0, dragMoved = false, dragShift = 0;
      const DRAG_SNAP = 40;
      handle.addEventListener('pointerdown', (e) => {
        if (!mounted) return;
        dragging = true; dragMoved = false; dragStartY = e.clientY; dragDy = 0;
        dragShift = parseFloat(getComputedStyle(sheet).getPropertyValue('--sheet-shift')) || body.offsetHeight;
        sheet.classList.add('is-dragging');
        if (handle.setPointerCapture) { try { handle.setPointerCapture(e.pointerId); } catch (_) {} }
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        dragDy = e.clientY - dragStartY;
        if (Math.abs(dragDy) > 4) dragMoved = true;
        // Base offset is 0 when expanded, dragShift when collapsed; clamp to the
        // travel range so the sheet can't overshoot either stop.
        let y = (expanded ? 0 : dragShift) + dragDy;
        y = Math.max(0, Math.min(dragShift, y));
        sheet.style.transform = 'translateY(' + y + 'px)';
      });
      function endDrag() {
        if (!dragging) return;
        dragging = false;
        sheet.classList.remove('is-dragging');
        sheet.style.transform = ''; // hand the transform back to the CSS class
        if (dragMoved) {
          if (dragDy < -DRAG_SNAP) setExpanded(true);        // dragged up
          else if (dragDy > DRAG_SNAP) setExpanded(false);   // dragged down
          else setExpanded(expanded);                        // too small — stay
        }
      }
      handle.addEventListener('pointerup', endDrag);
      handle.addEventListener('pointercancel', endDrag);

      // Same 600px cut as the header's label→icon collapse, so the sheet appears
      // exactly when the header would otherwise go cryptic-icon-only.
      const phone = matchMedia('(max-width: 600px)');
      function sync() {
        if (document.documentElement.classList.contains('embed')) { unmount(); return; }
        if (phone.matches) mount(); else unmount();
      }
      phone.addEventListener('change', sync);
      window.addEventListener('resize', () => { if (mounted) measure(); });
      // Keep the collapse distance correct as the gallery populates async or the
      // body reflows (orientation change, font load).
      if (window.ResizeObserver) {
        new ResizeObserver(() => { if (mounted) measure(); }).observe(body);
      }
      sync();
    })();
