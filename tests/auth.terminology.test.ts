import { expect, it } from 'vitest';
import { authErrorMessage } from '../src/app/auth-errors';
it('explains permission dependency and concurrent personnel changes in practical Turkish without raw diagnostics', () => {
  expect(authErrorMessage('INVALID_GRANTS', 400)).toBe(
    'Seçili izinler birbiriyle uyumlu değil. İzin kapsamlarını ve gerekli okuma izinlerini kontrol edin.',
  );
  expect(authErrorMessage('CONFLICT', 409)).toBe(
    'Personel bilgileri veya yetkileri değişti. Güncel kaydı inceleyip değişiklikleri tekrar onaylayın.',
  );
  expect(authErrorMessage('UNAUTHORIZED', 401)).toBe('Oturumunuz sona erdi. Yeniden giriş yapın.');
  expect(authErrorMessage('synthetic unsafe SQL', 500)).not.toContain('SQL');
});
