/** Public input policy only; no hasher, verifier, credential or server configuration. */
export const PASSWORD_MIN_CODEPOINTS = 15;
export const PASSWORD_MAX_CODEPOINTS = 128;
export const PASSWORD_INPUT_MESSAGE =
  'Parola 15–128 Unicode karakteri olmalıdır. Girdi kısaltılmaz.';
export function normalizeBoundedPassword(value: unknown): string | null {
  // Reject before normalization/allocation. Never use a browser maxlength that clips a paste.
  if (
    typeof value !== 'string' ||
    value.length > PASSWORD_MAX_CODEPOINTS * 2 ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    return null;
  const normalized = value.normalize('NFC');
  const length = Array.from(normalized).length;
  return length >= PASSWORD_MIN_CODEPOINTS && length <= PASSWORD_MAX_CODEPOINTS ? normalized : null;
}
