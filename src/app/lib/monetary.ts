/** UI boundary only. Existing persistence contract uses two minor digits for every supported currency. */
export function parseMoneyInput(
  text: string,
  signed = false,
): { canonical: string; minor: bigint } | null {
  const raw = text.trim();
  if (!raw || raw.length > 64) return null;
  const negative = raw.startsWith('-');
  if (negative && !signed) return null;
  const value = negative ? raw.slice(1) : raw;
  let decimal: string;
  if (/^(?:0|[1-9]\d*)(?:[.,]\d{1,2})?$/.test(value)) {
    decimal = value.replace(',', '.');
  } else if (/^[1-9]\d{0,2}(?:\.\d{3})+,\d{1,2}$/.test(value)) {
    // Grouping is accepted only with an explicit Turkish decimal comma.
    // A lone 12.500 or 12,500 is never guessed to be either cents or thousands.
    decimal = value.replaceAll('.', '').replace(',', '.');
  } else return null;
  const [whole, fraction = ''] = decimal.split('.');
  const absolute = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (absolute > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const minor = negative ? -absolute : absolute;
  const sign = minor < 0n ? '-' : '';
  return {
    canonical: `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`,
    minor,
  };
}
export function formatMoneyMinor(minor: number, currency: string): string {
  if (
    !Number.isSafeInteger(minor) ||
    !/^[A-Z]{3}$/.test(currency) ||
    !new Set(Intl.supportedValuesOf('currency')).has(currency)
  )
    return 'Tutar kullanılamıyor';
  const value = BigInt(minor),
    negative = value < 0n,
    absolute = negative ? -value : value;
  // Intl is used only for integer grouping and the currency label, never amount conversion/rounding.
  const symbol =
    new Intl.NumberFormat('tr-TR', { style: 'currency', currency, currencyDisplay: 'symbol' })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value ?? currency;
  return `${negative ? '-' : ''}${new Intl.NumberFormat('tr-TR').format(absolute / 100n)},${(absolute % 100n).toString().padStart(2, '0')} ${symbol}`;
}
export const MONEY_INPUT_HELP =
  '12500,50 veya 12500.50 yazın; Türkçe binlik gösterim: 12.500,50. En fazla iki ondalık kullanın; 12.500 gibi belirsiz girişler kabul edilmez.';
