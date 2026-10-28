const filterDefaults = {
  search: '',
  searchMode: 'exact',
  insurerId: '',
  customerId: '',
  status: '',
  endFrom: '',
  endTo: '',
  sort: 'end_date_asc',
};
export const portfolioDefaults = filterDefaults;
export type PortfolioFilters = typeof filterDefaults;
export function portfolioFilters(params: URLSearchParams): PortfolioFilters {
  return Object.fromEntries(
    Object.entries(filterDefaults).map(([key, fallback]) => [key, params.get(key) ?? fallback]),
  ) as PortfolioFilters;
}
/** Calendar days, not a rolling UTC-hour window. Both boundaries are inclusive. */
export function expirationRange(days: number | 'past', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  const end = new Date(today + 'T12:00:00Z');
  end.setUTCDate(end.getUTCDate() + (days === 'past' ? -1 : days - 1));
  return { endFrom: days === 'past' ? '' : today, endTo: end.toISOString().slice(0, 10) };
}
/** Only a local portfolio URL and known filter keys may become a return link. */
export function portfolioReturn(state: unknown): string {
  const value =
    state && typeof state === 'object' && 'policyListReturn' in state
      ? state.policyListReturn
      : undefined;
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    (value !== '/policies' && !value.startsWith('/policies?'))
  )
    return '/policies';
  const input = new URLSearchParams(value.split('?').slice(1).join('?'));
  const output = new URLSearchParams();
  for (const key of [...Object.keys(filterDefaults), 'cursor', 'preview']) {
    const field = input.get(key);
    if (field) output.set(key, field);
  }
  return '/policies' + (output.size ? '?' + output : '');
}
