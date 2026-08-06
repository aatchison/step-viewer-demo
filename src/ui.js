// @ts-check
// UI text / formatting utilities extracted from the app's main module (issue
// #107). Pure string/number formatters plus the accepted-CAD-extension gate,
// with no renderer/scene/DOM closure state — the only dependency is the i18n
// table (for cause-worded error messages), imported the same build-free way as
// everywhere else. Importable and unit-testable in isolation.
import { t } from './i18n.js';

/**
 * The failure-cause tag every loader error carries on `err.kind` so callers
 * (see {@link describeError}) can word the message by cause instead of blaming
 * "parse" for an engine/CDN or network failure. Tagged at the throw site:
 * - `'init'` — occt/WASM engine or CDN download failure (worker or main thread).
 * - `'http'` — a fetch/HTTP status failure pulling the file bytes.
 * - `'parse'` — the engine ran but the bytes were not valid CAD for the reader.
 * - `'empty'` — parsed OK but carried no renderable/solid geometry (issue #97).
 * - `'degenerate'` — geometry parsed but is non-finite/NaN (issue #98).
 * @typedef {'init' | 'http' | 'parse' | 'empty' | 'degenerate'} ErrorKind
 */

/**
 * An Error decorated with a {@link ErrorKind} cause tag. `kind` may be absent on
 * an unclassified error, which {@link describeError} words generically.
 * @typedef {Error & { kind?: ErrorKind }} TaggedError
 */

// Accepted CAD file extensions, shared by the drop guard and the file-picker
// reject path so both stay in lockstep with what src/step.js can actually
// dispatch (STEP + the IGES/BREP readers occt already bundles). readerForExtension
// is the authoritative dispatch check; this regex is the fast UI-side gate.
export const CAD_EXT_RE = /\.(step|stp|iges|igs|brep|brp)$/i;

// Lower-case extension (no dot) of a file name, or '' when it has none.
/**
 * @param {string} name - A file name (or any string).
 * @returns {string} The lower-cased extension without the dot, or '' when none.
 */
export const extOf = (name) => {
  const m = /\.([^.]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};

// Compact dimension formatting: whole numbers past 100, one decimal past 10, two
// below — keeps a tiny 0.80 gear and a 250 block both legible. A non-finite
// dimension (degenerate/corrupt geometry, issue #98) collapses to a neutral
// em-dash placeholder instead of leaking the raw 'NaN'/'Infinity' token.
/**
 * @param {number} n - A dimension value.
 * @returns {string} Compact label: integer ≥100, one decimal ≥10, two decimals
 *   below, or an em-dash '—' for a non-finite value.
 */
export function fmtDim(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 100) return Math.round(n).toString();
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// Byte count → whole-MB label for the large-file guard messaging.
/**
 * @param {number} bytes - A byte count.
 * @returns {string} Whole-megabyte label, e.g. `"12 MB"`.
 */
export const fmtMB = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

// Round to ~4 significant digits so a long float like 4.7320508 shortens to
// 4.732 without exploding the deep-link hash. Non-finite guards to 0.
/**
 * @param {number} n - A number to shorten.
 * @returns {number} `n` rounded to ~4 significant digits; 0 for 0 or non-finite.
 */
export function roundSig(n) {
  if (!isFinite(n)) return 0;
  if (n === 0) return 0;
  return Number(n.toPrecision(4));
}

// Escape a string for safe use inside a double-quoted HTML attribute in the
// generated embed snippet (the model label flows into the title attribute).
/**
 * @param {unknown} s - A value to coerce to string and escape.
 * @returns {string} The value with &, ", <, > replaced by HTML entities so it is
 *   safe inside a double-quoted HTML attribute.
 */
export const escapeAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Turn a model label into a safe PNG/GLB basename: drop a trailing CAD extension
// (.step/.stp/.iges/.igs/.brep/.brp) so an opened "MyPart.iges" becomes "MyPart"
// (matching the sample's bare "Gear"), then replace filename-hostile characters.
// Falls back to "model".
/**
 * @param {string} label - A model display label (may include a CAD extension).
 * @returns {string} A filesystem-safe basename with any trailing CAD extension
 *   removed and hostile characters collapsed; `"model"` when nothing remains.
 */
export function captureBasename(label) {
  const base = String(label || 'model').replace(CAD_EXT_RE, '').trim();
  const safe = base.replace(/[^\w.-]+/g, '_').replace(/^[_.]+|_+$/g, '');
  return safe || 'model';
}

// Word a load failure by its cause so we never blame "parse" for an engine/CDN
// download failure or an HTTP fetch failure. Errors are tagged with `kind` at
// their source: 'init' (occt/WASM/CDN), 'http' (fetch/status), 'parse' (invalid
// STEP bytes), 'empty'/'degenerate' (geometry guards); anything else is generic.
/**
 * Word a load failure by its {@link ErrorKind} cause so the message never blames
 * "parse" for an engine/CDN or HTTP failure. Unknown/untagged errors fall
 * through to the generic message.
 * @param {TaggedError | null | undefined} err - The thrown error; its `kind`
 *   selects the message. May be nullish.
 * @param {string} label - The model label interpolated into the message.
 * @returns {string} A localized, cause-appropriate error message.
 */
export function describeError(err, label) {
  const kind = err && err.kind;
  if (kind === 'init') return t('errInit', { label });
  if (kind === 'http') return t('errHttp', { label, message: err.message });
  if (kind === 'parse') return t('errParse', { label });
  if (kind === 'empty') return t('errEmpty', { label });
  if (kind === 'degenerate') return t('errDegenerate', { label });
  return t('errGeneric', { label });
}
