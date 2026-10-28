import React, { useState, useEffect } from 'react';
import type {
  CustomerDetailDto,
  ApiResponse,
  CustomerAssignmentOptionDto,
} from '../../shared/types';
import { parseAppError, getCsrfToken, type AppErrorInfo } from '../App';
import { useLegacyCustomerRisk } from './LegacyCustomerBoundary';

interface MutationSnapshot {
  readonly url: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

interface CustomerAssignmentSectionProps {
  readonly customer: CustomerDetailDto;
  readonly onCustomerReload: () => Promise<void>;
}

export const CustomerAssignmentSection: React.FC<CustomerAssignmentSectionProps> = ({
  customer,
  onCustomerReload,
}) => {
  const [options, setOptions] = useState<CustomerAssignmentOptionDto[]>([]);
  const [optionsError, setOptionsError] = useState<AppErrorInfo | null>(null);
  const [selectedAssignee, setSelectedAssignee] = useState<string>(customer.assigneeMembershipId);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [actionError, setActionError] = useState<AppErrorInfo | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<MutationSnapshot | null>(null);
  useLegacyCustomerRisk(
    selectedAssignee !== customer.assigneeMembershipId,
    submitting || retryAttempt !== null,
  );

  useEffect(() => {
    setSelectedAssignee(customer.assigneeMembershipId);
    setActionError(null);
    setRetryAttempt(null);
  }, [customer.id, customer.assigneeMembershipId]);

  useEffect(() => {
    let isMounted = true;
    const fetchOptions = async () => {
      try {
        const res = await fetch(`/api/customers/${customer.id}/assignment-options`);
        const json = (await res.json()) as ApiResponse<CustomerAssignmentOptionDto[]>;
        if (!res.ok || !json.success) {
          if (isMounted) {
            setOptionsError(parseAppError(res.status, json.success === false ? json.error : null));
          }
          return;
        }
        if (isMounted) {
          setOptions([...json.data]);
          setOptionsError(null);
        }
      } catch (err) {
        if (isMounted) setOptionsError(parseAppError(undefined, undefined, err));
      }
    };
    void fetchOptions();
    return () => {
      isMounted = false;
    };
  }, [customer.id]);

  const executeAssignMutation = async (snapshot: MutationSnapshot) => {
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

      const json = (await res.json()) as ApiResponse<CustomerDetailDto>;
      if (json.success) {
        setRetryAttempt(null);
        setActionError(null);
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

  const handleAssign = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedAssignee.trim()) {
      setActionError({
        message: 'Girdi doğrulama hatası: Temsilci seçilmelidir.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }

    const snapshot: MutationSnapshot = {
      url: `/api/customers/${customer.id}/assign`,
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        expectedVersion: customer.version,
        assigneeMembershipId: selectedAssignee.trim(),
      }),
    };
    void executeAssignMutation(snapshot);
  };

  const handleRetry = () => {
    if (retryAttempt) {
      void executeAssignMutation(retryAttempt);
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
        style={{ fontWeight: 600, fontSize: '0.875rem', color: '#1e293b', marginBottom: '0.5rem' }}
      >
        Müşteri Sorumlusu Atama
      </div>
      <form
        onSubmit={handleAssign}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
      >
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <select
            aria-label="Müşteri sorumlusu"
            data-testid="assignee-select"
            value={selectedAssignee}
            onChange={(e) => setSelectedAssignee(e.target.value)}
            disabled={submitting}
            style={{
              flex: 1,
              padding: '0.4rem 0.6rem',
              borderRadius: '0.375rem',
              border: '1px solid #cbd5e1',
              fontSize: '0.8125rem',
            }}
          >
            {options.map((option) => (
              <option key={option.membershipId} value={option.membershipId}>
                {option.label} ({option.membershipType === 'OWNER' ? 'Acente sahibi' : 'Çalışan'})
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={submitting || selectedAssignee === customer.assigneeMembershipId}
            style={{
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '0.375rem',
              padding: '0.4rem 0.75rem',
              fontSize: '0.8125rem',
              fontWeight: 600,
              cursor:
                submitting || selectedAssignee === customer.assigneeMembershipId
                  ? 'not-allowed'
                  : 'pointer',
              opacity: selectedAssignee === customer.assigneeMembershipId ? 0.6 : 1,
            }}
          >
            {submitting ? 'Atanıyor...' : 'Sorumluyu Ata'}
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
        {optionsError && (
          <div style={{ color: '#dc2626', fontSize: '0.8125rem', marginTop: '0.25rem' }}>
            {optionsError.message}
          </div>
        )}
      </form>
    </div>
  );
};
