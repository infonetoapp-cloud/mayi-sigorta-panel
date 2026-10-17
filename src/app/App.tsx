import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getCsrfToken, invalidateCsrfToken } from './csrf';
export { getCsrfToken, invalidateCsrfToken } from './csrf';
import { APP_NAME } from '../shared/constants';
import type {
  CustomerDto,
  CustomerDetailDto,
  CompanyContactDto,
  CustomerType,
  CustomerListResponseData,
  ApiResponse,
} from '../shared/types';
import { CustomerIdentitySection } from './components/CustomerIdentitySection';
import { CustomerAssignmentSection } from './components/CustomerAssignmentSection';
import { CustomerContactSection } from './components/CustomerContactSection';
import { CustomerRenewalsSection } from './components/CustomerRenewalsSection';
import { CustomerNotesSection } from './components/CustomerNotesSection';
import { CustomerExternalReferencesSection } from './components/CustomerExternalReferencesSection';
import { SensitiveSearchPanel } from './components/SensitiveSearchPanel';
import { CatalogsPanel } from './components/CatalogsPanel';
import { AgencySettingsPanel } from './components/AgencySettingsPanel';
import { PolicyPanel } from './components/PolicyPanel';
import { CustomerArchiveSection } from './components/CustomerArchiveSection';
import { TodayWorkPanel } from './components/TodayWorkPanel';
import { DocumentSection } from './components/DocumentSection';

export type TabType =
  'today-work' | 'overview' | 'customers' | 'policies' | 'catalogs' | 'agency-settings';

const STYLES = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    backgroundColor: '#f8fafc',
    color: '#0f172a',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  header: {
    backgroundColor: '#ffffff',
    borderBottom: '1px solid #e2e8f0',
    padding: '0.875rem 2rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
  },
  headerTitle: {
    fontSize: '1.25rem',
    fontWeight: 700,
    letterSpacing: '-0.025em',
    color: '#0f172a',
    margin: 0,
  },
  headerNav: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  navButton: (active: boolean) => ({
    padding: '0.5rem 1rem',
    borderRadius: '0.375rem',
    border: 'none',
    backgroundColor: active ? '#2563eb' : 'transparent',
    color: active ? '#ffffff' : '#475569',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  }),
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.25rem 0.625rem',
    borderRadius: '9999px',
    backgroundColor: '#f1f5f9',
    border: '1px solid #cbd5e1',
    fontSize: '0.75rem',
    color: '#334155',
    fontWeight: 500,
  },
  main: {
    flex: 1,
    padding: '2rem',
    maxWidth: '80rem',
    width: '100%',
    margin: '0 auto',
    boxSizing: 'border-box' as const,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: '0.5rem',
    border: '1px solid #e2e8f0',
    boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
    padding: '1.5rem',
  },
  btnPrimary: {
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '0.375rem',
    padding: '0.5rem 1rem',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
  },
  btnSecondary: {
    backgroundColor: '#f1f5f9',
    color: '#334155',
    border: '1px solid #cbd5e1',
    borderRadius: '0.375rem',
    padding: '0.5rem 1rem',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
  },
  btnSmall: {
    backgroundColor: '#f8fafc',
    color: '#1e293b',
    border: '1px solid #cbd5e1',
    borderRadius: '0.25rem',
    padding: '0.25rem 0.625rem',
    fontSize: '0.75rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    textAlign: 'left' as const,
    fontSize: '0.875rem',
  },
  th: {
    padding: '0.75rem 1rem',
    borderBottom: '2px solid #e2e8f0',
    color: '#475569',
    fontWeight: 600,
  },
  td: {
    padding: '0.875rem 1rem',
    borderBottom: '1px solid #f1f5f9',
    color: '#1e293b',
  },
  badge: (type: 'INDIVIDUAL' | 'COMPANY' | 'ACTIVE' | 'INACTIVE' | 'PRIMARY') => {
    switch (type) {
      case 'INDIVIDUAL':
        return {
          backgroundColor: '#eff6ff',
          color: '#1d4ed8',
          border: '1px solid #bfdbfe',
          padding: '0.125rem 0.5rem',
          borderRadius: '9999px',
          fontSize: '0.75rem',
          fontWeight: 600,
        };
      case 'COMPANY':
        return {
          backgroundColor: '#f0fdf4',
          color: '#15803d',
          border: '1px solid #bbf7d0',
          padding: '0.125rem 0.5rem',
          borderRadius: '9999px',
          fontSize: '0.75rem',
          fontWeight: 600,
        };
      case 'PRIMARY':
        return {
          backgroundColor: '#fef3c7',
          color: '#b45309',
          border: '1px solid #fde68a',
          padding: '0.125rem 0.5rem',
          borderRadius: '9999px',
          fontSize: '0.75rem',
          fontWeight: 600,
        };
      case 'ACTIVE':
        return {
          backgroundColor: '#ecfdf5',
          color: '#047857',
          border: '1px solid #a7f3d0',
          padding: '0.125rem 0.5rem',
          borderRadius: '9999px',
          fontSize: '0.75rem',
          fontWeight: 600,
        };
      case 'INACTIVE':
        return {
          backgroundColor: '#f1f5f9',
          color: '#64748b',
          border: '1px solid #cbd5e1',
          padding: '0.125rem 0.5rem',
          borderRadius: '9999px',
          fontSize: '0.75rem',
          fontWeight: 600,
        };
    }
  },
  input: {
    width: '100%',
    padding: '0.5rem 0.75rem',
    borderRadius: '0.375rem',
    border: '1px solid #cbd5e1',
    fontSize: '0.875rem',
    boxSizing: 'border-box' as const,
  },
  modalBackdrop: {
    position: 'fixed' as const,
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
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderRadius: '0.75rem',
    maxWidth: '38rem',
    width: '100%',
    maxHeight: '90vh',
    overflowY: 'auto' as const,
    padding: '1.75rem',
    boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
  },
};

export interface AppErrorInfo {
  readonly message: string;
  readonly isRetryable: boolean;
  readonly category:
    'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'DUPLICATE' | 'VALIDATION' | 'SERVER_OR_NETWORK';
}

interface MutationRequestSnapshot {
  readonly url: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

interface ContactMutationAttempt {
  readonly kind: 'add' | 'set-primary' | 'deactivate';
  readonly request: MutationRequestSnapshot;
}

export function parseAppError(
  status: number | undefined,
  errorObj?: { code?: string; message?: string } | null,
  _rawError?: unknown,
): AppErrorInfo {
  if (status === undefined || status === 0) {
    return {
      message:
        'Sunucuya bağlanılamadı veya ağ bağlantısı hatası oluştu. Lütfen bağlantınızı kontrol ediniz.',
      isRetryable: true,
      category: 'SERVER_OR_NETWORK',
    };
  }

  if (status === 401) {
    invalidateCsrfToken();
    document.dispatchEvent(new Event('mayi-session-ended'));
    return {
      message: 'Oturum sona erdi. Yeniden giriş yapın.',
      isRetryable: false,
      category: 'FORBIDDEN',
    };
  }

  const csrfFailureCodes = new Set([
    'MISSING_CSRF_TOKEN',
    'MALFORMED_TOKEN',
    'INVALID_SIGNATURE',
    'SUBJECT_MISMATCH',
    'EXPIRED_TOKEN',
  ]);
  if (status === 403 && errorObj?.code && csrfFailureCodes.has(errorObj.code)) {
    invalidateCsrfToken();
    return {
      message:
        'Güvenlik oturumu yenilenmeli. Aynı işlemi güvenli biçimde yeniden denemek için Tekrar Dene seçeneğini kullanınız.',
      isRetryable: true,
      category: 'SERVER_OR_NETWORK',
    };
  }

  if (status === 403) {
    return {
      message: 'Bu işlem için yetkiniz bulunmamaktadır veya erişim reddedildi.',
      isRetryable: false,
      category: 'FORBIDDEN',
    };
  }

  if (status === 409) {
    if (errorObj?.code === 'DUPLICATE_EXTERNAL_REFERENCE') {
      return {
        message: 'Bu harici referans zaten mevcut.',
        isRetryable: false,
        category: 'DUPLICATE',
      };
    }
    return {
      message:
        'Veri başka bir işlem tarafından güncellenmiş veya işlem çakışması tespit edildi. Lütfen sayfayı yenileyip güncel durumu kontrol ediniz.',
      isRetryable: false,
      category: 'CONFLICT',
    };
  }

  if (status === 404) {
    return {
      message: 'Kayıt kullanılamıyor veya bu kaydı görme yetkiniz bulunmuyor.',
      isRetryable: false,
      category: 'NOT_FOUND',
    };
  }

  if (status >= 400 && status < 500) {
    return {
      message: 'Girdi doğrulama hatası: Geçersiz veya eksik veri sağlandı.',
      isRetryable: false,
      category: 'VALIDATION',
    };
  }

  return {
    message: 'Sunucuda geçici bir hata oluştu. Lütfen daha sonra tekrar deneyiniz.',
    isRetryable: true,
    category: 'SERVER_OR_NETWORK',
  };
}

export const App: React.FC<{ page?: TabType; onNavigate?: (page: TabType) => void }> = ({
  page,
  onNavigate,
}) => {
  const [localTab, setLocalTab] = useState<TabType>('overview');
  const activeTab = page ?? localTab;
  const setActiveTab = onNavigate ?? setLocalTab;
  const [showSensitiveSearch, setShowSensitiveSearch] = useState<boolean>(false);
  const [policyCustomer, setPolicyCustomer] = useState<{
    readonly id: string;
    readonly displayName: string;
  } | null>(null);

  // Müşteri listesi durumu
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<AppErrorInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'INDIVIDUAL' | 'COMPANY'>('ALL');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);

  // Müşteri oluşturma modalı durumu
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [createType, setCreateType] = useState<CustomerType>('INDIVIDUAL');
  const [createFirstName, setCreateFirstName] = useState<string>('');
  const [createLastName, setCreateLastName] = useState<string>('');
  const [createCompanyTitle, setCreateCompanyTitle] = useState<string>('');
  const [createEmail, setCreateEmail] = useState<string>('');
  const [createPhone, setCreatePhone] = useState<string>('');
  const [createAddress, setCreateAddress] = useState<string>('');
  const [createSubmitting, setCreateSubmitting] = useState<boolean>(false);
  const [createError, setCreateError] = useState<AppErrorInfo | null>(null);
  const [createRetryAttempt, setCreateRetryAttempt] = useState<MutationRequestSnapshot | null>(
    null,
  );

  // Müşteri detay modalı durumu
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<AppErrorInfo | null>(null);

  // Şirket yetkilisi ekleme ve işlem hatası durumu
  const [showAddContact, setShowAddContact] = useState<boolean>(false);
  const [contactFirstName, setContactFirstName] = useState<string>('');
  const [contactLastName, setContactLastName] = useState<string>('');
  const [contactRole, setContactRole] = useState<string>('');
  const [contactEmail, setContactEmail] = useState<string>('');
  const [contactPhone, setContactPhone] = useState<string>('');
  const [contactIsPrimary, setContactIsPrimary] = useState<boolean>(false);
  const [contactSubmitting, setContactSubmitting] = useState<boolean>(false);
  const [contactActionError, setContactActionError] = useState<AppErrorInfo | null>(null);
  const [contactRetryAttempt, setContactRetryAttempt] = useState<ContactMutationAttempt | null>(
    null,
  );

  // Müşterileri sunucudan yükleme
  const fetchCustomers = useCallback(
    async (cursor?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set('limit', '20');
        if (typeFilter !== 'ALL') {
          params.set('type', typeFilter);
        }
        if (searchQuery.trim().length > 0) {
          params.set('search', searchQuery.trim());
        }
        if (cursor) {
          params.set('cursor', cursor);
        }

        const res = await fetch(`/api/customers?${params.toString()}`);
        if (!res.ok) {
          let errPayload: { error?: { code?: string; message?: string } } | null = null;
          try {
            errPayload = await res.json();
          } catch {
            // ignore
          }
          setError(parseAppError(res.status, errPayload?.error));
          return;
        }
        const json = (await res.json()) as ApiResponse<CustomerListResponseData>;
        if (json.success) {
          if (cursor) {
            setCustomers((prev) => [...prev, ...json.data.items]);
          } else {
            setCustomers([...json.data.items]);
          }
          setNextCursor(json.data.nextCursor);
          setHasMore(json.data.hasMore);
          setError(null);
        } else {
          setError(parseAppError(res.status, json.error));
        }
      } catch (err) {
        setError(parseAppError(undefined, undefined, err));
      } finally {
        setLoading(false);
      }
    },
    [typeFilter, searchQuery],
  );

  useEffect(() => {
    if (activeTab === 'customers') {
      void fetchCustomers();
    }
  }, [activeTab, fetchCustomers]);

  // Müşteri Detayı Yükleme
  const customerDetailGeneration = useRef(0);
  // Route changes must not leave a customer/sensitive dialog over another page
  // or let a late detail response resurrect it. Preserve the policy hand-off.
  useEffect(() => {
    customerDetailGeneration.current++;
    setSelectedCustomerId(null);
    setSelectedCustomer(null);
    setShowSensitiveSearch(false);
    setShowCreateModal(false);
    setShowAddContact(false);
    setContactRetryAttempt(null);
    setContactActionError(null);
  }, [page]);
  const loadCustomerDetail = async (id: string) => {
    const generation = ++customerDetailGeneration.current;
    setSelectedCustomerId(id);
    setSelectedCustomer(null);
    setDetailLoading(true);
    setDetailError(null);
    setContactActionError(null);
    try {
      const res = await fetch(`/api/customers/${id}`);
      if (!res.ok) {
        let errPayload: { error?: { code?: string; message?: string } } | null = null;
        try {
          errPayload = await res.json();
        } catch {
          // ignore
        }
        if (generation !== customerDetailGeneration.current) return;
        setDetailError(parseAppError(res.status, errPayload?.error));
        return;
      }
      const json = (await res.json()) as ApiResponse<CustomerDetailDto>;
      if (generation !== customerDetailGeneration.current) return;
      if (json.success) {
        setSelectedCustomer(json.data);
        setDetailError(null);
      } else {
        setDetailError(parseAppError(res.status, json.error));
      }
    } catch (err) {
      if (generation === customerDetailGeneration.current)
        setDetailError(parseAppError(undefined, undefined, err));
    } finally {
      if (generation === customerDetailGeneration.current) setDetailLoading(false);
    }
  };

  const runCreateCustomerAttempt = async (attempt: MutationRequestSnapshot) => {
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const csrfToken = await getCsrfToken();
      const res = await fetch(attempt.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': attempt.idempotencyKey,
          'X-CSRF-Token': csrfToken,
        },
        body: attempt.body,
      });

      if (res.status === 403) invalidateCsrfToken();

      const json = (await res.json()) as ApiResponse<CustomerDto>;
      if (json.success) {
        setShowCreateModal(false);
        setCreateFirstName('');
        setCreateLastName('');
        setCreateCompanyTitle('');
        setCreateEmail('');
        setCreatePhone('');
        setCreateAddress('');
        setCreateError(null);
        setCreateRetryAttempt(null);
        void fetchCustomers();
      } else {
        const appError = parseAppError(res.status, json.error);
        setCreateError(appError);
        setCreateRetryAttempt(appError.isRetryable ? attempt : null);
      }
    } catch (err) {
      setCreateError(parseAppError(undefined, undefined, err));
      setCreateRetryAttempt(attempt);
    } finally {
      setCreateSubmitting(false);
    }
  };

  // Yeni Müşteri Oluşturma
  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setCreateRetryAttempt(null);

    const payload: Record<string, unknown> = {
      type: createType,
      email: createEmail.trim() || null,
      phone: createPhone.trim() || null,
      address: createAddress.trim() || null,
    };

    if (createType === 'INDIVIDUAL') {
      if (!createFirstName.trim() || !createLastName.trim()) {
        setCreateError(
          parseAppError(400, { message: 'Bireysel müşteride Ad ve Soyad zorunludur.' }),
        );
        return;
      }
      payload.firstName = createFirstName.trim();
      payload.lastName = createLastName.trim();
    } else {
      if (!createCompanyTitle.trim()) {
        setCreateError(
          parseAppError(400, { message: 'Kurumsal müşteride Şirket Unvanı zorunludur.' }),
        );
        return;
      }
      payload.companyTitle = createCompanyTitle.trim();
    }

    await runCreateCustomerAttempt({
      url: '/api/customers',
      body: JSON.stringify(payload),
      idempotencyKey: `create-cust-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    });
  };

  const runContactMutationAttempt = async (attempt: ContactMutationAttempt) => {
    setContactSubmitting(true);
    setContactActionError(null);
    try {
      const csrfToken = await getCsrfToken();
      const res = await fetch(attempt.request.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': attempt.request.idempotencyKey,
          'X-CSRF-Token': csrfToken,
        },
        body: attempt.request.body,
      });

      if (res.status === 403) invalidateCsrfToken();

      const json = (await res.json()) as ApiResponse<CompanyContactDto>;
      if (json.success) {
        setContactRetryAttempt(null);
        setContactActionError(null);
        if (attempt.kind === 'add') {
          setShowAddContact(false);
          setContactFirstName('');
          setContactLastName('');
          setContactRole('');
          setContactEmail('');
          setContactPhone('');
          setContactIsPrimary(false);
        }
        if (selectedCustomerId) void loadCustomerDetail(selectedCustomerId);
      } else {
        const appError = parseAppError(res.status, json.error);
        setContactActionError(appError);
        setContactRetryAttempt(appError.isRetryable ? attempt : null);
      }
    } catch (err) {
      setContactActionError(parseAppError(undefined, undefined, err));
      setContactRetryAttempt(attempt);
    } finally {
      setContactSubmitting(false);
    }
  };

  // Şirket Yetkilisi Ekleme
  const handleAddContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomerId) return;

    if (!contactFirstName.trim() || !contactLastName.trim()) {
      setContactActionError(parseAppError(400, { message: 'Yetkili Adı ve Soyadı zorunludur.' }));
      setContactRetryAttempt(null);
      return;
    }

    setContactRetryAttempt(null);
    await runContactMutationAttempt({
      kind: 'add',
      request: {
        url: `/api/customers/${selectedCustomerId}/contacts`,
        idempotencyKey: `add-contact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        body: JSON.stringify({
          firstName: contactFirstName.trim(),
          lastName: contactLastName.trim(),
          role: contactRole.trim() || null,
          email: contactEmail.trim() || null,
          phone: contactPhone.trim() || null,
          isPrimary: contactIsPrimary,
        }),
      },
    });
  };

  // Birincil Yetkili Olarak Belirleme
  const handleSetPrimaryContact = async (contact: CompanyContactDto) => {
    if (!selectedCustomerId) return;
    setContactRetryAttempt(null);
    await runContactMutationAttempt({
      kind: 'set-primary',
      request: {
        url: `/api/customers/${selectedCustomerId}/contacts/${contact.id}/set-primary`,
        idempotencyKey: `set-primary-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        body: JSON.stringify({ expectedVersion: contact.version }),
      },
    });
  };

  // Yetkiliyi Pasifleştirme
  const handleDeactivateContact = async (contact: CompanyContactDto) => {
    if (!selectedCustomerId) return;
    if (
      !confirm(
        `${contact.firstName} ${contact.lastName} yetkilisini pasifleştirmek istediğinize emin misiniz?`,
      )
    ) {
      return;
    }
    setContactRetryAttempt(null);
    await runContactMutationAttempt({
      kind: 'deactivate',
      request: {
        url: `/api/customers/${selectedCustomerId}/contacts/${contact.id}/deactivate`,
        idempotencyKey: `deact-contact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        body: JSON.stringify({ expectedVersion: contact.version }),
      },
    });
  };

  return (
    <div
      className={page ? 'legacy-workspace' : undefined}
      style={page ? undefined : STYLES.container}
    >
      {/* Üst Çubuk (Header) */}
      {!page && (
        <header style={STYLES.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
            <h1 style={STYLES.headerTitle}>{APP_NAME}</h1>
            <nav style={STYLES.headerNav}>
              <button
                type="button"
                style={STYLES.navButton(activeTab === 'today-work')}
                onClick={() => {
                  setShowSensitiveSearch(false);
                  setActiveTab('today-work');
                }}
              >
                Bugünkü İşler
              </button>
              <button
                type="button"
                style={STYLES.navButton(activeTab === 'overview')}
                onClick={() => setActiveTab('overview')}
              >
                Genel Bakış
              </button>
              <button
                type="button"
                style={STYLES.navButton(activeTab === 'customers')}
                onClick={() => {
                  setShowSensitiveSearch(false);
                  setActiveTab('customers');
                }}
              >
                Müşteriler
              </button>
              <button
                type="button"
                style={STYLES.navButton(activeTab === 'policies')}
                onClick={() => {
                  setShowSensitiveSearch(false);
                  setPolicyCustomer(null);
                  setActiveTab('policies');
                }}
              >
                Poliçeler
              </button>
              <button
                type="button"
                style={STYLES.navButton(activeTab === 'catalogs')}
                onClick={() => {
                  setShowSensitiveSearch(false);
                  setActiveTab('catalogs');
                }}
              >
                Kataloglar
              </button>
              <button
                type="button"
                style={STYLES.navButton(activeTab === 'agency-settings')}
                onClick={() => {
                  setShowSensitiveSearch(false);
                  setActiveTab('agency-settings');
                }}
              >
                Acente Ayarları
              </button>
            </nav>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={STYLES.statusBadge}>
              <span
                style={{
                  width: '0.5rem',
                  height: '0.5rem',
                  borderRadius: '9999px',
                  backgroundColor: '#10b981',
                }}
              />
              <span>Sistem Temeli Aktif (M1-T01)</span>
            </div>
            <div style={STYLES.statusBadge}>
              <span
                style={{
                  width: '0.5rem',
                  height: '0.5rem',
                  borderRadius: '9999px',
                  backgroundColor: '#2563eb',
                }}
              />
              <span>Müşteri Modülü Aktif (M2-T01)</span>
            </div>
          </div>
        </header>
      )}

      {/* Ana İçerik Alanı */}
      <div role={page ? undefined : 'main'} style={page ? undefined : STYLES.main}>
        {activeTab === 'today-work' && (
          <TodayWorkPanel getCsrfToken={getCsrfToken} invalidateCsrfToken={invalidateCsrfToken} />
        )}
        {activeTab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div style={STYLES.card}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>
                Mayı Sigorta CRM Yönetim Paneli
              </h2>
              <p style={{ color: '#475569', fontSize: '0.9375rem', lineHeight: 1.6, margin: 0 }}>
                Yenileme ve acente operasyonları odaklı kurumsal CRM paneline hoş geldiniz. Sistem
                M1 mimari standartları ve M2-T01 Müşteri + Şirket Yetkilisi veri modeliyle tam
                uyumlu olarak çalışmaktadır.
              </p>
              <div style={{ marginTop: '1.5rem' }}>
                <button
                  type="button"
                  style={STYLES.btnPrimary}
                  onClick={() => setActiveTab('customers')}
                >
                  Müşterileri Yönet →
                </button>
              </div>
            </div>

            {/* Hızlı Özet Kartları */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
                gap: '1rem',
              }}
            >
              <div style={STYLES.card}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#64748b' }}>
                  Bireysel Müşteriler
                </div>
                <div
                  style={{
                    fontSize: '1.75rem',
                    fontWeight: 700,
                    color: '#1d4ed8',
                    marginTop: '0.5rem',
                  }}
                >
                  INDIVIDUAL
                </div>
                <p style={{ fontSize: '0.8125rem', color: '#64748b', margin: '0.5rem 0 0 0' }}>
                  Ad, soyad ve kişisel iletişim bilgileriyle yönetilir.
                </p>
              </div>
              <div style={STYLES.card}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#64748b' }}>
                  Kurumsal Müşteriler
                </div>
                <div
                  style={{
                    fontSize: '1.75rem',
                    fontWeight: 700,
                    color: '#15803d',
                    marginTop: '0.5rem',
                  }}
                >
                  COMPANY
                </div>
                <p style={{ fontSize: '0.8125rem', color: '#64748b', margin: '0.5rem 0 0 0' }}>
                  Şirket unvanı ve tek aktif birincil yetkili garantili kontak listesi.
                </p>
              </div>
              <div style={STYLES.card}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#64748b' }}>
                  Güvenlik & İzolasyon
                </div>
                <div
                  style={{
                    fontSize: '1.75rem',
                    fontWeight: 700,
                    color: '#0f172a',
                    marginTop: '0.5rem',
                  }}
                >
                  FAIL-CLOSED
                </div>
                <p style={{ fontSize: '0.8125rem', color: '#64748b', margin: '0.5rem 0 0 0' }}>
                  Acente izolasyonu, CSRF koruması ve CAS tabanlı optimistic concurrency.
                </p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'customers' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Toolbar */}
            <div
              style={{
                ...STYLES.card,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem',
                flexWrap: 'wrap',
                padding: '1rem 1.25rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  flex: 1,
                  minWidth: '18rem',
                }}
              >
                <input
                  type="text"
                  placeholder="Müşteri adı, unvanı veya iletişim ile ara..."
                  style={STYLES.input}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button
                  type="button"
                  style={STYLES.btnSecondary}
                  onClick={() => void fetchCustomers()}
                >
                  Ara
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div
                  style={{
                    display: 'inline-flex',
                    borderRadius: '0.375rem',
                    border: '1px solid #cbd5e1',
                    overflow: 'hidden',
                  }}
                >
                  <button
                    type="button"
                    style={{
                      padding: '0.4rem 0.75rem',
                      border: 'none',
                      backgroundColor: typeFilter === 'ALL' ? '#e2e8f0' : '#ffffff',
                      fontWeight: 600,
                      fontSize: '0.8125rem',
                      cursor: 'pointer',
                    }}
                    onClick={() => setTypeFilter('ALL')}
                  >
                    Tümü
                  </button>
                  <button
                    type="button"
                    style={{
                      padding: '0.4rem 0.75rem',
                      borderLeft: '1px solid #cbd5e1',
                      borderRight: '1px solid #cbd5e1',
                      borderTop: 'none',
                      borderBottom: 'none',
                      backgroundColor: typeFilter === 'INDIVIDUAL' ? '#e2e8f0' : '#ffffff',
                      fontWeight: 600,
                      fontSize: '0.8125rem',
                      cursor: 'pointer',
                    }}
                    onClick={() => setTypeFilter('INDIVIDUAL')}
                  >
                    Bireysel
                  </button>
                  <button
                    type="button"
                    style={{
                      padding: '0.4rem 0.75rem',
                      border: 'none',
                      backgroundColor: typeFilter === 'COMPANY' ? '#e2e8f0' : '#ffffff',
                      fontWeight: 600,
                      fontSize: '0.8125rem',
                      cursor: 'pointer',
                    }}
                    onClick={() => setTypeFilter('COMPANY')}
                  >
                    Kurumsal
                  </button>
                </div>

                <button
                  type="button"
                  style={STYLES.btnSecondary}
                  onClick={() => setShowSensitiveSearch((visible) => !visible)}
                >
                  {showSensitiveSearch ? 'Hassas Aramayı Kapat' : 'TCKN/VKN ile Ara'}
                </button>

                <button
                  type="button"
                  style={STYLES.btnPrimary}
                  onClick={() => setShowCreateModal(true)}
                  data-testid="add-customer-button"
                >
                  + Yeni Müşteri
                </button>
              </div>
            </div>

            {showSensitiveSearch && (
              <SensitiveSearchPanel
                onSelectCustomer={(customerId) => {
                  setShowSensitiveSearch(false);
                  void loadCustomerDetail(customerId);
                }}
                onClose={() => setShowSensitiveSearch(false)}
              />
            )}

            {/* Müşteri Listesi Tablosu */}
            <div style={{ ...STYLES.card, padding: 0, overflow: 'hidden' }}>
              {error && (
                <div
                  style={{
                    padding: '1rem',
                    backgroundColor: '#fee2e2',
                    color: '#991b1b',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '1rem',
                  }}
                >
                  <div>{error.message}</div>
                  {error.isRetryable && (
                    <button
                      type="button"
                      style={STYLES.btnSmall}
                      onClick={() => void fetchCustomers()}
                    >
                      Tekrar Dene
                    </button>
                  )}
                </div>
              )}

              {loading && customers.length === 0 ? (
                <div
                  style={{
                    padding: '3rem',
                    textAlign: 'center',
                    color: '#64748b',
                    fontSize: '0.9375rem',
                  }}
                >
                  Müşteri listesi yükleniyor...
                </div>
              ) : customers.length === 0 ? (
                <div
                  style={{
                    padding: '3rem',
                    textAlign: 'center',
                    color: '#64748b',
                    fontSize: '0.9375rem',
                  }}
                >
                  Henüz kayıtlı müşteri bulunamadı. Yeni müşteri ekleyebilirsiniz.
                </div>
              ) : (
                <>
                  <table style={STYLES.table}>
                    <thead>
                      <tr style={{ backgroundColor: '#f8fafc' }}>
                        <th style={STYLES.th}>Müşteri / Şirket</th>
                        <th style={STYLES.th}>Tür</th>
                        <th style={STYLES.th}>E-posta</th>
                        <th style={STYLES.th}>Telefon</th>
                        <th style={STYLES.th}>Kayıt Tarihi</th>
                        <th style={{ ...STYLES.th, textAlign: 'right' }}>İşlemler</th>
                      </tr>
                    </thead>
                    <tbody>
                      {customers.map((c) => (
                        <tr key={c.id}>
                          <td style={{ ...STYLES.td, fontWeight: 600 }}>{c.displayName}</td>
                          <td style={STYLES.td}>
                            <span style={STYLES.badge(c.type)}>
                              {c.type === 'INDIVIDUAL' ? 'Bireysel' : 'Kurumsal'}
                            </span>
                          </td>
                          <td style={STYLES.td}>{c.email || '—'}</td>
                          <td style={STYLES.td}>{c.phone || '—'}</td>
                          <td style={STYLES.td}>
                            {new Date(c.createdAt).toLocaleDateString('tr-TR')}
                          </td>
                          <td style={{ ...STYLES.td, textAlign: 'right' }}>
                            <button
                              type="button"
                              style={STYLES.btnSmall}
                              onClick={() => void loadCustomerDetail(c.id)}
                            >
                              Detay & Yetkililer
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {hasMore && (
                    <div style={{ padding: '1rem', textAlign: 'center' }}>
                      <button
                        type="button"
                        style={STYLES.btnSecondary}
                        onClick={() => void fetchCustomers(nextCursor)}
                        disabled={loading}
                      >
                        {loading ? 'Yükleniyor...' : 'Daha Fazla Göster'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {activeTab === 'catalogs' && <CatalogsPanel />}
        {activeTab === 'agency-settings' && <AgencySettingsPanel />}
        {activeTab === 'policies' && (
          <PolicyPanel
            initialCustomer={policyCustomer}
            onInitialCustomerConsumed={() => setPolicyCustomer(null)}
          />
        )}
      </div>

      {/* YENİ MÜŞTERİ OLUŞTURMA MODALI */}
      {showCreateModal && (
        <div style={STYLES.modalBackdrop}>
          <div style={STYLES.modalContent}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '1.25rem',
              }}
            >
              <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700 }}>
                Yeni Müşteri Oluştur
              </h3>
              <button
                type="button"
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.25rem',
                  cursor: 'pointer',
                  color: '#64748b',
                }}
                onClick={() => setShowCreateModal(false)}
              >
                ✕
              </button>
            </div>

            {createError && (
              <div
                style={{
                  padding: '0.75rem 1rem',
                  backgroundColor: '#fee2e2',
                  color: '#991b1b',
                  borderRadius: '0.375rem',
                  fontSize: '0.875rem',
                  marginBottom: '1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                }}
              >
                <span>{createError.message}</span>
                {createError.isRetryable && createRetryAttempt && (
                  <button
                    type="button"
                    style={STYLES.btnSmall}
                    onClick={() => void runCreateCustomerAttempt(createRetryAttempt)}
                  >
                    Tekrar Dene
                  </button>
                )}
              </div>
            )}

            <form onSubmit={handleCreateCustomer}>
              {/* Tür Seçimi */}
              <div style={{ marginBottom: '1.25rem' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    marginBottom: '0.375rem',
                  }}
                >
                  Müşteri Türü
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      backgroundColor: createType === 'INDIVIDUAL' ? '#eff6ff' : '#ffffff',
                      color: createType === 'INDIVIDUAL' ? '#1d4ed8' : '#475569',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    onClick={() => setCreateType('INDIVIDUAL')}
                  >
                    Bireysel (INDIVIDUAL)
                  </button>
                  <button
                    type="button"
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      backgroundColor: createType === 'COMPANY' ? '#f0fdf4' : '#ffffff',
                      color: createType === 'COMPANY' ? '#15803d' : '#475569',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    onClick={() => setCreateType('COMPANY')}
                  >
                    Kurumsal (COMPANY)
                  </button>
                </div>
              </div>

              {/* Dinamik Alanlar */}
              {createType === 'INDIVIDUAL' ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '0.75rem',
                    marginBottom: '1rem',
                  }}
                >
                  <div>
                    <label
                      style={{
                        display: 'block',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        marginBottom: '0.25rem',
                      }}
                    >
                      Ad *
                    </label>
                    <input
                      type="text"
                      required
                      style={STYLES.input}
                      value={createFirstName}
                      onChange={(e) => setCreateFirstName(e.target.value)}
                      placeholder="Ahmet"
                    />
                  </div>
                  <div>
                    <label
                      style={{
                        display: 'block',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        marginBottom: '0.25rem',
                      }}
                    >
                      Soyad *
                    </label>
                    <input
                      type="text"
                      required
                      style={STYLES.input}
                      value={createLastName}
                      onChange={(e) => setCreateLastName(e.target.value)}
                      placeholder="Yılmaz"
                    />
                  </div>
                </div>
              ) : (
                <div style={{ marginBottom: '1rem' }}>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      marginBottom: '0.25rem',
                    }}
                  >
                    Şirket Unvanı *
                  </label>
                  <input
                    type="text"
                    required
                    style={STYLES.input}
                    value={createCompanyTitle}
                    onChange={(e) => setCreateCompanyTitle(e.target.value)}
                    placeholder="Mayı Lojistik ve Ticaret Ltd. Şti."
                  />
                </div>
              )}

              {/* Ortak İletişim Alanları */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '0.75rem',
                  marginBottom: '1rem',
                }}
              >
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      marginBottom: '0.25rem',
                    }}
                  >
                    E-posta
                  </label>
                  <input
                    type="email"
                    style={STYLES.input}
                    value={createEmail}
                    onChange={(e) => setCreateEmail(e.target.value)}
                    placeholder="ornek@mayisigorta.test"
                  />
                </div>
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      marginBottom: '0.25rem',
                    }}
                  >
                    Telefon
                  </label>
                  <input
                    type="tel"
                    style={STYLES.input}
                    value={createPhone}
                    onChange={(e) => setCreatePhone(e.target.value)}
                    placeholder="+905551112233"
                  />
                </div>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    marginBottom: '0.25rem',
                  }}
                >
                  Adres
                </label>
                <textarea
                  rows={2}
                  style={{ ...STYLES.input, resize: 'vertical' }}
                  value={createAddress}
                  onChange={(e) => setCreateAddress(e.target.value)}
                  placeholder="Açık adres bilgisi..."
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  type="button"
                  style={STYLES.btnSecondary}
                  onClick={() => setShowCreateModal(false)}
                >
                  Vazgeç
                </button>
                <button type="submit" style={STYLES.btnPrimary} disabled={createSubmitting}>
                  {createSubmitting ? 'Kaydediliyor...' : 'Müşteriyi Kaydet'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MÜŞTERİ DETAY VE ŞİRKET YETKİLİLERİ MODALI */}
      {selectedCustomerId && (
        <div style={STYLES.modalBackdrop}>
          <div style={{ ...STYLES.modalContent, maxWidth: '44rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '1rem',
                borderBottom: '1px solid #e2e8f0',
                paddingBottom: '0.75rem',
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>
                  {selectedCustomer ? selectedCustomer.displayName : 'Müşteri Detayı'}
                </h3>
                {selectedCustomer && (
                  <div style={{ marginTop: '0.25rem' }}>
                    <span style={STYLES.badge(selectedCustomer.type)}>
                      {selectedCustomer.type === 'INDIVIDUAL' ? 'Bireysel' : 'Kurumsal'}
                    </span>
                    <span
                      style={{
                        marginLeft: '0.5rem',
                        fontSize: '0.75rem',
                        color: '#64748b',
                      }}
                    >
                      Versiyon: v{selectedCustomer.version}
                    </span>
                  </div>
                )}
              </div>
              <button
                type="button"
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.25rem',
                  cursor: 'pointer',
                  color: '#64748b',
                }}
                onClick={() => {
                  setSelectedCustomerId(null);
                  setSelectedCustomer(null);
                  setShowAddContact(false);
                  setContactActionError(null);
                  setContactRetryAttempt(null);
                }}
              >
                ✕
              </button>
            </div>

            {detailLoading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                Yükleniyor...
              </div>
            ) : detailError ? (
              <div
                style={{
                  padding: '1rem',
                  color: '#991b1b',
                  backgroundColor: '#fee2e2',
                  borderRadius: '0.375rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  margin: '1rem',
                }}
              >
                <span>{detailError.message}</span>
                {detailError.isRetryable && selectedCustomerId && (
                  <button
                    type="button"
                    style={STYLES.btnSmall}
                    onClick={() => void loadCustomerDetail(selectedCustomerId)}
                  >
                    Tekrar Dene
                  </button>
                )}
              </div>
            ) : selectedCustomer ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {/* Temel Bilgiler */}
                <div
                  style={{
                    backgroundColor: '#f8fafc',
                    padding: '1rem',
                    borderRadius: '0.375rem',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '0.75rem',
                    fontSize: '0.875rem',
                  }}
                >
                  <div>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '0.75rem' }}>
                      E-posta:
                    </span>
                    <span style={{ fontWeight: 500 }}>{selectedCustomer.email || '—'}</span>
                  </div>
                  <div>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '0.75rem' }}>
                      Telefon:
                    </span>
                    <span style={{ fontWeight: 500 }}>{selectedCustomer.phone || '—'}</span>
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '0.75rem' }}>
                      Adres:
                    </span>
                    <span style={{ fontWeight: 500 }}>{selectedCustomer.address || '—'}</span>
                  </div>
                </div>

                <CustomerContactSection
                  key={selectedCustomer.id}
                  customer={selectedCustomer}
                  onUpdated={(current) => {
                    setSelectedCustomer((previous) =>
                      previous?.id === current.id ? current : previous,
                    );
                    setCustomers((previous) =>
                      previous.map((item) => (item.id === current.id ? current : item)),
                    );
                  }}
                />

                <CustomerNotesSection
                  key={`notes:${selectedCustomer.id}`}
                  customerId={selectedCustomer.id}
                  archived={selectedCustomer.archivedAt != null}
                  getCsrfToken={getCsrfToken}
                  invalidateCsrfToken={invalidateCsrfToken}
                />

                {selectedCustomer.archivedAt == null && (
                  <>
                    <CustomerRenewalsSection
                      key={selectedCustomer.id}
                      customerId={selectedCustomer.id}
                      customerDisplayName={selectedCustomer.displayName}
                      getCsrfToken={getCsrfToken}
                      invalidateCsrfToken={invalidateCsrfToken}
                    />
                    {selectedCustomerId === selectedCustomer.id && (
                      <DocumentSection
                        key={'CUSTOMER:' + selectedCustomer.id}
                        ownerType="CUSTOMER"
                        ownerId={selectedCustomer.id}
                      />
                    )}
                    <CustomerIdentitySection
                      customer={selectedCustomer}
                      onCustomerReload={() => loadCustomerDetail(selectedCustomer.id)}
                      styles={STYLES}
                    />

                    <CustomerAssignmentSection
                      customer={selectedCustomer}
                      onCustomerReload={() => loadCustomerDetail(selectedCustomer.id)}
                    />

                    <CustomerExternalReferencesSection
                      customer={selectedCustomer}
                      onCustomerReload={() => loadCustomerDetail(selectedCustomer.id)}
                    />
                  </>
                )}

                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                  {selectedCustomer.archivedAt == null && (
                    <button
                      type="button"
                      style={STYLES.btnPrimary}
                      onClick={() => {
                        setPolicyCustomer({
                          id: selectedCustomer.id,
                          displayName: selectedCustomer.displayName,
                        });
                        setSelectedCustomerId(null);
                        setSelectedCustomer(null);
                        setActiveTab('policies');
                      }}
                    >
                      + Poliçe Ekle
                    </button>
                  )}
                </div>

                <CustomerArchiveSection
                  customer={selectedCustomer}
                  onCustomerReload={() => loadCustomerDetail(selectedCustomer.id)}
                />

                {/* Kurumsal Müşteri İse Yetkililer Bölümü */}
                {selectedCustomer.type === 'COMPANY' && selectedCustomer.archivedAt == null && (
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: '0.75rem',
                      }}
                    >
                      <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                        Şirket Yetkilileri (Contacts)
                      </h4>
                      <button
                        type="button"
                        style={STYLES.btnSmall}
                        onClick={() => setShowAddContact((prev) => !prev)}
                      >
                        {showAddContact ? 'Formu Kapat' : '+ Yeni Yetkili Ekle'}
                      </button>
                    </div>

                    {contactActionError && (
                      <div
                        style={{
                          padding: '0.75rem 1rem',
                          backgroundColor: '#fee2e2',
                          color: '#991b1b',
                          borderRadius: '0.375rem',
                          fontSize: '0.8125rem',
                          marginBottom: '0.75rem',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '0.5rem',
                        }}
                      >
                        <span>{contactActionError.message}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          {contactActionError.isRetryable && contactRetryAttempt && (
                            <button
                              type="button"
                              style={STYLES.btnSmall}
                              onClick={() => void runContactMutationAttempt(contactRetryAttempt)}
                            >
                              Tekrar Dene
                            </button>
                          )}
                          <button
                            type="button"
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              color: '#991b1b',
                              fontWeight: 'bold',
                            }}
                            onClick={() => {
                              setContactActionError(null);
                              setContactRetryAttempt(null);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Yetkili Ekleme Formu */}
                    {showAddContact && (
                      <form
                        onSubmit={handleAddContact}
                        style={{
                          backgroundColor: '#f1f5f9',
                          padding: '1rem',
                          borderRadius: '0.375rem',
                          marginBottom: '1rem',
                        }}
                      >
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: '0.5rem',
                            marginBottom: '0.5rem',
                          }}
                        >
                          <div>
                            <label
                              style={{
                                display: 'block',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                              }}
                            >
                              Ad *
                            </label>
                            <input
                              type="text"
                              required
                              style={STYLES.input}
                              value={contactFirstName}
                              onChange={(e) => setContactFirstName(e.target.value)}
                            />
                          </div>
                          <div>
                            <label
                              style={{
                                display: 'block',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                              }}
                            >
                              Soyad *
                            </label>
                            <input
                              type="text"
                              required
                              style={STYLES.input}
                              value={contactLastName}
                              onChange={(e) => setContactLastName(e.target.value)}
                            />
                          </div>
                          <div>
                            <label
                              style={{
                                display: 'block',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                              }}
                            >
                              Rol / Unvan
                            </label>
                            <input
                              type="text"
                              style={STYLES.input}
                              value={contactRole}
                              onChange={(e) => setContactRole(e.target.value)}
                              placeholder="Genel Müdür, Muhasebe Sorumlusu..."
                            />
                          </div>
                          <div>
                            <label
                              style={{
                                display: 'block',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                              }}
                            >
                              E-posta
                            </label>
                            <input
                              type="email"
                              style={STYLES.input}
                              value={contactEmail}
                              onChange={(e) => setContactEmail(e.target.value)}
                            />
                          </div>
                        </div>

                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginTop: '0.5rem',
                          }}
                        >
                          <label
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.375rem',
                              fontSize: '0.8125rem',
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={contactIsPrimary}
                              onChange={(e) => setContactIsPrimary(e.target.checked)}
                            />
                            <span>Birincil Yetkili Olarak Belirle</span>
                          </label>

                          <button
                            type="submit"
                            style={STYLES.btnPrimary}
                            disabled={contactSubmitting}
                          >
                            {contactSubmitting ? 'Ekleniyor...' : 'Yetkiliyi Kaydet'}
                          </button>
                        </div>
                      </form>
                    )}

                    {/* Yetkili Listesi */}
                    {!selectedCustomer.contacts || selectedCustomer.contacts.length === 0 ? (
                      <p style={{ fontSize: '0.875rem', color: '#64748b', margin: 0 }}>
                        Henüz kayıtlı şirket yetkilisi bulunmuyor.
                      </p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {selectedCustomer.contacts.map((contact) => (
                          <div
                            key={contact.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '0.75rem 1rem',
                              backgroundColor: '#ffffff',
                              border: '1px solid #e2e8f0',
                              borderRadius: '0.375rem',
                            }}
                          >
                            <div>
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.5rem',
                                }}
                              >
                                <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                                  {contact.firstName} {contact.lastName}
                                </span>
                                {contact.isPrimary && (
                                  <span style={STYLES.badge('PRIMARY')}>Birincil</span>
                                )}
                                <span style={STYLES.badge(contact.status)}>
                                  {contact.status === 'ACTIVE' ? 'Aktif' : 'Pasif'}
                                </span>
                              </div>
                              <div
                                style={{
                                  fontSize: '0.75rem',
                                  color: '#64748b',
                                  marginTop: '0.25rem',
                                }}
                              >
                                {contact.role && <span>{contact.role} • </span>}
                                {contact.email && <span>{contact.email} • </span>}
                                {contact.phone && <span>{contact.phone}</span>}
                              </div>
                            </div>

                            <div style={{ display: 'flex', gap: '0.375rem' }}>
                              {contact.status === 'ACTIVE' && !contact.isPrimary && (
                                <button
                                  type="button"
                                  style={STYLES.btnSmall}
                                  onClick={() => void handleSetPrimaryContact(contact)}
                                >
                                  Birincil Yap
                                </button>
                              )}
                              {contact.status === 'ACTIVE' && (
                                <button
                                  type="button"
                                  style={{
                                    ...STYLES.btnSmall,
                                    color: '#b91c1c',
                                    borderColor: '#fca5a5',
                                  }}
                                  onClick={() => void handleDeactivateContact(contact)}
                                >
                                  Pasifleştir
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
