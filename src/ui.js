// UI text / formatting utilities extracted from the app's main module (issue
// #107). Pure string/number formatters plus the accepted-CAD-extension gate,
// with no renderer/scene/DOM closure state — the only dependency is the i18n
// table (for cause-worded error messages), imported the same build-free way as
// everywhere else. Importable and unit-testable in isolation.
import { t } from './i18n.js';

// Accepted CAD file extensions, shared by the drop guard and the file-picker
// reject path so both stay in lockstep with what src/step.js can actually
// dispatch (STEP + the IGES/BREP readers occt already bundles). readerForExtension
// is the authoritative dispatch check; this regex is the fast UI-side gate.
export const CAD_EXT_RE = /\.(step|stp|iges|igs|brep|brp)$/i;

// Lower-case extension (no dot) of a file name, or '' when it has none.
export const extOf = (name) => {
  const m = /\.([^.]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};

// Compact dimension formatting: whole numbers past 100, one decimal past 10, two
// below — keeps a tiny 0.80 gear and a 250 block both legible. A non-finite
// dimension (degenerate/corrupt geometry, issue #98) collapses to a neutral
// em-dash placeholder instead of leaking the raw 'NaN'/'Infinity' token.
export function fmtDim(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 100) return Math.round(n).toString();
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// Byte count → whole-MB label for the large-file guard messaging.
export const fmtMB = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

// Round to ~4 significant digits so a long float like 4.7320508 shortens to
// 4.732 without exploding the deep-link hash. Non-finite guards to 0.
export function roundSig(n) {
  if (!isFinite(n)) return 0;
  if (n === 0) return 0;
  return Number(n.toPrecision(4));
}

// Escape a string for safe use inside a double-quoted HTML attribute in the
// generated embed snippet (the model label flows into the title attribute).
export const escapeAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Turn a model label into a safe PNG/GLB basename: drop a trailing CAD extension
// (.step/.stp/.iges/.igs/.brep/.brp) so an opened "MyPart.iges" becomes "MyPart"
// (matching the sample's bare "Gear"), then replace filename-hostile characters.
// Falls back to "model".
export function captureBasename(label) {
  const base = String(label || 'model').replace(CAD_EXT_RE, '').trim();
  const safe = base.replace(/[^\w.-]+/g, '_').replace(/^[_.]+|_+$/g, '');
  return safe || 'model';
}

// Word a load failure by its cause so we never blame "parse" for an engine/CDN
// download failure or an HTTP fetch failure. Errors are tagged with `kind` at
// their source: 'init' (occt/WASM/CDN), 'http' (fetch/status), 'parse' (invalid
// STEP bytes), 'empty'/'degenerate' (geometry guards); anything else is generic.
export function describeError(err, label) {
  const kind = err && err.kind;
  if (kind === 'init') return t('errInit', { label });
  if (kind === 'http') return t('errHttp', { label, message: err.message });
  if (kind === 'parse') return t('errParse', { label });
  if (kind === 'empty') return t('errEmpty', { label });
  if (kind === 'degenerate') return t('errDegenerate', { label });
  return t('errGeneric', { label });
}
