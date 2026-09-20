import React, { useState } from 'react';
import type { CustomerDto, ApiResponse } from '../../shared/types';
import { parseAppError, getCsrfToken, type AppErrorInfo } from '../App';

interface SensitiveSearchPanelProps {
  readonly onSelectCustomer: (customerId: string) => void;
  readonly onClose: () => void;
}

export const SensitiveSearchPanel: React.FC<SensitiveSearchPanelProps> = ({
  onSelectCustomer,
  onClose,
}) => {
  const [identityType, setIdentityType] = useState<'TCKN' | 'VKN'>('TCKN');
  const [identityValue, setIdentityValue] = useState<string>('');
  const [results, setResults] = useState<CustomerDto[] | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<AppErrorInfo | null>(null);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!identityValue.trim()) {
      setError({
        message: 'Girdi doğrulama hatası: Arama için kimlik numarası girilmelidir.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const csrfToken = await getCsrfToken();
      // GÜVENLİK KONTROLÜ: Hassas kimlik aramasında ASLA URL parametresi kullanılmaz!
      // Yalnızca POST istek gövdesi ile sunucuya iletilir.
      const res = await fetch('/api/customers/search-sensitive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          identityType,
          identityValue: identityValue.trim(),
        }),
      });

      if (!res.ok) {
        let errPayload: { error?: { code?: string; message?: string } } | null = null;
        try {
          errPayload = await res.json();
        } catch {
          // ignore
        }
        setError(parseAppError(res.status, errPayload?.error));
        setResults([]);
        return;
      }

      const json = (await res.json()) as ApiResponse<CustomerDto[]>;
      if (json.success && json.data) {
        setResults([...json.data]);
      } else {
        setError(parseAppError(res.status, json.success === false ? json.error : null));
        setResults([]);
      }
    } catch (err) {
      setError(parseAppError(undefined, undefined, err));
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setIdentityValue('');
    setResults(null);
    setError(null);
  };

  return (
    <div
      style={{
        backgroundColor: '#ffffff',
        border: '1px solid #cbd5e1',
        borderRadius: '0.5rem',
        padding: '1.25rem',
        marginBottom: '1.5rem',
        boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.75rem',
        }}
      >
        <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, color: '#0f172a' }}>
          Hassas Kimlik ile Arama (TCKN / VKN)
        </h3>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            fontSize: '1.25rem',
            lineHeight: 1,
            cursor: 'pointer',
            color: '#64748b',
          }}
        >
          ×
        </button>
      </div>

      <p style={{ fontSize: '0.8125rem', color: '#64748b', margin: '0 0 1rem 0' }}>
        Doğrudan kimlik numarasıyla güvenli tam eşleşme araması yapar. Arama değeri URL adresine
        yazılmaz.
      </p>

      <form
        onSubmit={handleSearch}
        style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
      >
        <select
          value={identityType}
          onChange={(e) => setIdentityType(e.target.value as 'TCKN' | 'VKN')}
          style={{
            padding: '0.5rem 0.75rem',
            borderRadius: '0.375rem',
            border: '1px solid #cbd5e1',
            fontSize: '0.875rem',
          }}
        >
          <option value="TCKN">TCKN (11 Hane)</option>
          <option value="VKN">VKN (10 Hane)</option>
        </select>

        <input
          type="text"
          value={identityValue}
          onChange={(e) => setIdentityValue(e.target.value)}
          placeholder="TCKN veya VKN ile tam eşleşme ara..."
          maxLength={identityType === 'TCKN' ? 11 : 10}
          style={{
            flex: 1,
            minWidth: '14rem',
            padding: '0.5rem 0.75rem',
            borderRadius: '0.375rem',
            border: '1px solid #cbd5e1',
            fontSize: '0.875rem',
          }}
        />

        <button
          type="submit"
          disabled={loading}
          style={{
            backgroundColor: '#2563eb',
            color: '#ffffff',
            border: 'none',
            borderRadius: '0.375rem',
            padding: '0.5rem 1rem',
            fontWeight: 600,
            fontSize: '0.875rem',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? 'Aranıyor...' : 'Hassas Ara'}
        </button>

        <button
          type="button"
          onClick={handleClear}
          style={{
            backgroundColor: '#f1f5f9',
            color: '#475569',
            border: '1px solid #cbd5e1',
            borderRadius: '0.375rem',
            padding: '0.5rem 1rem',
            fontWeight: 600,
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          Aramayı Temizle
        </button>
      </form>

      {error && (
        <div style={{ color: '#dc2626', fontSize: '0.8125rem', marginTop: '0.75rem' }}>
          {error.message}
        </div>
      )}

      {results !== null && (
        <div style={{ marginTop: '1rem', borderTop: '1px solid #e2e8f0', paddingTop: '0.75rem' }}>
          <div
            style={{
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#334155',
              marginBottom: '0.5rem',
            }}
          >
            Arama Sonuçları ({results.length})
          </div>
          {results.length === 0 ? (
            <div style={{ fontSize: '0.8125rem', color: '#64748b', fontStyle: 'italic' }}>
              Eşleşen müşteri kaydı bulunamadı.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {results.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.625rem 0.875rem',
                    backgroundColor: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: '0.375rem',
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600, color: '#0f172a', marginRight: '0.5rem' }}>
                      {c.displayName}
                    </span>
                    <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      ({c.type} • {c.identityMasked || 'Maskeli Kimlik'})
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onSelectCustomer(c.id)}
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
                    Detay & Yetkililer
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
