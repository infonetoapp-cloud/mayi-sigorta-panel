import { useId } from 'react';
import type { VehicleFields as Fields } from '../../../shared/vehicles';
export const vehicleLabels = {
  plate: 'Plaka',
  brand: 'Marka',
  model: 'Model',
  modelYear: 'Model yılı',
  vin: 'Şasi no',
  engineNumber: 'Motor no',
  registrationSerial: 'Ruhsat seri no',
} as const;
export type VehicleDraft = Record<keyof Fields, string>;
export const emptyVehicleDraft: VehicleDraft = {
  plate: '',
  brand: '',
  model: '',
  modelYear: '',
  vin: '',
  engineNumber: '',
  registrationSerial: '',
};
export const vehicleDraft = (value: Fields): VehicleDraft =>
  Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, field?.toString() ?? '']),
  ) as VehicleDraft;
export function vehicleInput(value: VehicleDraft) {
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      key === 'modelYear' ? (field ? Number(field) : null) : field.trim() || null,
    ]),
  );
}
export function VehicleFieldsEditor({
  draft,
  onChange,
  disabled,
}: {
  draft: VehicleDraft;
  onChange: (value: VehicleDraft) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <fieldset disabled={disabled} className="vehicle-fields">
      <legend>Araç bilgileri</legend>
      {(Object.keys(vehicleLabels) as (keyof Fields)[]).map((key) => (
        <div key={key}>
          <label htmlFor={id + key}>
            {vehicleLabels[key]}
            {' (isteğe bağlı)'}
          </label>
          <input
            id={id + key}
            name={key}
            type="text"
            inputMode={key === 'modelYear' ? 'numeric' : undefined}
            pattern={key === 'modelYear' ? '[0-9]{4}' : undefined}
            maxLength={
              key === 'plate'
                ? 30
                : key === 'modelYear'
                  ? 4
                  : key === 'brand'
                    ? 80
                    : key === 'model'
                      ? 100
                      : 50
            }
            value={draft[key]}
            onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
      ))}
    </fieldset>
  );
}
export function VehicleSummary({ details }: { details: Fields }) {
  return (
    <dl className="customer-info-grid vehicle-summary">
      {(Object.keys(vehicleLabels) as (keyof Fields)[]).map((key) => (
        <div key={key}>
          <dt>{vehicleLabels[key]}</dt>
          <dd>{details[key] ?? 'Belirtilmedi'}</dd>
        </div>
      ))}
    </dl>
  );
}
