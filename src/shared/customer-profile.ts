/** Date-only customer data: never convert birthdays to an instant or store age. */
export function istanbulToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function validBirthDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function referenceSearchKey(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase('tr-TR').replace(/\s+/gu, ' ');
}

export interface CustomerReferenceOption {
  membershipId: string;
  displayName: string;
}
export interface CustomerReferenceOptions {
  items: CustomerReferenceOption[];
  nextCursor: string | null;
}
