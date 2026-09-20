import React, { useState, useEffect, useCallback } from 'react';
import type {
  CustomerDetailDto,
  ApiResponse,
  ExternalCustomerReferenceDto,
} from '../../shared/types';
import { parseAppError, getCsrfToken, type AppErrorInfo } from '../App';

interface MutationSnapshot {
  readonly url: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

interface CustomerExternalReferencesSectionProps {
  readonly customer: CustomerDetailDto;
  readonly onCustomerReload: () => Promise<void>;
}

export const CustomerExternalReferencesSection: React.FC<
  CustomerExternalReferencesSectionProps
> = ({ customer, onCustomerReload }) => {
  const [references, setReferences] = useState<ExternalCustomerReferenceDto[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [sourceNamespace, setSourceNamespace] = useState<string>('');
  const [externalKey, setExternalKey] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [actionError, setActionError] = useState<AppErrorInfo | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<MutationSnapshot | null>(null);

  const fetchReferences = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/customers/${customer.id}/external-references`);
      if (!res.ok) return;
      const json = (await res.json()) as ApiResponse<ExternalCustomerReferenceDto[]>;
      if (json.success && json.data) {
        setReferences([...json.data]);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [customer.id]);

  useEffect(() => {
    void fetchReferences();
    setActionError(null);
    setRetryAttempt(null);
    setSourceNamespace('');
    setExternalKey('');
  }, [customer.id, fetchReferences]);

  const executeCreateMutation = async (snapshot: MutationSnapshot) => {
    setSubmitting(true);
    setActionError(null);
    try {
      const csrfToken = await getCsrfToken();
      const res = await fetch(snapshot.url, {
        method: 'POST',
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

      const json = (await res.json()) as ApiResponse<ExternalCustomerReferenceDto>;
      if (json.success) {
        setRetryAttempt(null);
        setActionError(null);
        setSourceNamespace('');
        setExternalKey('');
        await fetchReferences();
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

  const handleAddReference = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!sourceNamespace.trim() || !externalKey.trim()) {
      setActionError({
        message: 'Girdi doğrulama hatası: Kaynak sistem ve harici anahtar zorunludur.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }

    const snapshot: MutationSnapshot = {
      url: `/api/customers/${customer.id}/external-references`,
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        expectedVersion: customer.version,
        sourceNamespace: sourceNamespace.trim(),
        externalKey: externalKey.trim(),
      }),
    };
    void executeCreateMutation(snapshot);
  };

  const handleRetry = () => {
    if (retryAttempt) {
      void executeCreateMutation(retryAttempt);
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
        style={{ fontWeight: 600, fontSize: '0.875rem', color: '#1e293b', marginBottom: '0.75rem' }}
      >
        Harici Müşteri Referansları
      </div>

      {loading ? (
        <div style={{ fontSize: '0.8125rem', color: '#64748b' }}>Referanslar yükleniyor...</div>
      ) : references.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.375rem',
            marginBottom: '0.75rem',
          }}
        >
          {references.map((ref) => (
            <div
              key={ref.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '0.4rem 0.6rem',
                backgroundColor: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '0.375rem',
                fontSize: '0.8125rem',
              }}
            >
              <span style={{ fontWeight: 600, color: '#1d4ed8' }}>{ref.sourceNamespace}</span>
              <span style={{ fontFamily: 'monospace', color: '#334155' }}>{ref.externalKey}</span>
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            fontSize: '0.8125rem',
            color: '#64748b',
            fontStyle: 'italic',
            marginBottom: '0.75rem',
          }}
        >
          Tanımlı harici referans bulunmuyor.
        </div>
      )}

      <form
        onSubmit={handleAddReference}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
      >
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            value={sourceNamespace}
            onChange={(e) => setSourceNamespace(e.target.value)}
            placeholder="Kaynak Sistem (Örn: POLIS_360)"
            disabled={submitting}
            style={{
              flex: 1,
              padding: '0.4rem 0.6rem',
              borderRadius: '0.375rem',
              border: '1px solid #cbd5e1',
              fontSize: '0.8125rem',
            }}
          />
          <input
            type="text"
            value={externalKey}
            onChange={(e) => setExternalKey(e.target.value)}
            placeholder="Harici Anahtar (Örn: M-12345)"
            disabled={submitting}
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
              cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? 'Kaydediliyor...' : 'Referans Ekle'}
          </button>
        </div>

        {actionError && (
          <div style={{ color: '#dc2626', fontSize: '0.8125rem', marginTop: '0.25rem' }}>
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
  );
};
