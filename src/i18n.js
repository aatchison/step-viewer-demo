// Localizable-strings groundwork — a single ES-module string table plus a tiny
// locale runtime. Zero-build: no bundler, no backend, no dependency (not even
// three.js). Adding a locale is one new object in `messages` below.
//
// Design:
//  - `messages` maps a locale code -> { key: template }. Templates carry simple
//    `{name}` placeholders that `t(key, params)` fills in (e.g. Loading {label}…).
//  - The active locale is chosen once at import time from `?lang=` then the
//    browser's navigator.language(s), falling back to `en` for anything unknown,
//    and the resolved code is written to <html lang>.
//  - `t()` falls back to English per-key, so a partial locale (see `es`) still
//    renders — only the missing keys show through in English. That proves the
//    fallback path and keeps translation incremental.
//  - The `en` table reproduces today's strings byte-for-byte, so with no ?lang=
//    on an English browser the rendered UI is identical to before this change.

const messages = {
  en: {
    // --- Header ---
    appName: 'STEP Viewer',
    tag: 'three.js · occt-import-js · demo',
    wireframeLabel: 'Wireframe',
    wireframeTitle: 'Toggle wireframe (W)',
    materialLabel: 'Material',
    materialAria: 'Material & lighting preset',
    materialTitle: 'Material & lighting preset (Studio / Technical / Clay / X-ray)',
    matStudio: 'Studio',
    matTechnical: 'Technical',
    matClay: 'Clay',
    matXray: 'X-ray',
    fitLabel: 'Fit view',
    fitAria: 'Fit view',
    fitTitle: 'Fit / reset view (R or F, or double-click canvas)',
    contrastLabel: 'Contrast',
    contrastAria: 'High contrast',
    contrastTitle: 'Toggle high contrast (C)',
    blueprintLabel: 'Blueprint',
    blueprintAria: 'Blueprint (edge-only) view',
    blueprintTitle: 'Toggle blueprint / edge-only view (B)',
    colorPartLabel: 'Color parts',
    colorPartAria: 'Color by part',
    colorPartTitle: 'Color parts by solid (P)',
    themeAria: 'Toggle light and dark theme',
    themeTitle: 'Toggle light / dark theme (T)',
    openLabel: 'Open STEP file…',
    openAria: 'Open STEP file',
    openTitle: 'Open a STEP / IGES / BREP file (or drag & drop onto the view)',
    saveLabel: 'Save image',
    saveAria: 'Save image (PNG)',
    saveTitle: 'Save the current view as a PNG (S)',
    exportLabel: 'Export GLB',
    exportAria: 'Export model as GLB',
    exportTitle: 'Export the loaded model as a binary glTF (.glb) (E)',
    exportTitleDisabled: 'Load a model first, then export it as a .glb',
    shareLabel: 'Copy link',
    shareAria: 'Copy shareable link',
    shareTitle: 'Copy a shareable link to this view',
    shareTitleDisabled: 'Only gallery samples can be shared — open a sample to get a link',
    shareCopied: 'Link copied to clipboard',
    shareCopiedShort: 'Copied!',
    shareFallbackLabel: 'Copy this link:',
    shareFallbackDismiss: 'Dismiss',
    embedLabel: 'Copy embed code',
    embedAria: 'Copy embed code',
    embedTitle: 'Copy an <iframe> snippet to embed this view',
    embedTitleDisabled: 'Only gallery samples can be embedded — open a sample to get embed code',
    embedCopied: 'Embed code copied to clipboard',
    embedFallbackLabel: 'Copy this embed code:',
    embedIframeTitle: 'STEP Viewer — {label}',
    measureLabel: 'Measure',
    measureAria: 'Measure distance',
    measureTitle: 'Measure distance between two points (M)',
    measureClearLabel: 'Clear',
    measureClearAria: 'Clear measurement',
    measureClearTitle: 'Clear measurement (Esc)',
    measureOn: 'Measure mode on — click two points on the model to measure the distance between them.',
    measureOff: 'Measure mode off.',
    measureFirst: 'First point set — click a second point to measure.',
    measureResult: 'Distance: {dist} (model units). Click two new points to measure again, or press Esc to clear.',
    sectionLabel: 'Section',
    sectionAria: 'Section / cross-section clip plane',
    sectionTitle: 'Toggle section / cross-section clip plane',
    sectionPanelTitle: 'Section',
    sectionAxisAria: 'Section plane axis',
    sectionAxisXAria: 'Cut along the X axis',
    sectionAxisYAria: 'Cut along the Y axis',
    sectionAxisZAria: 'Cut along the Z axis',
    sectionFlipTitle: 'Flip cut direction',
    sectionFlipAria: 'Flip the cut direction',
    sectionSliderAria: 'Section plane position',
    sectionOn: 'Section on — pick an axis (X / Y / Z) and drag the slider to cut through the model; the interior shows as a cross-section. Flip reverses the cut side.',
    sectionOff: 'Section off — normal rendering restored.',
    selectFitLabel: 'Fit selection',
    selectFitAria: 'Fit to selection',
    selectFitTitle: 'Fit camera to the selected face (Z)',
    selectReadout: 'Selected: {name}',
    selectFallback: 'Face {index}',
    selectHint: '{name} selected — press Z to fit the view to it, or Esc to clear.',
    selectCleared: 'Selection cleared.',
    explodePanelTitle: 'Explode',
    explodeSliderAria: 'Explode assembly view — spread parts apart',
    explodeSingle: 'Single-solid model — explode applies to multi-part assemblies.',
    descExplode: 'Explode multi-part assemblies',
    helpAria: 'Keyboard shortcuts and controls',
    helpTitle: 'Keyboard shortcuts & controls (press ?)',

    // --- Standard-view presets ---
    presetsAria: 'Standard camera views',
    viewFrontLabel: 'Front',
    viewBackLabel: 'Back',
    viewTopLabel: 'Top',
    viewBottomLabel: 'Bottom',
    viewRightLabel: 'Right',
    viewLeftLabel: 'Left',
    viewIsoLabel: 'Iso',
    viewFrontDesc: 'Front view (+Z, Numpad 1)',
    viewBackDesc: 'Back view (−Z, Numpad 2)',
    viewRightDesc: 'Right view (+X, Numpad 3)',
    viewLeftDesc: 'Left view (−X, Numpad 4)',
    viewTopDesc: 'Top view (+Y, Numpad 5)',
    viewBottomDesc: 'Bottom view (−Y, Numpad 6)',
    viewIsoDesc: 'Isometric view (Numpad 0)',

    // --- Help dialog ---
    helpHeading: 'Shortcuts & controls',
    helpCloseAria: 'Close help',
    kDrag: 'Drag',
    kScroll: 'Scroll',
    kHome: 'Home',
    kDrop: 'Drop',
    descOrbitModel: 'Orbit the model',
    descZoom: 'Zoom in / out',
    descOrbitCamera: 'Orbit camera (view focused)',
    descZoomCamera: 'Zoom camera in / out',
    descPan: 'Pan the view target',
    descHome: 'Re-fit / reset view',
    descWireframe: 'Toggle wireframe',
    descContrast: 'Toggle high contrast',
    descBlueprint: 'Toggle blueprint (edge-only) view',
    descColorPart: 'Toggle color by part',
    descTheme: 'Toggle light / dark theme',
    descSave: 'Save image (PNG)',
    descExport: 'Export model as GLB',
    descMeasure: 'Toggle distance measure',
    descMeasureClear: 'Clear measurement',
    kEsc: 'Esc',
    kClick: 'Click',
    descSelect: 'Select a face (Esc / empty click clears)',
    descSelectFit: 'Fit to selected face',
    descFit: 'Fit / reset view',
    descSamples: 'Load gallery samples',
    descViews: 'Standard views (Front/Back/Top/Bottom/Right/Left/Iso)',
    descOpen: 'Open a .step / .iges / .brep file',

    // --- 3D view accessible names ---
    appAriaDefault:
      'Interactive 3D view of the loaded STEP model. Drag to orbit, scroll or pinch to zoom. When focused: Arrow keys orbit, plus and minus keys zoom, Shift plus Arrow keys pan, and Home re-fits the view.',
    appAriaEmpty:
      'No 3D model loaded. Pick a model from the gallery or open a STEP file. When focused: Arrow keys orbit, plus and minus keys zoom, Shift plus Arrow keys pan, and Home re-fits the view.',

    // --- Loading / error surfaces ---
    loadStatusEngine: 'Loading 3D engine…',
    loadStatusParse: 'Parsing STEP model…',
    engineErrorDefault: "Couldn't load the 3D engine — check your connection.",
    engineErrorStall:
      'Loading the 3D engine is taking too long — check your connection and retry.',
    retry: 'Retry',
    dropOverlay: 'Drop a .step / .iges / .brep file to load',

    // --- Gallery ---
    galleryAria: 'Sample models',
    sampleGear: 'Gear',
    sampleBlock: 'Block',
    sampleTetra: 'Tetrahedron',
    samplePyramid: 'Pyramid',
    sampleCube: 'Cube (IGES)',
    sampleTitle: '{label} (press {n})',

    // --- Hint (composed from pieces; separators live in the caller) ---
    hintPickModel: 'pick a model from the gallery below, or drag & drop a .step / .iges / .brep file',
    hintTapModel: 'tap a model in the gallery below',
    zoomScroll: 'drag to orbit · scroll to zoom',
    zoomPinch: 'drag to orbit · pinch to zoom',
    keyHint: ' · keys: 1–5 samples, R reset, W wireframe',
    reducedDataFine:
      'Data saver is on — pick a model from the gallery below, open a file, or drop a .step / .iges / .brep file to load it.',
    reducedDataCoarse: 'Data saver is on — tap a model in the gallery below to load it.',

    // --- Load lifecycle messages ---
    loadedHint: '{label} · {zoom}',
    loading: 'Loading {label}…',
    couldNotLoadConsole: 'Could not load {label} — see console',
    notStepFile: '{name} is not a supported CAD file (.step, .stp, .iges, .igs, .brep, .brp)',

    // --- Large-file size guard ---
    sizeSoftWarn: '{label} is large ({size}) — parsing may be slow.',
    sizeHardConfirm:
      '{label} is very large ({size}). Parsing it may exhaust memory or freeze the tab. Load it anyway?',

    // --- Save image (PNG capture) ---
    captureFailed: "Couldn't save the image — the 3D view could not be captured.",
    captureNothing: 'Load a model first, then save the view as an image.',

    // --- Export GLB ---
    exportFailed: "Couldn't export the model — the GLB could not be generated.",
    exportNothing: 'Load a model first, then export it as a GLB.',

    // --- describeError, keyed by failure kind ---
    errInit:
      'Could not load {label} — the 3D engine (occt/WASM) failed to download. Check your connection and reload.',
    errHttp: 'Could not load {label} — the file could not be fetched ({message}).',
    errParse:
      'Could not load {label} — the file could not be parsed; it may be invalid or an unsupported CAD variant.',
    errEmpty:
      'Could not display {label} — the file parsed successfully but contains no solid geometry (it may be surfaces/wireframe or an empty assembly).',
    errDegenerate:
      'Could not display {label} — the parsed geometry has invalid (non-finite) coordinates, so it cannot be framed. The previous model was kept.',
    errGeneric: 'Could not load {label} — the file may be invalid or unsupported.',

    // --- Model-info HUD ---
    modelStats: '{tris} tris · {x} × {y} × {z}{unit}',
    modelParts: '{parts} parts',
    modelPartsOne: '1 part',
    modelSummary:
      '3D view of {label}: {tris} triangles, bounding box {x} by {y} by {z}{unit}. Use arrow keys to orbit.',

    // --- STEP header metadata ("Details" disclosure, issue #96) ---
    metaDetails: 'Details',
    metaDetailsAria: 'Show STEP file details',
    metaHeading: 'STEP file details',
    metaCloseAria: 'Close details',
    metaSchema: 'Schema',
    metaAuthor: 'Author',
    metaOrg: 'Organization',
    metaSystem: 'Originating system',
    metaPreprocessor: 'Preprocessor',
    metaTimestamp: 'Timestamp',

    // --- Parts panel (assembly / multi-solid part list) ---
    partsPanelAria: 'Assembly parts',
    partsTitle: 'Parts',
    partsToggleTitle: 'Collapse / expand the parts list',
    partsCount: '{count}',
    partsShowAll: 'Show all',
    partsHideAll: 'Hide all',
    partsShowAllAria: 'Show all parts',
    partsHideAllAria: 'Hide all parts',
    partsFallback: 'Part {n}',
    partsRowAria: 'Toggle visibility of {name}',
    descParts: 'Show / hide individual assembly parts',
  },

  // Second locale — a deliberately PARTIAL Spanish stub. Only some keys are
  // translated; every omitted key falls back to English per-key via t(), which
  // proves the fallback path. Filling it in later needs no code change — just
  // add the missing keys here.
  es: {
    appName: 'Visor STEP',
    wireframeLabel: 'Malla',
    wireframeTitle: 'Alternar malla (W)',
    materialLabel: 'Material',
    materialAria: 'Preajuste de material e iluminación',
    materialTitle: 'Preajuste de material e iluminación (Estudio / Técnico / Arcilla / Rayos X)',
    matStudio: 'Estudio',
    matTechnical: 'Técnico',
    matClay: 'Arcilla',
    matXray: 'Rayos X',
    fitLabel: 'Encuadrar',
    fitAria: 'Encuadrar vista',
    fitTitle: 'Encuadrar / restablecer vista (R o F, o doble clic en el lienzo)',
    contrastLabel: 'Contraste',
    contrastAria: 'Alto contraste',
    contrastTitle: 'Alternar alto contraste (C)',
    blueprintLabel: 'Plano',
    blueprintAria: 'Vista de plano (solo aristas)',
    blueprintTitle: 'Alternar vista de plano / solo aristas (B)',
    colorPartLabel: 'Colorear piezas',
    colorPartAria: 'Colorear por pieza',
    colorPartTitle: 'Colorear piezas por sólido (P)',
    themeAria: 'Alternar tema claro y oscuro',
    themeTitle: 'Alternar tema claro / oscuro (T)',
    openLabel: 'Abrir archivo STEP…',
    openAria: 'Abrir archivo STEP',
    openTitle: 'Abrir un archivo STEP / IGES / BREP (o arrástralo y suéltalo sobre la vista)',
    saveLabel: 'Guardar imagen',
    saveAria: 'Guardar imagen (PNG)',
    saveTitle: 'Guardar la vista actual como PNG (S)',
    exportLabel: 'Exportar GLB',
    exportAria: 'Exportar modelo como GLB',
    exportTitle: 'Exportar el modelo cargado como glTF binario (.glb) (E)',
    exportTitleDisabled: 'Carga un modelo primero y luego expórtalo como .glb',
    exportFailed: 'No se pudo exportar el modelo: no se pudo generar el GLB.',
    exportNothing: 'Carga un modelo primero y luego expórtalo como GLB.',
    descExport: 'Exportar modelo como GLB',
    shareLabel: 'Copiar enlace',
    shareAria: 'Copiar enlace para compartir',
    shareTitle: 'Copiar un enlace para compartir esta vista',
    shareTitleDisabled: 'Solo se pueden compartir los ejemplos de la galería — abre un ejemplo para obtener un enlace',
    shareCopied: 'Enlace copiado al portapapeles',
    shareCopiedShort: '¡Copiado!',
    shareFallbackLabel: 'Copia este enlace:',
    shareFallbackDismiss: 'Descartar',
    embedLabel: 'Copiar código de inserción',
    embedAria: 'Copiar código de inserción',
    embedTitle: 'Copiar un fragmento <iframe> para insertar esta vista',
    embedTitleDisabled: 'Solo se pueden insertar los ejemplos de la galería — abre un ejemplo para obtener el código de inserción',
    embedCopied: 'Código de inserción copiado al portapapeles',
    embedFallbackLabel: 'Copia este código de inserción:',
    embedIframeTitle: 'Visor STEP — {label}',
    measureLabel: 'Medir',
    measureAria: 'Medir distancia',
    measureTitle: 'Medir la distancia entre dos puntos (M)',
    measureClearLabel: 'Borrar',
    measureClearAria: 'Borrar medición',
    measureClearTitle: 'Borrar medición (Esc)',
    measureOn: 'Modo de medición activado: haz clic en dos puntos del modelo para medir la distancia entre ellos.',
    measureOff: 'Modo de medición desactivado.',
    measureFirst: 'Primer punto fijado: haz clic en un segundo punto para medir.',
    measureResult: 'Distancia: {dist} (unidades del modelo). Haz clic en dos puntos nuevos para medir otra vez, o pulsa Esc para borrar.',
    sectionLabel: 'Sección',
    sectionAria: 'Plano de sección / corte transversal',
    sectionTitle: 'Alternar plano de sección / corte transversal',
    sectionPanelTitle: 'Sección',
    sectionAxisAria: 'Eje del plano de sección',
    sectionAxisXAria: 'Cortar a lo largo del eje X',
    sectionAxisYAria: 'Cortar a lo largo del eje Y',
    sectionAxisZAria: 'Cortar a lo largo del eje Z',
    sectionFlipTitle: 'Invertir la dirección del corte',
    sectionFlipAria: 'Invertir la dirección del corte',
    sectionSliderAria: 'Posición del plano de sección',
    sectionOn: 'Sección activada: elige un eje (X / Y / Z) y arrastra el control para cortar el modelo; el interior se muestra como corte transversal. Invertir cambia el lado del corte.',
    sectionOff: 'Sección desactivada: renderizado normal restaurado.',
    selectFitLabel: 'Encuadrar selección',
    selectFitAria: 'Encuadrar la selección',
    selectFitTitle: 'Encuadrar la cámara en la cara seleccionada (Z)',
    selectReadout: 'Seleccionado: {name}',
    selectFallback: 'Cara {index}',
    selectHint: '{name} seleccionada: pulsa Z para encuadrar la vista o Esc para borrar.',
    selectCleared: 'Selección borrada.',
    explodePanelTitle: 'Explosión',
    explodeSliderAria: 'Vista de despiece del ensamblaje: separar las piezas',
    explodeSingle: 'Modelo de un solo sólido: el despiece se aplica a ensamblajes de varias piezas.',
    descExplode: 'Despiezar ensamblajes de varias piezas',
    descMeasure: 'Alternar medición de distancia',
    descMeasureClear: 'Borrar medición',
    kEsc: 'Esc',
    kClick: 'Clic',
    descSelect: 'Seleccionar una cara (Esc / clic en vacío borra)',
    descSelectFit: 'Encuadrar en la cara seleccionada',
    helpAria: 'Atajos de teclado y controles',
    helpTitle: 'Atajos de teclado y controles (pulsa ?)',
    presetsAria: 'Vistas de cámara estándar',
    viewFrontLabel: 'Frente',
    viewBackLabel: 'Atrás',
    viewTopLabel: 'Arriba',
    viewBottomLabel: 'Abajo',
    viewRightLabel: 'Derecha',
    viewLeftLabel: 'Izquierda',
    viewIsoLabel: 'Iso',
    viewFrontDesc: 'Vista frontal (+Z, Numpad 1)',
    viewBackDesc: 'Vista posterior (−Z, Numpad 2)',
    viewRightDesc: 'Vista derecha (+X, Numpad 3)',
    viewLeftDesc: 'Vista izquierda (−X, Numpad 4)',
    viewTopDesc: 'Vista superior (+Y, Numpad 5)',
    viewBottomDesc: 'Vista inferior (−Y, Numpad 6)',
    viewIsoDesc: 'Vista isométrica (Numpad 0)',
    descViews: 'Vistas estándar (Frente/Atrás/Arriba/Abajo/Derecha/Izquierda/Iso)',
    helpHeading: 'Atajos y controles',
    helpCloseAria: 'Cerrar ayuda',
    kDrag: 'Arrastrar',
    kScroll: 'Rueda',
    kDrop: 'Soltar',
    descOrbitModel: 'Orbitar el modelo',
    descZoom: 'Acercar / alejar',
    descOrbitCamera: 'Orbitar cámara (vista enfocada)',
    descZoomCamera: 'Acercar / alejar cámara',
    descPan: 'Desplazar el objetivo de la vista',
    descHome: 'Reencuadrar / restablecer vista',
    descWireframe: 'Alternar malla',
    descContrast: 'Alternar alto contraste',
    descBlueprint: 'Alternar vista de plano (solo aristas)',
    descColorPart: 'Alternar colorear por pieza',
    descTheme: 'Alternar tema claro / oscuro',
    descSave: 'Guardar imagen (PNG)',
    descFit: 'Encuadrar / restablecer vista',
    descSamples: 'Cargar ejemplos de la galería',
    descOpen: 'Abrir un archivo .step / .iges / .brep',
    loadStatusEngine: 'Cargando motor 3D…',
    loadStatusParse: 'Analizando modelo STEP…',
    engineErrorDefault: 'No se pudo cargar el motor 3D: comprueba tu conexión.',
    captureFailed: 'No se pudo guardar la imagen: no se pudo capturar la vista 3D.',
    captureNothing: 'Carga un modelo primero y luego guarda la vista como imagen.',
    retry: 'Reintentar',
    dropOverlay: 'Suelta un archivo .step / .iges / .brep para cargarlo',
    galleryAria: 'Modelos de ejemplo',
    sampleGear: 'Engranaje',
    sampleBlock: 'Bloque',
    sampleTetra: 'Tetraedro',
    samplePyramid: 'Pirámide',
    sampleCube: 'Cubo (IGES)',
    sampleTitle: '{label} (pulsa {n})',
    hintPickModel: 'elige un modelo de la galería, o arrastra y suelta un archivo .step / .iges / .brep',
    hintTapModel: 'toca un modelo de la galería',
    zoomScroll: 'arrastra para orbitar · rueda para hacer zoom',
    zoomPinch: 'arrastra para orbitar · pellizca para hacer zoom',
    keyHint: ' · teclas: 1–5 ejemplos, R restablecer, W malla',
    loading: 'Cargando {label}…',
    loadedHint: '{label} · {zoom}',
    sizeSoftWarn: '{label} es grande ({size}) — el análisis puede ser lento.',
    sizeHardConfirm:
      '{label} es muy grande ({size}). Analizarlo puede agotar la memoria o bloquear la pestaña. ¿Cargarlo de todos modos?',
    metaDetails: 'Detalles',
    metaDetailsAria: 'Mostrar detalles del archivo STEP',
    metaHeading: 'Detalles del archivo STEP',
    metaCloseAria: 'Cerrar detalles',
    metaSchema: 'Esquema',
    metaAuthor: 'Autor',
    metaOrg: 'Organización',
    metaSystem: 'Sistema de origen',
    metaPreprocessor: 'Preprocesador',
    metaTimestamp: 'Fecha',
  },
};

// Resolve the active locale once, in preference order: ?lang=, then the
// browser's language list, falling back to `en`. A region tag (e.g. es-MX) that
// isn't listed falls back to its base language (es) when that is available.
function pickLocale(available) {
  const candidates = [];
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q) candidates.push(q);
  } catch (e) {}
  if (navigator.languages && navigator.languages.length) {
    candidates.push(...navigator.languages);
  } else if (navigator.language) {
    candidates.push(navigator.language);
  }
  for (const c of candidates) {
    if (!c) continue;
    const lc = String(c).toLowerCase();
    if (available.includes(lc)) return lc;
    const base = lc.split('-')[0];
    if (available.includes(base)) return base;
  }
  return 'en';
}

export const locale = pickLocale(Object.keys(messages));

// Publish the resolved code to the document so screen readers / browsers pick
// the right language, hyphenation, and voice.
try {
  document.documentElement.lang = locale;
} catch (e) {}

// Look up `key` in the active locale, fall back to English per-key, then to the
// raw key as a last resort, and interpolate any {name} placeholders from params.
export function t(key, params) {
  const table = messages[locale] || messages.en;
  let s = table[key];
  if (s == null) s = messages.en[key];
  if (s == null) return key; // surface the key rather than throwing on a typo
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) =>
      params[name] != null ? String(params[name]) : m);
  }
  return s;
}

// Populate static markup from the table. Two conventions:
//  - data-i18n="key"                       -> element.textContent = t(key)
//  - data-i18n-attr="attr:key;attr2:key2"  -> element.setAttribute(attr, t(key))
// Elements carrying data-i18n must not hold child elements whose text should
// survive (their textContent is replaced) — put an inner <span data-i18n> when
// siblings like an icon glyph need to stay.
export function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
      const idx = pair.indexOf(':');
      if (idx < 0) return;
      const attr = pair.slice(0, idx).trim();
      const key = pair.slice(idx + 1).trim();
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}
