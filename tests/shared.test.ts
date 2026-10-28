import { describe, it, expect } from 'vitest';
import { API_PREFIX, APP_NAME, DEFAULT_TIMEZONE } from '../src/shared/constants';
import type { ApiSuccessEnvelope, ApiErrorEnvelope } from '../src/shared/types';

describe('Paylaşılan Modül Sözleşmeleri (Shared Contracts & Types Tests)', () => {
  it('Paylaşılan sabitler doğru değerlere sahip olmalıdır', () => {
    expect(API_PREFIX).toBe('/api');
    expect(APP_NAME).toBe('Mayı Sigorta CRM');
    expect(DEFAULT_TIMEZONE).toBe('Europe/Istanbul');
  });

  it('Tip zarfları (ApiEnvelope) beklenen şemaya uymalıdır', () => {
    const successSample: ApiSuccessEnvelope<{ id: string }> = {
      success: true,
      data: { id: 'test-1' },
      timestamp: new Date().toISOString(),
    };
    expect(successSample.success).toBe(true);
    expect(successSample.data.id).toBe('test-1');

    const errorSample: ApiErrorEnvelope = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Doğrulama hatası',
      },
      timestamp: new Date().toISOString(),
    };
    expect(errorSample.success).toBe(false);
    expect(errorSample.error.code).toBe('VALIDATION_ERROR');
  });
});
