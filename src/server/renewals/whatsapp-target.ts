import { RenewalCommandError } from './commands';

// Intentionally no customer, policy, identity, health or document fields in the template.
export const WHATSAPP_DEFAULT_MESSAGE =
  'Merhaba, Mayı Sigorta olarak yenileme süreciniz hakkında görüşmek istiyoruz. Uygun olduğunuz zamanı paylaşabilir misiniz?';

export function normalizeWhatsAppPhone(raw: string | null): string {
  if (!raw) throw new RenewalCommandError('WHATSAPP_PHONE_REQUIRED', 409);
  if (raw.length > 50 || !/^\+?[0-9 ()-]+$/.test(raw))
    throw new RenewalCommandError('WHATSAPP_PHONE_INVALID', 409);
  let phone = raw.replace(/[ ()-]/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  else if (phone.startsWith('00')) phone = phone.slice(2);
  else if (/^0[2-5]\d{9}$/.test(phone)) phone = `90${phone.slice(1)}`;
  else if (/^[2-5]\d{9}$/.test(phone)) phone = `90${phone}`;
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new RenewalCommandError('WHATSAPP_PHONE_INVALID', 409);
  return phone;
}

export function buildWhatsAppUrl(phone: string, message: string): string {
  // Phone is canonical digits only; URL owns encoding and the only permitted query parameter.
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new RenewalCommandError('WHATSAPP_PHONE_INVALID', 409);
  const url = new URL(`https://wa.me/${phone}`);
  url.searchParams.set('text', message);
  return url.href;
}
