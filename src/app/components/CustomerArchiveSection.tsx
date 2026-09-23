import React, { useEffect, useState } from 'react';
import type { ApiResponse, CustomerDetailDto } from '../../shared/types';
import { getCsrfToken, invalidateCsrfToken, parseAppError, type AppErrorInfo } from '../App';

interface CustomerArchiveSectionProps {
  readonly customer: CustomerDetailDto;
  readonly onCustomerReload: () => Promise<void>;
}

interface ArchiveAttempt {
  readonly body: string;
  readonly idempotencyKey: string;
}

const buttonStyle: React.CSSProperties = {
  border: '1px solid #fecaca',
  borderRadius: '0.375rem',
  backgroundColor: '#fff1f2',
  color: '#9f1239',
  cursor: 'pointer',
  fontSize: '0.8125rem',
  fontWeight: 600,
  padding: '0.45rem 0.75rem',
};

export const CustomerArchiveSection: React.FC<CustomerArchiveSectionProps> = ({
  customer,
  onCustomerReload,
}) => {
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AppErrorInfo | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<ArchiveAttempt | null>(null);

  useEffect(() => {
    setOpen(false);
    setReasonCode('');
    setError(null);
    setRetryAttempt(null);
  }, [customer.id, customer.version]);

  const execute = async (attempt: ArchiveAttempt) => {
    setSubmitting(true);
    setError(null);
    try {
      const csrfToken = await getCsrfToken();
      const res = await fetch(`/api/customers/${customer.id}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': attempt.idempotencyKey,
          'X-CSRF-Token': csrfToken,
        },
        body: attempt.body,
      });
      let json: ApiResponse<CustomerDetailDto> | null = null;
      try {
        json = (await res.json()) as ApiResponse<CustomerDetailDto>;
      } catch {
        // Access/login HTML and malformed responses are rendered as canonical errors below.
      }
      if (!res.ok || !json?.success) {
        const serverError = json && !json.success ? json.error : null;
        if (res.status === 403) invalidateCsrfToken();
        if (serverError?.code === 'OPEN_DEPENDENCIES') {
          setError({
            message:
              'Müşteri arşivlenemiyor. Önce açık poliçe ve işleri sonuçlandırın veya ilgili kayıtları arşivleyin.',
            isRetryable: false,
            category: 'CONFLICT',
          });
          setRetryAttempt(null);
          return;
        }
        const safeError = parseAppError(res.status, serverError);
        setError(safeError);
        setRetryAttempt(safeError.isRetryable ? attempt : null);
        return;
      }
      setRetryAttempt(null);
      setOpen(false);
      setReasonCode('');
      await onCustomerReload();
    } catch (cause) {
      setError(parseAppError(undefined, undefined, cause));
      setRetryAttempt(attempt);
    } finally {
      setSubmitting(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedReason = reasonCode.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(normalizedReason)) {
      setError({
        message: 'Arşiv nedeni zorunludur; büyük harf, rakam ve alt çizgi kullanınız.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }
    void execute({
      body: JSON.stringify({ expectedVersion: customer.version, reasonCode: normalizedReason }),
      idempotencyKey: crypto.randomUUID(),
    });
  };

  if (customer.archivedAt) {
    return (
      <div style={{ padding: '0.75rem', background: '#f1f5f9', color: '#475569' }}>
        Bu müşteri arşivlenmiştir. Geçmiş kayıtları korunur.
      </div>
    );
  }

  return (
    <section style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem' }}>
      {!open ? (
        <button type="button" style={buttonStyle} onClick={() => setOpen(true)}>
          Müşteriyi Arşivle
        </button>
      ) : (
        <form onSubmit={submit} style={{ display: 'grid', gap: '0.75rem' }}>
          <strong>Müşteriyi arşivle</strong>
          <p style={{ margin: 0, color: '#475569', fontSize: '0.8125rem' }}>
            Arşivleme silme işlemi değildir. Müşteri geçmişi korunur; açık bağımlılıklar varsa
            sunucu işlemi reddeder.
          </p>
          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.8125rem' }}>
            Arşiv Nedeni
            <input
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value)}
              placeholder="Örn: PORTFOLIO_CLOSED"
              autoComplete="off"
            />
          </label>
          {error && (
            <div role="alert" style={{ color: '#b91c1c', fontSize: '0.8125rem' }}>
              {error.message}
              {error.isRetryable && retryAttempt && (
                <button type="button" onClick={() => void execute(retryAttempt)}>
                  Tekrar Dene
                </button>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" style={buttonStyle} disabled={submitting}>
              {submitting ? 'Arşivleniyor...' : 'Arşivlemeyi Onayla'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setReasonCode('');
                setError(null);
                setRetryAttempt(null);
              }}
            >
              Vazgeç
            </button>
          </div>
        </form>
      )}
    </section>
  );
};
