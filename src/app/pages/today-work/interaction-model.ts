export type InteractionOutcome = 'CONTACT_CONFIRMED' | 'ATTEMPT_NO_RESPONSE' | 'NOTE';
export type InteractionChannel = 'PHONE' | 'EMAIL' | 'WHATSAPP' | 'IN_PERSON' | 'OTHER';
export type InteractionRisk = 'clean' | 'draft' | 'uncertain' | 'saved-unread';
export interface InteractionHistory {
  interactions: {
    id: string;
    outcome?: string | null;
    channel?: string | null;
    occurred_at?: string | null;
    note?: string | null;
    author_name?: string | null;
    company_contact_id?: string | null;
  }[];
  lastContactAt: string | null;
  lastAttemptAt: string | null;
  customerType: 'INDIVIDUAL' | 'COMPANY';
  companyContacts: { id: string; displayName: string; role: string | null }[];
}
export const interactionOutcomes: Record<string, string> = {
  CONTACT_CONFIRMED: 'Gerçek temas doğrulandı',
  ATTEMPT_NO_RESPONSE: 'Temas denemesi — yanıt yok',
  NOTE: 'Not',
  WHATSAPP_OPENED: 'WhatsApp açıldı; gerçek temas değildir.',
};
export const interactionChannels: Record<string, string> = {
  PHONE: 'Telefon',
  EMAIL: 'E-posta',
  WHATSAPP: 'WhatsApp',
  IN_PERSON: 'Yüz yüze',
  OTHER: 'Diğer',
};
const zone = 'Europe/Istanbul';
export function interactionTime(value: string | null | undefined) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('tr-TR', {
        timeZone: zone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
    : null;
}
export function localOccurrence(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const p = (key: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === key)?.value ?? '';
  return `${p('year').padStart(4, '0')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}`;
}
/** Resolve explicit local input; reject gaps, ambiguity and calendar rollover. */
export function canonicalOccurrence(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const local = value.length === 16 ? value + ':00' : value,
    iso = local + '.000Z',
    wanted = Date.parse(iso);
  if (!Number.isFinite(wanted) || new Date(wanted).toISOString() !== iso) return null;
  const offsets = new Set(
    [-36, -12, 0, 12, 36].map((hours) => {
      const sample = wanted + hours * 3600000;
      return Date.parse(localOccurrence(new Date(sample).toISOString()) + '.000Z') - sample;
    }),
  );
  const candidates = [...offsets]
    .map((offset) => wanted - offset)
    .filter((time) => localOccurrence(new Date(time).toISOString()) === local);
  return candidates.length === 1 ? new Date(candidates[0]!).toISOString() : null;
}
