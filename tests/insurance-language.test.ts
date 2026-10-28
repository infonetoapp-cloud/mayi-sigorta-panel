import { expect, it } from 'vitest';
import { renewalStateLabel, archiveReasons } from '../src/app/lib/insurance-language';
it('keeps renewal meaning and archive labels separate from cancellation and raw internal codes', () => {
  expect(renewalStateLabel('WON')).toBe('Yenilendi');
  expect(renewalStateLabel('LOST')).toBe('Yenilenmedi');
  expect(renewalStateLabel('QUOTE_SENT')).toBe('Teklif gönderildi');
  expect(renewalStateLabel('UNKNOWN_INTERNAL')).toBe('Durum bilgisi bulunmuyor');
  expect(archiveReasons.HISTORICAL_RECORD).toBe('Yalnız geçmişte izlenecek kayıt');
});
