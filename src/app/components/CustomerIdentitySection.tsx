import React, { useState, useEffect, useId, useRef } from 'react';
import type { CustomerDetailDto, ApiResponse, CustomerIdentityRevealDto } from '../../shared/types';
import { parseAppError, getCsrfToken, type AppErrorInfo } from '../App';
import { Button } from './ui/button';

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
  const formId = useId();
  const previousCustomerId = useRef(customer.id);

  // Müşteri değiştiğinde veya bileşen unmount olduğunda açık kimliği bellekten temizle
  useEffect(() => {
    if (previousCustomerId.current === customer.id) return;
    previousCustomerId.current = customer.id;
    setRevealedIdentity(null);
    setRevealError(null);
    setShowEdit(false);
    setIdentityType(customer.type === 'COMPANY' ? 'VKN' : 'TCKN');
    setIdentityValue('');
    setActionError(null);
    setRetryAttempt(null);
  }, [customer.id, customer.type]);

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
        identityType: customer.type === 'COMPANY' ? 'VKN' : identityType,
        identityValue: identityValue.trim(),
      }),
    };
    void executeIdentityMutation(snapshot);
  };

  const handleClearIdentity = () => {
    if (customer.type === 'COMPANY') return;
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
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '0.75rem',
        }}
      >
        <span id={formId} style={{ fontWeight: 600, fontSize: '0.875rem', color: '#1e293b' }}>
          {customer.type === 'COMPANY' ? 'Vergi numarası (VKN)' : 'Hassas Kimlik Bilgisi'}
        </span>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (showEdit) {
              setIdentityValue('');
            }
            setShowEdit(!showEdit);
            setActionError(null);
            setRetryAttempt(null);
          }}
        >
          {showEdit
            ? 'Kapat'
            : customer.type === 'COMPANY' && !customer.hasIdentity
              ? 'Vergi numarası ekle'
              : 'Kimlik Bilgisini Güncelle'}
        </Button>
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
            aria-labelledby={formId}
            method="post"
            onSubmit={handleSaveIdentity}
            style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
          >
            <div style={{ display: 'flex', gap: '0.5rem', flexDirection: 'column' }}>
              {customer.type !== 'COMPANY' && (
                <>
                  <label htmlFor={`${formId}-type`}>Kimlik türü</label>
                  <select
                    id={`${formId}-type`}
                    value={identityType}
                    onChange={(e) => setIdentityType(e.target.value as 'TCKN' | 'VKN')}
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
                </>
              )}
              <label htmlFor={`${formId}-number`}>
                {customer.type === 'COMPANY'
                  ? 'Vergi numarası (10 hane)'
                  : `${identityType} numarası`}
              </label>
              <input
                type="text"
                id={`${formId}-number`}
                inputMode="numeric"
                autoComplete="off"
                required
                value={identityValue}
                onChange={(e) => setIdentityValue(e.target.value)}
                maxLength={customer.type === 'COMPANY' || identityType === 'VKN' ? 10 : 11}
                style={{
                  flex: 1,
                  padding: '0.4rem 0.6rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #cbd5e1',
                  fontSize: '0.8125rem',
                }}
              />
              <Button type="submit" disabled={submitting} className="self-start">
                {submitting ? 'Kaydediliyor...' : 'Kimliği Kaydet'}
              </Button>
              {customer.hasIdentity && customer.type !== 'COMPANY' && (
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
