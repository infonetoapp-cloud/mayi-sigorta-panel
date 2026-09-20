import React, { useState, useEffect, useCallback } from 'react';
import type { SelectableCatalogsDto, ApiResponse } from '../../shared/types';
import { parseAppError, getCsrfToken, type AppErrorInfo } from '../App';

type CatalogType = 'insurers' | 'branches' | 'products' | 'payment-methods' | 'loss-reasons';

interface GenericCatalogItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
  readonly insurerId?: string;
  readonly branchId?: string;
}

interface MutationSnapshot {
  readonly url: string;
  readonly method: 'POST' | 'PATCH';
  readonly body: string;
  readonly idempotencyKey: string;
}

export const CatalogsPanel: React.FC = () => {
  const [activeCatalog, setActiveCatalog] = useState<CatalogType>('insurers');
  const [includeInactive, setIncludeInactive] = useState<boolean>(false);
  const [items, setItems] = useState<GenericCatalogItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<AppErrorInfo | null>(null);

  // Selectable listeler (özellikle ürün oluşturma için)
  const [selectable, setSelectable] = useState<SelectableCatalogsDto | null>(null);

  // Modal durumları
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [createCode, setCreateCode] = useState<string>('');
  const [createName, setCreateName] = useState<string>('');
  const [createInsurerId, setCreateInsurerId] = useState<string>('');
  const [createBranchId, setCreateBranchId] = useState<string>('');

  const [editingItem, setEditingItem] = useState<GenericCatalogItem | null>(null);
  const [editName, setEditName] = useState<string>('');
  const [editBranchId, setEditBranchId] = useState<string>('');

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [mutationError, setMutationError] = useState<AppErrorInfo | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<MutationSnapshot | null>(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/catalogs/${activeCatalog}${includeInactive ? '?include_inactive=true' : ''}`;
      const res = await fetch(url);
      if (!res.ok) {
        let errPayload: { error?: { code?: string; message?: string } } | null = null;
        try {
          errPayload = await res.json();
        } catch {
          // ignore
        }
        setError(parseAppError(res.status, errPayload?.error));
        setItems([]);
        return;
      }
      const json = (await res.json()) as ApiResponse<GenericCatalogItem[]>;
      if (json.success && json.data) {
        setItems([...json.data]);
      } else {
        setError(parseAppError(res.status, json.success === false ? json.error : null));
        setItems([]);
      }
    } catch (err) {
      setError(parseAppError(undefined, undefined, err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [activeCatalog, includeInactive]);

  const fetchSelectable = useCallback(async () => {
    try {
      const res = await fetch('/api/catalogs/selectable');
      if (!res.ok) return;
      const json = (await res.json()) as ApiResponse<SelectableCatalogsDto>;
      if (json.success && json.data) {
        setSelectable(json.data);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    if (activeCatalog === 'products' || showCreateModal) {
      void fetchSelectable();
    }
  }, [activeCatalog, showCreateModal, fetchSelectable]);

  const executeMutation = async (snapshot: MutationSnapshot, isDeactivate = false) => {
    setSubmitting(true);
    setMutationError(null);
    try {
      const csrfToken = await getCsrfToken();
      const res = await fetch(snapshot.url, {
        method: snapshot.method,
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

      const json = (await res.json()) as ApiResponse<unknown>;
      if (json.success) {
        setRetryAttempt(null);
        setMutationError(null);
        if (!isDeactivate) {
          setShowCreateModal(false);
          setEditingItem(null);
        }
        await fetchItems();
      } else {
        const appErr = parseAppError(res.status, json.error);
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

  const handleCreate = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!createCode.trim() || !createName.trim()) {
      setMutationError({
        message: 'Girdi doğrulama hatası: Kod ve isim zorunludur.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }

    const payload: Record<string, unknown> = {
      code: createCode.trim(),
      name: createName.trim(),
    };

    if (activeCatalog === 'products') {
      if (!createInsurerId.trim() || !createBranchId.trim()) {
        setMutationError({
          message: 'Girdi doğrulama hatası: Sigortacı ve branş seçimi zorunludur.',
          isRetryable: false,
          category: 'VALIDATION',
        });
        return;
      }
      payload.insurerId = createInsurerId.trim();
      payload.branchId = createBranchId.trim();
    }

    const snapshot: MutationSnapshot = {
      url: `/api/catalogs/${activeCatalog}`,
      method: 'POST',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify(payload),
    };
    void executeMutation(snapshot);
  };

  const handleUpdate = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!editingItem) return;
    if (!editName.trim()) {
      setMutationError({
        message: 'Girdi doğrulama hatası: İsim zorunludur.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }

    const payload: Record<string, unknown> = {
      expectedVersion: editingItem.version,
      name: editName.trim(),
    };

    if (activeCatalog === 'products' && editBranchId) {
      payload.branchId = editBranchId;
    }

    const snapshot: MutationSnapshot = {
      url: `/api/catalogs/${activeCatalog}/${editingItem.id}`,
      method: 'PATCH',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify(payload),
    };
    void executeMutation(snapshot);
  };

  const handleDeactivate = (item: GenericCatalogItem) => {
    const snapshot: MutationSnapshot = {
      url: `/api/catalogs/${activeCatalog}/${item.id}/deactivate`,
      method: 'POST',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        expectedVersion: item.version,
      }),
    };
    void executeMutation(snapshot, true);
  };

  const handleRetry = () => {
    if (retryAttempt) {
      void executeMutation(retryAttempt);
    }
  };

  const getCatalogTitle = () => {
    switch (activeCatalog) {
      case 'insurers':
        return 'Sigorta Şirketleri';
      case 'branches':
        return 'Branşlar';
      case 'products':
        return 'Ürünler';
      case 'payment-methods':
        return 'Ödeme Yöntemleri';
      case 'loss-reasons':
        return 'Kayıp / İptal Nedenleri';
    }
  };

  const openCreateModal = () => {
    setCreateCode('');
    setCreateName('');
    if (selectable?.insurers && selectable.insurers.length > 0) {
      setCreateInsurerId(selectable.insurers[0]!.id);
    } else {
      setCreateInsurerId('');
    }
    if (selectable?.branches && selectable.branches.length > 0) {
      setCreateBranchId(selectable.branches[0]!.id);
    } else {
      setCreateBranchId('');
    }
    setMutationError(null);
    setRetryAttempt(null);
    setShowCreateModal(true);
  };

  const openEditModal = (item: GenericCatalogItem) => {
    setEditingItem(item);
    setEditName(item.name);
    setEditBranchId(item.branchId || '');
    setMutationError(null);
    setRetryAttempt(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Katalog Üst Menü */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          flexWrap: 'wrap',
          borderBottom: '1px solid #e2e8f0',
          paddingBottom: '0.75rem',
        }}
      >
        {(
          [
            ['insurers', 'Sigorta Şirketleri'],
            ['branches', 'Branşlar'],
            ['products', 'Ürünler'],
            ['payment-methods', 'Ödeme Yöntemleri'],
            ['loss-reasons', 'Kayıp Nedenleri'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setActiveCatalog(key);
              setMutationError(null);
              setRetryAttempt(null);
            }}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              border: 'none',
              backgroundColor: activeCatalog === key ? '#2563eb' : '#f1f5f9',
              color: activeCatalog === key ? '#ffffff' : '#475569',
              fontWeight: 600,
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Katalog Başlık & Eylemler */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, color: '#0f172a' }}>
            {getCatalogTitle()}
          </h2>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
              fontSize: '0.875rem',
              color: '#475569',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            İnaktifleri Göster
          </label>
        </div>

        <button
          type="button"
          onClick={openCreateModal}
          style={{
            backgroundColor: '#2563eb',
            color: '#ffffff',
            border: 'none',
            borderRadius: '0.375rem',
            padding: '0.5rem 1rem',
            fontWeight: 600,
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          + Yeni Ekle
        </button>
      </div>

      {error && (
        <div
          style={{
            color: '#dc2626',
            fontSize: '0.875rem',
            padding: '0.75rem',
            backgroundColor: '#fee2e2',
            borderRadius: '0.375rem',
          }}
        >
          {error.message}
        </div>
      )}

      {/* Global veya Deactivate Hata Gösterimi */}
      {mutationError && !showCreateModal && !editingItem && (
        <div
          style={{
            color: '#dc2626',
            fontSize: '0.875rem',
            padding: '0.75rem',
            backgroundColor: '#fee2e2',
            borderRadius: '0.375rem',
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
                padding: '0.25rem 0.625rem',
                fontSize: '0.75rem',
                cursor: 'pointer',
              }}
            >
              Tekrar Dene
            </button>
          )}
        </div>
      )}

      {/* Tablo */}
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '0.5rem',
          border: '1px solid #e2e8f0',
          overflowX: 'auto',
          boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
        }}
      >
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
            Katalog verileri yükleniyor...
          </div>
        ) : items.length === 0 ? (
          <div
            style={{ padding: '2rem', textAlign: 'center', color: '#64748b', fontStyle: 'italic' }}
          >
            Kayıt bulunamadı.
          </div>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              textAlign: 'left',
              fontSize: '0.875rem',
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: '2px solid #e2e8f0',
                  color: '#475569',
                  backgroundColor: '#f8fafc',
                }}
              >
                <th style={{ padding: '0.75rem 1rem' }}>Kod (Semantik)</th>
                <th style={{ padding: '0.75rem 1rem' }}>İsim</th>
                <th style={{ padding: '0.75rem 1rem' }}>Durum</th>
                <th style={{ padding: '0.75rem 1rem' }}>Versiyon</th>
                <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>İşlemler</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td
                    style={{
                      padding: '0.875rem 1rem',
                      fontFamily: 'monospace',
                      fontWeight: 600,
                      color: '#1e293b',
                    }}
                  >
                    {item.code}
                  </td>
                  <td style={{ padding: '0.875rem 1rem', color: '#0f172a' }}>{item.name}</td>
                  <td style={{ padding: '0.875rem 1rem' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '0.125rem 0.5rem',
                        borderRadius: '9999px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        backgroundColor: item.status === 'ACTIVE' ? '#ecfdf5' : '#f1f5f9',
                        color: item.status === 'ACTIVE' ? '#047857' : '#64748b',
                        border: `1px solid ${item.status === 'ACTIVE' ? '#a7f3d0' : '#cbd5e1'}`,
                      }}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td style={{ padding: '0.875rem 1rem', color: '#64748b' }}>v{item.version}</td>
                  <td style={{ padding: '0.875rem 1rem', textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: '0.5rem' }}>
                      <button
                        type="button"
                        onClick={() => openEditModal(item)}
                        style={{
                          backgroundColor: '#f8fafc',
                          color: '#1e293b',
                          border: '1px solid #cbd5e1',
                          borderRadius: '0.25rem',
                          padding: '0.25rem 0.625rem',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Düzenle
                      </button>
                      {item.status === 'ACTIVE' && (
                        <button
                          type="button"
                          onClick={() => handleDeactivate(item)}
                          style={{
                            backgroundColor: '#fee2e2',
                            color: '#991b1b',
                            border: '1px solid #fecaca',
                            borderRadius: '0.25rem',
                            padding: '0.25rem 0.625rem',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Pasifleştir
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Oluşturma Modalı */}
      {showCreateModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            padding: '1rem',
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              maxWidth: '30rem',
              width: '100%',
              padding: '1.5rem',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
            }}
          >
            <h3
              style={{
                fontSize: '1.125rem',
                fontWeight: 700,
                margin: '0 0 1rem 0',
                color: '#0f172a',
              }}
            >
              Yeni {getCatalogTitle()} Ekle
            </h3>

            <form
              noValidate
              onSubmit={handleCreate}
              style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            >
              {activeCatalog === 'products' && (
                <>
                  <div>
                    <label
                      style={{
                        display: 'block',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: '#334155',
                        marginBottom: '0.25rem',
                      }}
                    >
                      Sigorta Şirketi
                    </label>
                    <select
                      data-testid="product-insurer-select"
                      value={createInsurerId}
                      onChange={(e) => setCreateInsurerId(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #cbd5e1',
                        fontSize: '0.875rem',
                      }}
                    >
                      {selectable?.insurers.map((ins) => (
                        <option key={ins.id} value={ins.id}>
                          {ins.name} ({ins.code})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      style={{
                        display: 'block',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: '#334155',
                        marginBottom: '0.25rem',
                      }}
                    >
                      Sigorta Branşı
                    </label>
                    <select
                      data-testid="product-branch-select"
                      value={createBranchId}
                      onChange={(e) => setCreateBranchId(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #cbd5e1',
                        fontSize: '0.875rem',
                      }}
                    >
                      {selectable?.branches.map((br) => (
                        <option key={br.id} value={br.id}>
                          {br.name} ({br.code})
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    color: '#334155',
                    marginBottom: '0.25rem',
                  }}
                >
                  Kod (Semantik Değer - Değiştirilemez)
                </label>
                <input
                  type="text"
                  value={createCode}
                  onChange={(e) => setCreateCode(e.target.value.toUpperCase())}
                  placeholder="Kod (Örn: AKSIGORTA)"
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
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    color: '#334155',
                    marginBottom: '0.25rem',
                  }}
                >
                  İsim / Tanım
                </label>
                <input
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="İsim (Örn: Aksigorta)"
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

              {mutationError && (
                <div style={{ color: '#dc2626', fontSize: '0.8125rem' }}>
                  {mutationError.message}
                  {mutationError.isRetryable && (
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

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '0.5rem',
                  marginTop: '0.5rem',
                }}
              >
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  style={{
                    backgroundColor: '#f1f5f9',
                    color: '#334155',
                    border: '1px solid #cbd5e1',
                    borderRadius: '0.375rem',
                    padding: '0.5rem 1rem',
                    fontWeight: 600,
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                  }}
                >
                  Vazgeç
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  style={{
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '0.375rem',
                    padding: '0.5rem 1rem',
                    fontWeight: 600,
                    fontSize: '0.875rem',
                    cursor: submitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {submitting ? 'Kaydediliyor...' : 'Kaydet'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Güncelleme Modalı */}
      {editingItem && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            padding: '1rem',
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              maxWidth: '30rem',
              width: '100%',
              padding: '1.5rem',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
            }}
          >
            <h3
              style={{
                fontSize: '1.125rem',
                fontWeight: 700,
                margin: '0 0 1rem 0',
                color: '#0f172a',
              }}
            >
              {editingItem.name} Düzenle
            </h3>

            <form
              noValidate
              onSubmit={handleUpdate}
              style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            >
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    color: '#334155',
                    marginBottom: '0.25rem',
                  }}
                >
                  Kod (Değiştirilemez)
                </label>
                <input
                  type="text"
                  value={editingItem.code}
                  readOnly
                  disabled
                  style={{
                    width: '100%',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #e2e8f0',
                    backgroundColor: '#f1f5f9',
                    color: '#64748b',
                    fontSize: '0.875rem',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    color: '#334155',
                    marginBottom: '0.25rem',
                  }}
                >
                  İsim / Tanım
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
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

              {activeCatalog === 'products' && (
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      color: '#334155',
                      marginBottom: '0.25rem',
                    }}
                  >
                    Sigorta Branşı
                  </label>
                  <select
                    value={editBranchId}
                    onChange={(e) => setEditBranchId(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.875rem',
                    }}
                  >
                    {selectable?.branches.map((br) => (
                      <option key={br.id} value={br.id}>
                        {br.name} ({br.code})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {mutationError && (
                <div style={{ color: '#dc2626', fontSize: '0.8125rem' }}>
                  {mutationError.message}
                  {mutationError.isRetryable && (
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

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '0.5rem',
                  marginTop: '0.5rem',
                }}
              >
                <button
                  type="button"
                  onClick={() => setEditingItem(null)}
                  style={{
                    backgroundColor: '#f1f5f9',
                    color: '#334155',
                    border: '1px solid #cbd5e1',
                    borderRadius: '0.375rem',
                    padding: '0.5rem 1rem',
                    fontWeight: 600,
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                  }}
                >
                  Vazgeç
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  style={{
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '0.375rem',
                    padding: '0.5rem 1rem',
                    fontWeight: 600,
                    fontSize: '0.875rem',
                    cursor: submitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {submitting ? 'Güncelleniyor...' : 'Güncelle'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
