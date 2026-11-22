import { z } from 'zod';
const optionalText = (max: number, min = 1) =>
  z
    .preprocess(
      (value) => (typeof value === 'string' && !value.trim() ? null : value),
      z.string().trim().min(min).max(max).nullable(),
    )
    .default(null);
export const vehicleFieldsSchema = z
  .object({
    plate: optionalText(30, 2),
    brand: optionalText(80),
    model: optionalText(100),
    modelYear: z.number().int().min(1900).max(9999).nullable().default(null),
    vin: optionalText(50),
    engineNumber: optionalText(50),
    registrationSerial: optionalText(50),
  })
  .strict()
  .refine((value) =>
    Object.values(value).every(
      (field) =>
        typeof field !== 'string' ||
        [...field].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
    ),
  );
export type VehicleFields = z.infer<typeof vehicleFieldsSchema>;
export interface CustomerVehicle {
  readonly id: string;
  readonly customerId: string;
  readonly version: number;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly details: VehicleFields;
}
export interface PolicyVehicle {
  readonly vehicleId: string;
  readonly vehicleVersion: number;
  readonly details: VehicleFields;
}
export interface VehiclePage {
  readonly items: readonly CustomerVehicle[];
  readonly nextCursor: string | null;
}
export function normalizePlate(plate: string | null) {
  if (plate === null) return null;
  return plate
    .normalize('NFKC')
    .replace(/[iİı]/g, 'I')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}
export function vehicleLabel(details: VehicleFields) {
  return (
    details.plate ||
    [details.brand, details.model, details.modelYear].filter((value) => value !== null).join(' ') ||
    'Bilgileri girilmemiş araç'
  );
}
