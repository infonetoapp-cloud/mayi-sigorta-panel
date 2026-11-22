import { z } from 'zod';

export const taxNumberSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{10}$/, 'Vergi no 10 rakamdan oluşmalıdır.');
export const manualCustomerNumberSchema = z
  .string()
  .trim()
  .min(1, 'Müşteri no zorunludur.')
  .max(100)
  .refine(
    (value) => [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
    'Müşteri no kontrol karakteri içeremez.',
  );
export const registrationInsurerNumberSchema = z
  .object({
    insurerId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/, 'Sigorta şirketi seçin.'),
    customerNumber: manualCustomerNumberSchema,
  })
  .strict();
