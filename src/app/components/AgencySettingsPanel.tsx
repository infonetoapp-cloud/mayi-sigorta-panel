import React, { useState, useEffect, useCallback, useId } from 'react';
import type { AgencySettingsDto, SelectableCatalogsDto, ApiResponse } from '../../shared/types';
import { parseAppError, getCsrfToken, type AppErrorInfo } from '../App';

interface MutationSnapshot {
  readonly url: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const AgencySettingsPanel: React.FC = () => {
  const formId = useId();
  const [invalidField, setInvalidField] = useState<'days' | 'timezone' | null>(null);
  const [settings, setSettings] = useState<AgencySettingsDto | null>(null);
  const [selectable, setSelectable] = useState<SelectableCatalogsDto | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<AppErrorInfo | null>(null);

  // Form alanları
  const [defaultInsurerId, setDefaultInsurerId] = useState<string>('');
  const [timezone, setTimezone] = useState<string>('Europe/Istanbul');
  const [renewalWindowDays, setRenewalWindowDays] = useState<string>('30');

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [mutationError, setMutationError] = useState<AppErrorInfo | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<MutationSnapshot | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const [settingsRes, selectableRes] = await Promise.all([
        fetch('/api/agency/settings'),
        fetch('/api/catalogs/selectable'),
      ]);

      if (!settingsRes.ok) {
        let errPayload: { error?: { code?: string; message?: string } } | null = null;
        try {
          errPayload = await settingsRes.json();
        } catch {
          // ignore
        }
        setFetchError(parseAppError(settingsRes.status, errPayload?.error));
        return;
      }

      const settingsJson = (await settingsRes.json()) as ApiResponse<AgencySettingsDto>;
      if (settingsJson.success && settingsJson.data) {
        setSettings(settingsJson.data);
        setDefaultInsurerId(settingsJson.data.defaultInsurerId || '');
        setTimezone(settingsJson.data.timezone || 'Europe/Istanbul');
        setRenewalWindowDays(String(settingsJson.data.renewalWindowDays ?? 30));
      } else {
        setFetchError(
          parseAppError(
            settingsRes.status,
            settingsJson.success === false ? settingsJson.error : null,
          ),
        );
      }

      if (selectableRes.ok) {
        const selectableJson = (await selectableRes.json()) as ApiResponse<SelectableCatalogsDto>;
        if (selectableJson.success && selectableJson.data) {
          setSelectable(selectableJson.data);
        }
      }
    } catch (err) {
      setFetchError(parseAppError(undefined, undefined, err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const executeSettingsMutation = async (snapshot: MutationSnapshot) => {
    setSubmitting(true);
    setMutationError(null);
    setSuccessMessage(null);
    try {
      const csrfToken = await getCsrfToken();
      const res = await fetch(snapshot.url, {
        method: 'PATCH',
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
        setMutationError(appErr);
        if (appErr.isRetryable) {
          setRetryAttempt(snapshot);
        } else {
          setRetryAttempt(null);
        }
        return;
      }

      const json = (await res.json()) as ApiResponse<AgencySettingsDto>;
      if (json.success && json.data) {
        setSettings(json.data);
        setDefaultInsurerId(json.data.defaultInsurerId || '');
        setTimezone(json.data.timezone);
        setRenewalWindowDays(String(json.data.renewalWindowDays));
        setRetryAttempt(null);
        setMutationError(null);
        setSuccessMessage('Acente ayarları başarıyla kaydedildi.');
      } else {
        const appErr = parseAppError(res.status, json.success === false ? json.error : null);
        setMutationError(appErr);
        if (appErr.isRetryable) {
          setRetryAttempt(snapshot);
        } else {
          setRetryAttempt(null);
        }
      }
    } catch (err) {
      const appErr = parseAppError(undefined, undefined, err);
      setMutationError(appErr);
      setRetryAttempt(snapshot);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSave = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!settings) return;
    setInvalidField(null);

    const days = parseInt(renewalWindowDays, 10);
    if (isNaN(days) || days < 1 || days > 120) {
      setInvalidField('days');
      setMutationError({
        message: 'Girdi doğrulama hatası: Yenileme penceresi en az 1, en fazla 120 gün olabilir.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }

    if (!timezone.trim() || !isValidIanaTimezone(timezone.trim())) {
      setInvalidField('timezone');
      setMutationError({
        message:
          'Girdi doğrulama hatası: Geçerli bir IANA zaman dilimi girilmelidir (Örn: Europe/Istanbul).',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }

    const snapshot: MutationSnapshot = {
      url: '/api/agency/settings',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        expectedVersion: settings.version,
        defaultInsurerId: defaultInsurerId.trim() ? defaultInsurerId.trim() : null,
        timezone: timezone.trim(),
        renewalWindowDays: days,
      }),
    };
    void executeSettingsMutation(snapshot);
  };

  const handleRetry = () => {
    if (retryAttempt) {
      void executeSettingsMutation(retryAttempt);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
        Acente ayarları yükleniyor...
      </div>
    );
  }

  if (fetchError) {
    return (
      <div
        style={{
          color: '#dc2626',
          padding: '1rem',
          backgroundColor: '#fee2e2',
          borderRadius: '0.375rem',
        }}
      >
        {fetchError.message}
      </div>
    );
  }

  return (
    <div
      style={{
        maxWidth: '40rem',
        backgroundColor: '#ffffff',
        borderRadius: '0.5rem',
        border: '1px solid #e2e8f0',
        padding: '1.5rem',
        boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
      }}
    >
      <h2
        style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.5rem 0', color: '#0f172a' }}
      >
        Acente Operasyonel Ayarları
      </h2>
      <p style={{ color: '#64748b', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
        Acentenin varsayılan sigortacı ataması, zaman dilimi ve yenileme takip gün penceresi.
      </p>

      {successMessage && (
        <div
          style={{
            color: '#047857',
            padding: '0.75rem',
            backgroundColor: '#ecfdf5',
            borderRadius: '0.375rem',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            fontWeight: 500,
          }}
        >
          {successMessage}
        </div>
      )}

      {mutationError && (
        <div
          id={`${formId}-error`}
          role="alert"
          style={{
            color: '#dc2626',
            padding: '0.75rem',
            backgroundColor: '#fee2e2',
            borderRadius: '0.375rem',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{mutationError.message}</span>
          {mutationError.isRetryable && (
            <button
              type="button"
              onClick={handleRetry}
              style={{
                backgroundColor: '#2563eb',
                color: '#ffffff',
                border: 'none',
                borderRadius: '0.25rem',
                padding: '0.25rem 0.5rem',
                fontSize: '0.75rem',
                cursor: 'pointer',
              }}
            >
              Tekrar Dene
            </button>
          )}
        </div>
      )}

      <form
        noValidate
        onSubmit={handleSave}
        style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}
      >
        <div>
          <label
            style={{
              display: 'block',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#334155',
              marginBottom: '0.375rem',
            }}
            htmlFor={`${formId}-insurer`}
          >
            Varsayılan Sigorta Şirketi
          </label>
          <select
            id={`${formId}-insurer`}
            value={defaultInsurerId}
            onChange={(e) => setDefaultInsurerId(e.target.value)}
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              borderRadius: '0.375rem',
              border: '1px solid #cbd5e1',
              fontSize: '0.875rem',
            }}
          >
            <option value="">Seçilmedi (Yok)</option>
            {selectable?.insurers.map((ins) => (
              <option key={ins.id} value={ins.id}>
                {ins.name} ({ins.code})
              </option>
            ))}
          </select>
          <p style={{ fontSize: '0.75rem', color: '#64748b', margin: '0.25rem 0 0 0' }}>
            Yalnızca aktif sigorta şirketleri seçilebilir.
          </p>
        </div>

        <div>
          <label
            style={{
              display: 'block',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#334155',
              marginBottom: '0.375rem',
            }}
            htmlFor={`${formId}-timezone`}
          >
            Operasyonel Zaman Dilimi (IANA)
          </label>
          <input
            type="text"
            id={`${formId}-timezone`}
            required
            aria-invalid={invalidField === 'timezone'}
            aria-describedby={invalidField === 'timezone' ? `${formId}-error` : undefined}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Europe/Istanbul"
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              borderRadius: '0.375rem',
              border: '1px solid #cbd5e1',
              fontSize: '0.875rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div>
          <label
            style={{
              display: 'block',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#334155',
              marginBottom: '0.375rem',
            }}
            htmlFor={`${formId}-days`}
          >
            Yenileme Bildirim Penceresi (Gün: 1 - 120)
          </label>
          <input
            type="number"
            id={`${formId}-days`}
            required
            aria-invalid={invalidField === 'days'}
            aria-describedby={invalidField === 'days' ? `${formId}-error` : undefined}
            min={1}
            max={120}
            value={renewalWindowDays}
            onChange={(e) => setRenewalWindowDays(e.target.value)}
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              borderRadius: '0.375rem',
              border: '1px solid #cbd5e1',
              fontSize: '0.875rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: '0.5rem',
          }}
        >
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Versiyon: v{settings?.version}
          </span>
          <button
            type="submit"
            disabled={submitting}
            style={{
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '0.375rem',
              padding: '0.5rem 1.25rem',
              fontWeight: 600,
              fontSize: '0.875rem',
              cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? 'Kaydediliyor...' : 'Ayarları Kaydet'}
          </button>
        </div>
      </form>
    </div>
  );
};
