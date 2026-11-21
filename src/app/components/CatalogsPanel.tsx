import { CatalogPaymentFields } from './CatalogPaymentFields';
import { Button } from './ui/button';
import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import type { SelectableCatalogsDto, ApiResponse } from '../../shared/types';
import { BRANCH_CLASSIFICATION_CORRECTION_REASONS } from '../../shared/constants';
import { parseAppError, getCsrfToken, type AppErrorInfo } from '../App';

type CatalogType = 'insurers' | 'branches' | 'products' | 'payment-methods' | 'loss-reasons';
const CORRECTION_REASON_LABELS: Record<
  (typeof BRANCH_CLASSIFICATION_CORRECTION_REASONS)[number],
  string
> = {
  WRONG_INITIAL_CLASSIFICATION: 'İlk kayıtta yanlış sınıf seçildi',
  LEGACY_IMPORT_CLASSIFICATION: 'Eski veri aktarımında yanlış sınıf geldi',
};

interface GenericCatalogItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
  readonly insurerId?: string;
  readonly branchId?: string;
  readonly supportsInstallments?: boolean;
  readonly maxInstallments?: number;
  readonly dataClassification?: 'GENERAL' | 'HEALTH';
  readonly canCorrectClassification?: boolean;
  readonly supportsVehicleDetails?: boolean;
}

interface MutationSnapshot {
  readonly url: string;
  readonly method: 'POST' | 'PATCH';
  readonly body: string;
  readonly idempotencyKey: string;
}

function CatalogDialog({
  heading,
  locked,
  onDismiss,
  children,
}: {
  heading: string;
  locked: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal?.();
    return () => {
      dialog?.close?.();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="catalog-dialog"
      open={typeof HTMLDialogElement.prototype.showModal !== 'function' ? true : undefined}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onDismiss();
      }}
    >
      {children}
    </dialog>
  );
}

export const CatalogsPanel: React.FC = () => {
  const formId = useId();
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
  const [correctionReason, setCorrectionReason] = useState<string | null>(null);

  const [vehicleDetails, setVehicleDetails] = useState(false);
  const [classification, setClassification] = useState<'' | 'GENERAL' | 'HEALTH'>('');
  const [installments, setInstallments] = useState(false);
  const [maximum, setMaximum] = useState('9');

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [mutationError, setMutationError] = useState<AppErrorInfo | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<MutationSnapshot | null>(null);

  const mutationLocked = submitting || retryAttempt !== null;

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

  const handleCreate = (e?: React.FormEvent<HTMLFormElement>) => {
    if (e) e.preventDefault();
    if (mutationLocked) return;
    if (!createCode.trim() || !createName.trim()) {
      e?.currentTarget
        .querySelector<HTMLElement>('input:invalid, select:invalid, textarea:invalid')
        ?.focus();
      setMutationError({
        message: 'Girdi doğrulama hatası: Kod ve isim zorunludur.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }

    if (e && !e.currentTarget.checkValidity()) {
      setMutationError({
        message: 'Zorunlu alanları ve taksit sınırını kontrol edin.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      e.currentTarget
        .querySelector<HTMLElement>('input:invalid, select:invalid, textarea:invalid')
        ?.focus();
      return;
    }

    const payload: Record<string, unknown> = {
      code: createCode.trim(),
      name: createName.trim(),
    };

    if (activeCatalog === 'branches') {
      payload.dataClassification = classification;
      payload.supportsVehicleDetails = vehicleDetails;
    }
    if (activeCatalog === 'payment-methods') {
      payload.supportsInstallments = installments;
      if (installments) payload.maxInstallments = Number(maximum);
    }

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

  const handleUpdate = (e?: React.FormEvent<HTMLFormElement>) => {
    if (e) e.preventDefault();
    if (mutationLocked) return;
    if (!editingItem) return;
    if (correctionReason !== null) {
      if (!correctionReason) {
        setMutationError({
          message: 'Düzeltme gerekçesini seçin.',
          isRetryable: false,
          category: 'VALIDATION',
        });
        e?.currentTarget.querySelector('select')?.focus();
        return;
      }
      void executeMutation({
        url: `/api/catalogs/branches/${encodeURIComponent(editingItem.id)}/correct-classification`,
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: editingItem.version,
          reasonCode: correctionReason,
        }),
        idempotencyKey: crypto.randomUUID(),
      });
      return;
    }
    if (!editName.trim()) {
      e?.currentTarget
        .querySelector<HTMLElement>('input:invalid, select:invalid, textarea:invalid')
        ?.focus();
      setMutationError({
        message: 'Girdi doğrulama hatası: İsim zorunludur.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      return;
    }

    if (e && !e.currentTarget.checkValidity()) {
      setMutationError({
        message: 'Zorunlu alanları ve taksit sınırını kontrol edin.',
        isRetryable: false,
        category: 'VALIDATION',
      });
      e.currentTarget
        .querySelector<HTMLElement>('input:invalid, select:invalid, textarea:invalid')
        ?.focus();
      return;
    }

    const payload: Record<string, unknown> = {
      expectedVersion: editingItem.version,
      name: editName.trim(),
    };

    if (
      activeCatalog === 'branches' &&
      vehicleDetails !== (editingItem.supportsVehicleDetails ?? false)
    )
      payload.supportsVehicleDetails = vehicleDetails;

    if (activeCatalog === 'payment-methods') {
      if (installments !== editingItem.supportsInstallments)
        payload.supportsInstallments = installments;
      if (installments && Number(maximum) !== editingItem.maxInstallments)
        payload.maxInstallments = Number(maximum);
    }

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
    if (mutationLocked) return;
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
    setClassification('');
    setVehicleDetails(false);
    setInstallments(false);
    setMaximum('9');
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
    setCorrectionReason(null);
    setEditName(item.name);
    setVehicleDetails(item.supportsVehicleDetails ?? false);
    setInstallments(item.supportsInstallments ?? false);
    setMaximum(String(item.maxInstallments ?? 12));
    setEditBranchId(item.branchId || '');
    setMutationError(null);
    setRetryAttempt(null);
  };

  const vehicleDetailsOption = (
    <div className="catalog-classification">
      <div className="flex items-center gap-2">
        <input
          id={`${formId}-vehicles`}
          name="supportsVehicleDetails"
          type="checkbox"
          checked={vehicleDetails}
          aria-describedby={`${formId}-vehicles-hint`}
          onChange={(event) => setVehicleDetails(event.target.checked)}
        />
        <label htmlFor={`${formId}-vehicles`}>Poliçede araç bilgisi kullanılabilir</label>
      </div>
      <p id={`${formId}-vehicles-hint`} className="catalog-hint">
        Kapatıldığında poliçedeki mevcut araç bilgileri geçmiş olarak görüntülenir.
      </p>
    </div>
  );

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
          <Button
            variant={activeCatalog === key ? 'default' : 'outline'}
            aria-pressed={activeCatalog === key}
            disabled={mutationLocked}
            key={key}
            type="button"
            onClick={() => {
              setActiveCatalog(key);
              setMutationError(null);
              setRetryAttempt(null);
            }}
          >
            {label}
          </Button>
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

        <Button variant="default" type="button" disabled={mutationLocked} onClick={openCreateModal}>
          + Yeni Ekle
        </Button>
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
            <Button variant="outline" type="button" disabled={submitting} onClick={handleRetry}>
              Tekrar Dene
            </Button>
          )}
        </div>
      )}

      {/* Tablo */}
      <div className="catalog-table" role="region" aria-label="Katalog kayıtları" tabIndex={0}>
        {loading ? (
          <div className="catalog-feedback" role="status">
            Katalog verileri yükleniyor…
          </div>
        ) : items.length === 0 ? (
          <div className="catalog-feedback">Kayıt bulunamadı.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Ad</th>
                <th scope="col">Kod</th>
                <th scope="col">Durum</th>
                <th scope="col">İşlemler</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <th scope="row">
                    {item.name}
                    {activeCatalog === 'payment-methods' && (
                      <small className="catalog-row-detail">
                        {item.supportsInstallments
                          ? `En fazla ${item.maxInstallments} taksit`
                          : 'Tek çekim / taksitsiz'}
                      </small>
                    )}
                    {activeCatalog === 'branches' && (
                      <small className="catalog-row-detail">
                        {item.dataClassification === 'HEALTH'
                          ? 'Sağlık sigortası'
                          : item.dataClassification === 'GENERAL'
                            ? 'Genel sigorta'
                            : 'Veri sınıfı kullanılamıyor'}
                      </small>
                    )}
                  </th>
                  <td data-label="Kod">{item.code}</td>
                  <td data-label="Durum">
                    <span className="catalog-state" data-active={item.status === 'ACTIVE'}>
                      {item.status === 'ACTIVE' ? 'Etkin' : 'Pasif'}
                    </span>
                  </td>
                  <td className="catalog-table-action">
                    <div className="catalog-actions">
                      <Button
                        variant="outline"
                        type="button"
                        disabled={mutationLocked}
                        onClick={() => openEditModal(item)}
                      >
                        Düzenle
                      </Button>
                      {item.status === 'ACTIVE' && (
                        <Button
                          variant="danger"
                          type="button"
                          disabled={mutationLocked}
                          onClick={() => handleDeactivate(item)}
                        >
                          Pasifleştir
                        </Button>
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
        <CatalogDialog
          heading={`${formId}-create-heading`}
          locked={mutationLocked}
          onDismiss={() => setShowCreateModal(false)}
        >
          <h3
            id={`${formId}-create-heading`}
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
            <fieldset className="catalog-fields" disabled={mutationLocked}>
              <legend className="sr-only">Yeni katalog bilgileri</legend>
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
                      htmlFor={`${formId}-create-insurer`}
                    >
                      Sigorta Şirketi
                    </label>
                    <select
                      data-testid="product-insurer-select"
                      id={`${formId}-create-insurer`}
                      required
                      aria-describedby={mutationError ? `${formId}-error` : undefined}
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
                      htmlFor={`${formId}-create-branch`}
                    >
                      Sigorta Branşı
                    </label>
                    <select
                      data-testid="product-branch-select"
                      id={`${formId}-create-branch`}
                      required
                      aria-describedby={mutationError ? `${formId}-error` : undefined}
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
                  htmlFor={`${formId}-create-code`}
                >
                  Kod (Semantik Değer - Değiştirilemez)
                </label>
                <input
                  type="text"
                  id={`${formId}-create-code`}
                  required
                  aria-invalid={mutationError?.category === 'VALIDATION' && !createCode.trim()}
                  aria-describedby={mutationError ? `${formId}-error` : undefined}
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
                  htmlFor={`${formId}-create-name`}
                >
                  İsim / Tanım
                </label>
                <input
                  type="text"
                  id={`${formId}-create-name`}
                  required
                  aria-invalid={mutationError?.category === 'VALIDATION' && !createName.trim()}
                  aria-describedby={mutationError ? `${formId}-error` : undefined}
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

              {activeCatalog === 'payment-methods' && (
                <CatalogPaymentFields
                  id={`${formId}-payment`}
                  enabled={installments}
                  maximum={maximum}
                  onEnabled={setInstallments}
                  onMaximum={setMaximum}
                />
              )}
              {activeCatalog === 'branches' && (
                <div className="catalog-classification">
                  <label htmlFor={`${formId}-classification`}>Branş veri sınıfı</label>
                  <select
                    id={`${formId}-classification`}
                    required
                    value={classification}
                    onChange={(event) =>
                      setClassification(event.target.value as typeof classification)
                    }
                  >
                    <option value="">Seçiniz</option>
                    <option value="GENERAL">Genel sigorta</option>
                    <option value="HEALTH">Sağlık sigortası</option>
                  </select>
                  <p className="catalog-hint">
                    Sağlık kayıtlarına yalnız sağlık verisi yetkisi olan çalışanlar erişir. Bu seçim
                    sonradan bu ekrandan değiştirilemez.
                  </p>
                </div>
              )}
              {activeCatalog === 'branches' && vehicleDetailsOption}
            </fieldset>

            {mutationError && (
              <div
                id={`${formId}-error`}
                role="alert"
                style={{ color: '#dc2626', fontSize: '0.8125rem' }}
              >
                {mutationError.message}
                {mutationError.isRetryable && (
                  <Button
                    variant="outline"
                    type="button"
                    disabled={submitting}
                    onClick={handleRetry}
                  >
                    Tekrar Dene
                  </Button>
                )}
              </div>
            )}

            <div className="catalog-dialog-actions">
              <Button
                variant="outline"
                type="button"
                disabled={mutationLocked}
                onClick={() => setShowCreateModal(false)}
              >
                Vazgeç
              </Button>
              <Button variant="default" type="submit" disabled={mutationLocked}>
                {submitting ? 'Kaydediliyor...' : 'Kaydet'}
              </Button>
            </div>
          </form>
        </CatalogDialog>
      )}

      {/* Güncelleme Modalı */}
      {editingItem && (
        <CatalogDialog
          heading={`${formId}-edit-heading`}
          locked={mutationLocked}
          onDismiss={() => setEditingItem(null)}
        >
          <h3
            style={{
              fontSize: '1.125rem',
              fontWeight: 700,
              margin: '0 0 1rem 0',
              color: '#0f172a',
            }}
            id={`${formId}-edit-heading`}
          >
            {correctionReason === null
              ? `${editingItem.name} Düzenle`
              : `${editingItem.name} · Veri sınıfını düzelt`}
          </h3>

          <form
            noValidate
            aria-labelledby={`${formId}-edit-heading`}
            onSubmit={handleUpdate}
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
          >
            {correctionReason !== null ? (
              <fieldset className="catalog-fields" disabled={mutationLocked}>
                <legend className="sr-only">Branş sınıfını düzelt</legend>
                <p className="catalog-hint">
                  Genel sigorta → Sağlık sigortası. Bu branşa bağlı işlemler sağlık veri izinlerine
                  tabi olur.
                </p>
                <div className="catalog-classification">
                  <label htmlFor={`${formId}-classification-reason`}>Düzeltme gerekçesi</label>
                  <select
                    id={`${formId}-classification-reason`}
                    name="reasonCode"
                    aria-describedby={mutationError ? `${formId}-error` : undefined}
                    aria-invalid={mutationError?.category === 'VALIDATION'}
                    value={correctionReason}
                    onChange={(event) => {
                      setCorrectionReason(event.target.value);
                      setMutationError(null);
                    }}
                    required
                  >
                    <option value="">Gerekçe seçin</option>
                    {BRANCH_CLASSIFICATION_CORRECTION_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {CORRECTION_REASON_LABELS[reason]}
                      </option>
                    ))}
                  </select>
                </div>
              </fieldset>
            ) : (
              <fieldset className="catalog-fields" disabled={mutationLocked}>
                <legend className="sr-only">Katalog bilgilerini düzenle</legend>
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      color: '#334155',
                      marginBottom: '0.25rem',
                    }}
                    htmlFor={`${formId}-edit-code`}
                  >
                    Kod (Değiştirilemez)
                  </label>
                  <input
                    type="text"
                    id={`${formId}-edit-code`}
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
                    htmlFor={`${formId}-edit-name`}
                  >
                    İsim / Tanım
                  </label>
                  <input
                    type="text"
                    id={`${formId}-edit-name`}
                    required
                    aria-invalid={mutationError?.category === 'VALIDATION' && !editName.trim()}
                    aria-describedby={mutationError ? `${formId}-error` : undefined}
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
                      htmlFor={`${formId}-edit-branch`}
                    >
                      Sigorta Branşı
                    </label>
                    <select
                      id={`${formId}-edit-branch`}
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

                {activeCatalog === 'payment-methods' && (
                  <CatalogPaymentFields
                    id={`${formId}-payment`}
                    enabled={installments}
                    maximum={maximum}
                    onEnabled={setInstallments}
                    onMaximum={setMaximum}
                  />
                )}
                {activeCatalog === 'branches' && (
                  <p className="catalog-hint">
                    Veri sınıfı:{' '}
                    {editingItem.dataClassification === 'HEALTH'
                      ? 'Sağlık sigortası'
                      : editingItem.dataClassification === 'GENERAL'
                        ? 'Genel sigorta'
                        : 'Bilgi kullanılamıyor'}
                    .
                  </p>
                )}
                {activeCatalog === 'branches' && editingItem.canCorrectClassification && (
                  <Button
                    type="button"
                    variant="outline"
                    className="self-start"
                    onClick={() => {
                      setCorrectionReason('');
                      setMutationError(null);
                    }}
                  >
                    Veri sınıfını düzelt
                  </Button>
                )}
                {activeCatalog === 'branches' && vehicleDetailsOption}
              </fieldset>
            )}

            {mutationError && (
              <div
                id={`${formId}-error`}
                role="alert"
                style={{ color: '#dc2626', fontSize: '0.8125rem' }}
              >
                {mutationError.message}
                {mutationError.isRetryable && (
                  <Button
                    variant="outline"
                    type="button"
                    disabled={submitting}
                    onClick={handleRetry}
                  >
                    Tekrar Dene
                  </Button>
                )}
              </div>
            )}

            <div className="catalog-dialog-actions">
              <Button
                variant="outline"
                type="button"
                disabled={mutationLocked}
                onClick={() => setEditingItem(null)}
              >
                Vazgeç
              </Button>
              <Button variant="default" type="submit" disabled={mutationLocked}>
                {submitting
                  ? 'Güncelleniyor...'
                  : correctionReason === null
                    ? 'Güncelle'
                    : 'Sağlık sigortası olarak kaydet'}
              </Button>
            </div>
          </form>
        </CatalogDialog>
      )}
    </div>
  );
};
