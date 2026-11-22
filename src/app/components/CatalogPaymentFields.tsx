interface Props {
  id: string;
  enabled: boolean;
  maximum: string;
  onEnabled: (value: boolean) => void;
  onMaximum: (value: string) => void;
}

export function CatalogPaymentFields({ id, enabled, maximum, onEnabled, onMaximum }: Props) {
  return (
    <fieldset className="catalog-payment-fields">
      <legend>Taksit ayarları</legend>
      <label className="catalog-check" htmlFor={`${id}-enabled`}>
        <input
          id={`${id}-enabled`}
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabled(event.target.checked)}
        />
        Bu ödeme yöntemi taksiti destekler
      </label>
      {enabled && (
        <div>
          <label htmlFor={`${id}-maximum`}>En fazla taksit sayısı</label>
          <input
            id={`${id}-maximum`}
            type="number"
            min={2}
            max={36}
            step={1}
            required
            value={maximum}
            onChange={(event) => onMaximum(event.target.value)}
            aria-describedby={`${id}-help`}
          />
        </div>
      )}
      <p id={`${id}-help`} className="catalog-hint">
        Katalog sınırı 2–36 taksittir. Kısa Poliçelendir akışında en fazla 9 taksit seçilir. Ödeme
        yöntemi seçmek tahsilat kaydı oluşturmaz.
      </p>
    </fieldset>
  );
}
