import React, { useState, useEffect, useRef } from 'react';
import type { CustomerDetailDto, ApiResponse, CustomerIdentityRevealDto } from '../../shared/types';
import { parseAppError, getCsrfToken, type AppErrorInfo } from '../App';

interface MutationSnapshot {
  readonly url: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

interface CustomerIdentitySectionProps {
  readonly customer: CustomerDetailDto;
  readonly onCustomerReload: () => Promise<void>;
  readonly styles: Record<string, unknown>;
}

export const CustomerIdentitySection: React.FC<CustomerIdentitySectionProps> = ({
  customer,
  onCustomerReload,
}) => {
  const [revealedIdentity, setRevealedIdentity] = useState<string | null>(null);
  const [revealLoading, setRevealLoading] = useState<boolean>(false);
  const [revealError, setRevealError] = useState<AppErrorInfo | null>(null);

  const [showEdit, setShowEdit] = useState<boolean>(false);
  const [identityType, setIdentityType] = useState<'TCKN' | 'VKN'>(
    customer.type === 'COMPANY' ? 'VKN' : 'TCKN',
  );
  const [identityValue, setIdentityValue] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [actionError, setActionError] = useState<AppErrorInfo | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<MutationSnapshot | null>(null);
  const previousCustomerId = useRef(customer.id);

  // Müşteri değiştiğinde veya bileşen unmount olduğunda açık kimliği bellekten temizle
  useEffect(() => {
    if (previousCustomerId.current === customer.id) return;
    previousCustomerId.current = customer.id;
    setRevealedIdentity(null);
    setRevealError(null);
    setShowEdit(false);
    setIdentityValue('');
    setActionError(null);
    setRetryAttempt(null);
  }, [customer.id]);

  const handleReveal = async () => {
    setRevealLoading(true);
    setRevealError(null);
    try {
      const res = await fetch(`/api/customers/${customer.id}/identity`);
      if (!res.ok) {
        let errPayload: { error?: { code?: string; message?: string } } | null = null;
        try {
          errPayload = await res.json();
        } catch {
          // ignore
        }
        setRevealError(parseAppError(res.status, errPayload?.error));
        return;
      }
      const json = (await res.json()) as ApiResponse<CustomerIdentityRevealDto>;
      if (json.success && json.data) {
        setRevealedIdentity(json.data.identityValue);
      } else {
        setRevealError(parseAppError(res.status, json.success === false ? json.error : null));
      }
    } catch (err) {
      setRevealError(parseAppError(undefined, undefined, err));
    } finally {
      setRevealLoading(false);
    }
  };

  const handleHide = () => {
    setRevealedIdentity(null);
    setRevealError(null);
  };

  const executeIdentityMutation = async (snapshot: MutationSnapshot) => {
    setSubmitting(true);
    setActionError(null);
    try {
      const csrfToken = await getCsrfToken();
      const res = await fetch(snapshot.url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          'Idempotency-Key': snapshot.idempotencyKey,
        },
        body: snapshot.body,
      });

      if (!res.ok) {
        let errPayload: { error?: { code?: string; message?: string } } | null = null;
        try {
          errPayload = await res.json();
        } catch {
          // ignore
        }
        const appErr = parseAppError(res.status, errPayload?.error);
        setActionError(appErr);
        if (appErr.isRetryable) {
          setRetryAttempt(snapshot);
        } else {
          setRetryAttempt(null);
        }
        return;
      }

      const json = (await res.json()) as ApiResponse<unknown>;
      if (json.success) {
        setRetryAttempt(null);
        setActionError(null);
        setRevealedIdentity(null);
        setIdentityValue('');
        setShowEdit(false);
        await onCustomerReload();
      } else {
        const appErr = parseAppError(res.status, json.error);
        setActionError(appErr);
        if (appErr.isRetryable) {
          setRetryAttempt(snapshot);
        } else {
          setRetryAttempt(null);
        }
      }
    } catch (err) {
      const appErr = parseAppError(undefined, undefined, err);
      setActionError(appErr);
      setRetryAttempt(snapshot);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveIdentity = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!identityValue.trim()) {
      setActionError({
        message: 'Girdi doğrulama hatası: Kimlik numarası boş olamaz.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }
    const snapshot: MutationSnapshot = {
      url: `/api/customers/${customer.id}/identity`,
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        expectedVersion: customer.version,
        identityType,
        identityValue: identityValue.trim(),
      }),
    };
    void executeIdentityMutation(snapshot);
  };

  const handleClearIdentity = () => {
    const snapshot: MutationSnapshot = {
      url: `/api/customers/${customer.id}/identity`,
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        expectedVersion: customer.version,
        clear: true,
      }),
    };
    void executeIdentityMutation(snapshot);
  };

  const handleRetry = () => {
    if (retryAttempt) {
      void executeIdentityMutation(retryAttempt);
    }
  };

  return (
    <div
      style={{
        marginTop: '1.25rem',
        padding: '1rem',
        border: '1px solid #e2e8f0',
        borderRadius: '0.5rem',
        backgroundColor: '#f8fafc',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '0.75rem',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#1e293b' }}>
          Hassas Kimlik Bilgisi ({customer.type === 'COMPANY' ? 'VKN' : 'TCKN'})
        </span>
        <button
          type="button"
          onClick={() => {
            if (showEdit) {
              setIdentityValue('');
            }
            setShowEdit(!showEdit);
            setActionError(null);
            setRetryAttempt(null);
          }}
          style={{
            backgroundColor: '#f1f5f9',
            color: '#334155',
            border: '1px solid #cbd5e1',
            borderRadius: '0.25rem',
            padding: '0.25rem 0.625rem',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {showEdit ? 'Kapat' : 'Kimlik Bilgisini Güncelle'}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: '0.9375rem',
            color: '#0f172a',
            fontWeight: 600,
          }}
        >
          {revealedIdentity ? (
            <span style={{ color: '#047857' }}>{revealedIdentity}</span>
          ) : customer.hasIdentity && customer.identityMasked ? (
            <span>{customer.identityMasked}</span>
          ) : (
            <span style={{ color: '#64748b', fontStyle: 'italic' }}>Tanımlanmamış</span>
          )}
        </div>

        {revealedIdentity ? (
          <button
            type="button"
            onClick={handleHide}
            style={{
              backgroundColor: '#f1f5f9',
              color: '#475569',
              border: '1px solid #cbd5e1',
              borderRadius: '0.25rem',
              padding: '0.25rem 0.5rem',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Kimliği Gizle
          </button>
        ) : (
          customer.hasIdentity && (
            <button
              type="button"
              onClick={() => void handleReveal()}
              disabled={revealLoading}
              style={{
                backgroundColor: '#2563eb',
                color: '#ffffff',
                border: 'none',
                borderRadius: '0.25rem',
                padding: '0.25rem 0.625rem',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {revealLoading ? 'Yükleniyor...' : 'Kimliği Göster'}
            </button>
          )
        )}
      </div>

      {revealError && (
        <div style={{ marginTop: '0.5rem', color: '#dc2626', fontSize: '0.8125rem' }}>
          {revealError.message}
        </div>
      )}

      {showEdit && (
        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #e2e8f0' }}>
          <form
            onSubmit={handleSaveIdentity}
            style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
          >
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <select
                value={identityType}
                onChange={(e) => setIdentityType(e.target.value as 'TCKN' | 'VKN')}
                disabled={customer.type === 'COMPANY'}
                style={{
                  padding: '0.4rem 0.6rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #cbd5e1',
                  fontSize: '0.8125rem',
                }}
              >
                <option value="TCKN">TCKN</option>
                <option value="VKN">VKN</option>
              </select>
              <input
                type="text"
                value={identityValue}
                onChange={(e) => setIdentityValue(e.target.value)}
                placeholder="TCKN veya VKN giriniz"
                maxLength={identityType === 'TCKN' ? 11 : 10}
                style={{
                  flex: 1,
                  padding: '0.4rem 0.6rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #cbd5e1',
                  fontSize: '0.8125rem',
                }}
              />
              <button
                type="submit"
                disabled={submitting}
                style={{
                  backgroundColor: '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '0.375rem',
                  padding: '0.4rem 0.75rem',
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {submitting ? 'Kaydediliyor...' : 'Kimliği Kaydet'}
              </button>
              {customer.hasIdentity && (
                <button
                  type="button"
                  onClick={handleClearIdentity}
                  disabled={submitting}
                  style={{
                    backgroundColor: '#fee2e2',
                    color: '#991b1b',
                    border: '1px solid #fecaca',
                    borderRadius: '0.375rem',
                    padding: '0.4rem 0.75rem',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Kimliği Kaldır
                </button>
              )}
            </div>
            {actionError && (
              <div style={{ color: '#dc2626', fontSize: '0.8125rem' }}>
                {actionError.message}
                {actionError.isRetryable && (
                  <button
                    type="button"
                    onClick={handleRetry}
                    style={{
                      marginLeft: '0.5rem',
                      backgroundColor: '#2563eb',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '0.25rem',
                      padding: '0.2rem 0.5rem',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    Tekrar Dene
                  </button>
                )}
              </div>
            )}
          </form>
        </div>
      )}
    </div>
  );
};
