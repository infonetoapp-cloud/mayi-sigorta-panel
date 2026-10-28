import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApiResponse,
  CustomerDto,
  CustomerListResponseData,
  CustomerAssignmentOptionDto,
  PolicyAmendmentDto,
  PolicyDetailDto,
  PolicyDto,
  PolicyExternalReferenceDto,
  PolicyListResponseData,
  PolicyPartyDto,
  PolicyPartyRole,
  SelectableCatalogsDto,
} from '../../shared/types';
import { getCsrfToken, invalidateCsrfToken, parseAppError, type AppErrorInfo } from '../App';
import { DocumentSection } from './DocumentSection';
import { parseMoneyInput, MONEY_INPUT_HELP } from '../lib/monetary';
import { useSettingsNavigation } from './settings-navigation';
import { NavigationDecision } from './layout/NavigationDecision';
import { Button } from './ui/button';

interface PolicyPanelProps {
  readonly initialPolicyId?: string | null;
  readonly initialCustomer?: { readonly id: string; readonly displayName: string } | null;
  readonly onInitialCustomerConsumed?: () => void;
  readonly navigateToSecure?: (url: string) => void;
}

type MutationKind =
  | 'create'
  | 'update'
  | 'assign'
  | 'party-create'
  | 'party-deactivate'
  | 'amendment-create'
  | 'reference-create'
  | 'archive';

interface MutationAttempt {
  readonly kind: MutationKind;
  readonly url: string;
  readonly method: 'POST' | 'PATCH';
  readonly body: string;
  readonly idempotencyKey: string;
}

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: '0.5rem',
  padding: '1rem',
};
const row: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  flexWrap: 'wrap',
  alignItems: 'end',
};
const field: React.CSSProperties = {
  display: 'grid',
  gap: '0.25rem',
  fontSize: '0.8125rem',
  minWidth: '9rem',
  flex: 1,
};
const input: React.CSSProperties = {
  border: '1px solid #cbd5e1',
  borderRadius: '0.375rem',
  padding: '0.45rem 0.55rem',
  font: 'inherit',
};
const primary: React.CSSProperties = {
  border: 0,
  borderRadius: '0.375rem',
  background: '#2563eb',
  color: '#fff',
  padding: '0.5rem 0.75rem',
  fontWeight: 600,
  cursor: 'pointer',
};
const secondary: React.CSSProperties = {
  border: '1px solid #cbd5e1',
  borderRadius: '0.375rem',
  background: '#f8fafc',
  color: '#334155',
  padding: '0.45rem 0.7rem',
  fontWeight: 600,
  cursor: 'pointer',
};
const danger: React.CSSProperties = {
  ...secondary,
  borderColor: '#fecaca',
  background: '#fff1f2',
  color: '#9f1239',
};

function money(minor: number, currency: string): string {
  const decimal = minorToDecimal(minor);
  const negative = decimal.startsWith('-');
  const [whole, fraction] = (negative ? decimal.slice(1) : decimal).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${grouped},${fraction} ${currency}`;
}

function minorToDecimal(minor: number): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

async function safeJson<T>(
  response: Response | { json: () => Promise<unknown> },
): Promise<ApiResponse<T> | null> {
  try {
    return (await response.json()) as ApiResponse<T>;
  } catch {
    return null;
  }
}

function canonicalError(status: number, json: ApiResponse<unknown> | null): AppErrorInfo {
  const error = json && !json.success ? json.error : null;
  if (error?.code === 'OPEN_DEPENDENCIES') {
    return {
      message: 'Poliçe arşivlenemiyor. Önce açık bağımlılıkları sonuçlandırın.',
      isRetryable: false,
      category: 'CONFLICT',
    };
  }
  return parseAppError(status, error);
}

export const PolicyPanel: React.FC<PolicyPanelProps> = ({
  initialCustomer,
  initialPolicyId,
  onInitialCustomerConsumed,
  navigateToSecure,
}) => {
  const [policies, setPolicies] = useState<PolicyDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<AppErrorInfo | null>(null);
  const [failedListCursor, setFailedListCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<PolicyDetailDto | null>(null);
  const [requestedPolicyId, setRequestedPolicyId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<AppErrorInfo | null>(null);
  const [catalogs, setCatalogs] = useState<SelectableCatalogsDto | null>(null);
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [choicesError, setChoicesError] = useState<AppErrorInfo | null>(null);
  const [assignmentOptions, setAssignmentOptions] = useState<CustomerAssignmentOptionDto[]>([]);
  const [parties, setParties] = useState<PolicyPartyDto[]>([]);
  const [amendments, setAmendments] = useState<PolicyAmendmentDto[]>([]);
  const [references, setReferences] = useState<PolicyExternalReferenceDto[]>([]);
  const [relatedError, setRelatedError] = useState<AppErrorInfo | null>(null);
  const [showCreate, setShowCreate] = useState(Boolean(initialCustomer));
  const [showEdit, setShowEdit] = useState(false);
  const [showParty, setShowParty] = useState(false);
  const [showAmendment, setShowAmendment] = useState(false);
  const [showReference, setShowReference] = useState(false);
  const [showArchive, setShowArchive] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<AppErrorInfo | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<MutationAttempt | null>(null);
  const mutationLock = useRef(false);
  const unresolvedAttempt = useRef<MutationAttempt | null>(null);

  const [formCustomerId, setFormCustomerId] = useState(initialCustomer?.id ?? '');
  const [insurerId, setInsurerId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [productId, setProductId] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [grossPremium, setGrossPremium] = useState('');
  const [currency, setCurrency] = useState('TRY');
  const [installmentCount, setInstallmentCount] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'CANCELLED' | 'VOIDED'>('ACTIVE');
  const [assignee, setAssignee] = useState('');
  const [partyCustomerId, setPartyCustomerId] = useState('');
  const [partyRole, setPartyRole] = useState<PolicyPartyRole>('INSURED');
  const [amendmentReference, setAmendmentReference] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [amendmentDescription, setAmendmentDescription] = useState('');
  const [premiumDifference, setPremiumDifference] = useState('');
  const [amendmentCurrency, setAmendmentCurrency] = useState('TRY');
  const [sourceNamespace, setSourceNamespace] = useState('');
  const [externalKey, setExternalKey] = useState('');
  const [archiveReason, setArchiveReason] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [policySearch, setPolicySearch] = useState('');
  const [policySearchMode, setPolicySearchMode] = useState<'exact' | 'prefix'>('prefix');
  const activePolicyIdRef = useRef<string | null>(null);
  const held = submitting || retryAttempt !== null;
  const dirty = Boolean(
    (showCreate && (policyNumber || startDate || endDate || grossPremium)) ||
    (showEdit &&
      selected &&
      (policyNumber.trim() !== selected.policyNumber ||
        startDate !== selected.startDate ||
        endDate !== selected.endDate ||
        parseMoneyInput(grossPremium)?.canonical !== minorToDecimal(selected.grossPremiumMinor) ||
        currency !== selected.currency ||
        status !== selected.status ||
        insurerId !== selected.insurerId ||
        productId !== selected.productId ||
        branchId !== selected.branchId ||
        paymentMethodId !== selected.paymentMethodId ||
        installmentCount !== (selected.installmentCount?.toString() ?? ''))) ||
    (showAmendment &&
      (amendmentReference || effectiveDate || amendmentDescription || premiumDifference)) ||
    (showReference && (sourceNamespace || externalKey)) ||
    (showArchive && archiveReason),
  );
  const navigation = useSettingsNavigation(dirty, held, () =>
    setActionError({
      category: 'SERVER_OR_NETWORK',
      isRetryable: false,
      message:
        'İşlemin sonucu henüz kesinleşmedi. Aynı poliçede kalın ve özgün isteği tekrar deneyin.',
    }),
  );
  const choicesRequestRef = useRef(0);
  const activePolicySearchRef = useRef('');
  const activePolicySearchModeRef = useRef<'exact' | 'prefix'>('prefix');

  const loadList = useCallback(
    async (
      cursor?: string | null,
      search = activePolicySearchRef.current,
      searchMode: 'exact' | 'prefix' = activePolicySearchModeRef.current,
    ) => {
      setListLoading(true);
      setListError(null);
      try {
        const params = new URLSearchParams({ pageSize: '20', sort: 'end_date_asc' });
        if (search) params.set('search', search);
        if (search) params.set('searchMode', searchMode);
        if (cursor) params.set('cursor', cursor);
        const url = `/api/policies?${params.toString()}`;
        const res = await fetch(url);
        const json = await safeJson<PolicyListResponseData>(res);
        if (!res.ok || !json?.success) {
          setFailedListCursor(cursor ?? null);
          setListError(canonicalError(res.status, json));
          return;
        }
        setFailedListCursor(null);
        setPolicies((current) =>
          cursor ? [...current, ...json.data.items] : [...json.data.items],
        );
        setNextCursor(json.data.nextCursor);
        setHasMore(json.data.hasMore);
      } catch (cause) {
        setFailedListCursor(cursor ?? null);
        setListError(parseAppError(undefined, undefined, cause));
      } finally {
        setListLoading(false);
      }
    },
    [],
  );

  const loadChoices = useCallback(
    async (search = '') => {
      const requestId = ++choicesRequestRef.current;
      setChoicesError(null);
      try {
        const [catalogResponse, customerResponse] = await Promise.all([
          fetch('/api/catalogs/selectable'),
          fetch(`/api/customers?limit=100${search ? `&search=${encodeURIComponent(search)}` : ''}`),
        ]);
        const catalogJson = await safeJson<SelectableCatalogsDto>(catalogResponse);
        const customerJson = await safeJson<CustomerListResponseData>(customerResponse);
        if (choicesRequestRef.current !== requestId) return;
        if (catalogResponse.ok && catalogJson?.success) {
          setCatalogs(catalogJson.data);
          setInsurerId(
            (value) =>
              value || catalogJson.data.defaultInsurerId || catalogJson.data.insurers[0]?.id || '',
          );
          setBranchId((value) => value || catalogJson.data.branches[0]?.id || '');
          setPaymentMethodId((value) => value || catalogJson.data.paymentMethods[0]?.id || '');
        }
        if (customerResponse.ok && customerJson?.success) {
          setCustomers([...customerJson.data.items]);
          const availableIds = new Set(customerJson.data.items.map((customer) => customer.id));
          // The authorized handoff may be outside the first server-paged options.
          // Its dedicated option is already rendered below; do not select a different customer.
          if (!search && initialCustomer) availableIds.add(initialCustomer.id);
          setFormCustomerId((value) =>
            availableIds.has(value)
              ? value
              : !search && initialCustomer && availableIds.has(initialCustomer.id)
                ? initialCustomer.id
                : customerJson.data.items[0]?.id || '',
          );
          setPartyCustomerId((value) =>
            availableIds.has(value) ? value : customerJson.data.items[0]?.id || '',
          );
        }
        if (!catalogResponse.ok || !catalogJson?.success) {
          setChoicesError(canonicalError(catalogResponse.status, catalogJson));
        } else if (!customerResponse.ok || !customerJson?.success) {
          setChoicesError(canonicalError(customerResponse.status, customerJson));
        }
      } catch (cause) {
        if (choicesRequestRef.current !== requestId) return;
        setChoicesError(parseAppError(undefined, undefined, cause));
      }
    },
    [initialCustomer?.id],
  );

  const loadRelated = useCallback(async (policyId: string) => {
    setParties([]);
    setAmendments([]);
    setReferences([]);
    setAssignmentOptions([]);
    setRelatedError(null);
    try {
      const [partyResponse, amendmentResponse, referenceResponse, optionResponse] =
        await Promise.all([
          fetch(`/api/policies/${policyId}/parties`),
          fetch(`/api/policies/${policyId}/amendments`),
          fetch(`/api/policies/${policyId}/external-references`),
          fetch(`/api/policies/${policyId}/assignment-options`),
        ]);
      const partyJson = await safeJson<PolicyPartyDto[]>(partyResponse);
      const amendmentJson = await safeJson<PolicyAmendmentDto[]>(amendmentResponse);
      const referenceJson = await safeJson<PolicyExternalReferenceDto[]>(referenceResponse);
      const optionJson = await safeJson<CustomerAssignmentOptionDto[]>(optionResponse);
      if (activePolicyIdRef.current !== policyId) return;
      const failed = [
        [partyResponse, partyJson],
        [amendmentResponse, amendmentJson],
        [referenceResponse, referenceJson],
        [optionResponse, optionJson],
      ].find(
        ([response, json]) =>
          !(response as Response).ok || !(json as ApiResponse<unknown>)?.success,
      );
      if (failed) {
        setRelatedError(
          canonicalError((failed[0] as Response).status, failed[1] as ApiResponse<unknown>),
        );
        return;
      }
      setParties([...(partyJson as { success: true; data: PolicyPartyDto[] }).data]);
      setAmendments([...(amendmentJson as { success: true; data: PolicyAmendmentDto[] }).data]);
      setReferences([
        ...(referenceJson as { success: true; data: PolicyExternalReferenceDto[] }).data,
      ]);
      setAssignmentOptions([
        ...(optionJson as { success: true; data: CustomerAssignmentOptionDto[] }).data,
      ]);
    } catch (cause) {
      if (activePolicyIdRef.current !== policyId) return;
      setRelatedError(parseAppError(undefined, undefined, cause));
    }
  }, []);

  const loadDetail = useCallback(
    async (policyId: string) => {
      activePolicyIdRef.current = policyId;
      setRequestedPolicyId(policyId);
      setSelected(null);
      setActionError(null);
      setRetryAttempt(null);
      setShowEdit(false);
      setShowParty(false);
      setShowAmendment(false);
      setShowReference(false);
      setShowArchive(false);
      setDetailLoading(true);
      setDetailError(null);
      try {
        const res = await fetch(`/api/policies/${policyId}`);
        const json = await safeJson<PolicyDetailDto>(res);
        if (activePolicyIdRef.current !== policyId) return;
        if (!res.ok || !json?.success) {
          setDetailError(canonicalError(res.status, json));
          return;
        }
        setSelected(json.data);
        setAssignee(json.data.assigneeMembershipId);
        setPolicyNumber(json.data.policyNumber);
        setStartDate(json.data.startDate);
        setEndDate(json.data.endDate);
        setGrossPremium(minorToDecimal(json.data.grossPremiumMinor));
        setCurrency(json.data.currency);
        setInstallmentCount(json.data.installmentCount?.toString() ?? '');
        setStatus(json.data.status);
        setInsurerId(json.data.insurerId);
        setBranchId(json.data.branchId);
        setProductId(json.data.productId);
        setPaymentMethodId(json.data.paymentMethodId);
        await loadRelated(policyId);
      } catch (cause) {
        if (activePolicyIdRef.current !== policyId) return;
        setDetailError(parseAppError(undefined, undefined, cause));
      } finally {
        if (activePolicyIdRef.current === policyId) setDetailLoading(false);
      }
    },
    [loadRelated],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    if (initialPolicyId) void loadDetail(initialPolicyId);
  }, [initialPolicyId, loadDetail]);
  useEffect(() => {
    if (showCreate || selected) void loadChoices();
  }, [showCreate, selected, loadChoices]);
  useEffect(() => {
    if (initialCustomer) {
      setFormCustomerId(initialCustomer.id);
      setShowCreate(true);
    }
  }, [initialCustomer]);

  const filteredProducts = useMemo(
    () =>
      catalogs?.products.filter(
        (product) => product.insurerId === insurerId && product.branchId === branchId,
      ) ?? [],
    [catalogs, insurerId, branchId],
  );
  const selectedProductId =
    filteredProducts.some((product) => product.id === productId) ||
    (showEdit && selected?.productId === productId)
      ? productId
      : (filteredProducts[0]?.id ?? '');
  useEffect(() => {
    if (
      (showCreate || showEdit) &&
      !filteredProducts.some((product) => product.id === productId) &&
      !(showEdit && selected?.productId === productId)
    )
      setProductId(filteredProducts[0]?.id ?? '');
  }, [filteredProducts, productId, selected?.productId, showCreate, showEdit]);

  const selectedPaymentMethod = catalogs?.paymentMethods.find(
    (method) => method.id === paymentMethodId,
  );
  useEffect(() => {
    if (selectedPaymentMethod && !selectedPaymentMethod.supportsInstallments) {
      setInstallmentCount('');
    }
  }, [selectedPaymentMethod]);

  const resetAction = () => {
    if (mutationLock.current || unresolvedAttempt.current) return false;
    setActionError(null);
    setRetryAttempt(null);
    return true;
  };

  const afterMutation = async (kind: MutationKind, data: unknown) => {
    if (kind === 'create') {
      setShowCreate(false);
      onInitialCustomerConsumed?.();
      await loadList();
      const created = data as PolicyDto;
      if (created?.id) await loadDetail(created.id);
      return;
    }
    if (selected) {
      await loadDetail(selected.id);
      await loadList();
    }
    if (kind === 'update') setShowEdit(false);
    if (kind === 'party-create') setShowParty(false);
    if (kind === 'amendment-create') setShowAmendment(false);
    if (kind === 'reference-create') setShowReference(false);
    if (kind === 'archive') setShowArchive(false);
  };

  const executeMutation = async (attempt: MutationAttempt) => {
    if (
      mutationLock.current ||
      (unresolvedAttempt.current && unresolvedAttempt.current !== attempt)
    )
      return;
    mutationLock.current = true;
    const retryingUncertain = unresolvedAttempt.current !== null;
    const policyIdAtStart = attempt.kind === 'create' ? null : activePolicyIdRef.current;
    const isStale = () =>
      attempt.kind !== 'create' && activePolicyIdRef.current !== policyIdAtStart;
    setSubmitting(true);
    setActionError(null);
    try {
      const csrfToken = await getCsrfToken();
      const res = await fetch(attempt.url, {
        method: attempt.method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': attempt.idempotencyKey,
          'X-CSRF-Token': csrfToken,
        },
        body: attempt.body,
      });
      const json = await safeJson<unknown>(res);
      if (!res.ok || !json?.success) {
        if (isStale()) return;
        if (res.status === 403) invalidateCsrfToken();
        const error = canonicalError(res.status, json);
        setActionError(error);
        const uncertain = retryingUncertain || ![400, 401, 403, 404, 409, 422].includes(res.status);
        unresolvedAttempt.current = uncertain ? attempt : null;
        setRetryAttempt(uncertain ? attempt : null);
        return;
      }
      if (isStale()) return;
      unresolvedAttempt.current = null;
      setRetryAttempt(null);
      await afterMutation(attempt.kind, json.data);
    } catch (cause) {
      if (isStale()) return;
      setActionError(parseAppError(undefined, undefined, cause));
      unresolvedAttempt.current = attempt;
      setRetryAttempt(attempt);
    } finally {
      mutationLock.current = false;
      setSubmitting(false);
    }
  };

  const submitCreate = (event: React.FormEvent) => {
    event.preventDefault();
    if (!resetAction()) return;
    const amount = parseMoneyInput(grossPremium);
    if (!amount) {
      setActionError({
        category: 'VALIDATION',
        isRetryable: false,
        message: `Brüt prim biçimini kontrol edin. ${MONEY_INPUT_HELP}`,
      });
      return;
    }
    void executeMutation({
      kind: 'create',
      url: '/api/policies',
      method: 'POST',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        customerId: formCustomerId,
        insurerId: insurerId || undefined,
        productId: selectedProductId,
        branchId,
        paymentMethodId,
        policyNumber: policyNumber.trim(),
        startDate,
        endDate,
        grossPremium: amount.canonical,
        currency,
        installmentCount: selectedPaymentMethod?.supportsInstallments
          ? Number(installmentCount)
          : null,
        status,
      }),
    });
  };

  const submitUpdate = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    if (!resetAction()) return;
    const changes: Record<string, unknown> = { expectedVersion: selected.version };
    const amount = parseMoneyInput(grossPremium);
    if (!amount) {
      setActionError({
        category: 'VALIDATION',
        isRetryable: false,
        message: `Brüt prim biçimini kontrol edin. ${MONEY_INPUT_HELP}`,
      });
      return;
    }
    if (policyNumber.trim() !== selected.policyNumber) changes.policyNumber = policyNumber.trim();
    if (startDate !== selected.startDate) changes.startDate = startDate;
    if (endDate !== selected.endDate) changes.endDate = endDate;
    if (amount.canonical !== minorToDecimal(selected.grossPremiumMinor))
      changes.grossPremium = amount.canonical;
    if (currency !== selected.currency) changes.currency = currency;
    if (installmentCount !== (selected.installmentCount?.toString() ?? '')) {
      changes.installmentCount = selectedPaymentMethod?.supportsInstallments
        ? Number(installmentCount)
        : null;
    }
    if (status !== selected.status) changes.status = status;
    if (insurerId !== selected.insurerId) changes.insurerId = insurerId;
    if (selectedProductId !== selected.productId) changes.productId = selectedProductId;
    if (branchId !== selected.branchId) changes.branchId = branchId;
    if (paymentMethodId !== selected.paymentMethodId) changes.paymentMethodId = paymentMethodId;
    void executeMutation({
      kind: 'update',
      url: `/api/policies/${selected.id}`,
      method: 'PATCH',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify(changes),
    });
  };

  const submitAssign = () => {
    if (!selected || !assignee) return;
    if (!resetAction()) return;
    void executeMutation({
      kind: 'assign',
      url: `/api/policies/${selected.id}/assign`,
      method: 'POST',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({ expectedVersion: selected.version, assigneeMembershipId: assignee }),
    });
  };

  const submitParty = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    if (!resetAction()) return;
    void executeMutation({
      kind: 'party-create',
      url: `/api/policies/${selected.id}/parties`,
      method: 'POST',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        expectedVersion: selected.version,
        customerId: partyCustomerId,
        role: partyRole,
      }),
    });
  };

  const deactivateParty = (party: PolicyPartyDto) => {
    if (!selected) return;
    if (!resetAction()) return;
    void executeMutation({
      kind: 'party-deactivate',
      url: `/api/policies/${selected.id}/parties/${party.id}/deactivate`,
      method: 'POST',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({ expectedVersion: party.version }),
    });
  };

  const submitAmendment = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    if (!resetAction()) return;
    const amount = premiumDifference.trim();
    const parsed = amount ? parseMoneyInput(amount, true) : null;
    if (amount && !parsed) {
      setActionError({
        category: 'VALIDATION',
        isRetryable: false,
        message: `Prim farkı biçimini kontrol edin. ${MONEY_INPUT_HELP}`,
      });
      return;
    }
    void executeMutation({
      kind: 'amendment-create',
      url: `/api/policies/${selected.id}/amendments`,
      method: 'POST',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        expectedVersion: selected.version,
        externalReference: amendmentReference.trim(),
        effectiveDate,
        description: amendmentDescription.trim(),
        premiumDifference: parsed?.canonical ?? null,
        currency: premiumDifference.trim() ? amendmentCurrency : null,
      }),
    });
  };

  const submitReference = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    if (!resetAction()) return;
    void executeMutation({
      kind: 'reference-create',
      url: `/api/policies/${selected.id}/external-references`,
      method: 'POST',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        expectedVersion: selected.version,
        sourceNamespace: sourceNamespace.trim(),
        externalKey: externalKey.trim(),
      }),
    });
  };

  const submitArchive = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    if (!resetAction()) return;
    void executeMutation({
      kind: 'archive',
      url: `/api/policies/${selected.id}/archive`,
      method: 'POST',
      idempotencyKey: crypto.randomUUID(),
      body: JSON.stringify({
        expectedVersion: selected.version,
        reasonCode: archiveReason.trim().toUpperCase(),
      }),
    });
  };

  const healthBranch =
    catalogs?.branches.find((branch) => branch.id === branchId)?.dataClassification === 'HEALTH';
  const isArchived = selected?.archivedAt != null;

  const policyForm = (editing: boolean) => (
    <form
      onSubmit={editing ? submitUpdate : submitCreate}
      style={{ ...card, display: 'grid', gap: '0.75rem' }}
    >
      <h3 style={{ margin: 0 }}>{editing ? 'Poliçeyi Düzenle' : 'Yeni Poliçe'}</h3>
      <p style={{ margin: 0, color: '#475569', fontSize: '0.8125rem' }}>
        Her poliçe tam olarak tek sözleşme dönemini temsil eder. Yeni dönem için eski kaydı
        değiştirmeyin; yeni poliçe oluşturun.
      </p>
      {!editing && (
        <div style={row}>
          <label style={field}>
            Müşteri Ara
            <input
              aria-label="Müşteri Ara"
              style={input}
              value={customerSearch}
              onChange={(event) => setCustomerSearch(event.target.value)}
            />
          </label>
          <button
            type="button"
            style={secondary}
            onClick={() => void loadChoices(customerSearch.trim())}
          >
            Müşteri Seçeneklerini Ara
          </button>
        </div>
      )}
      <div style={row}>
        <label style={field}>
          Müşteri
          <select
            aria-label="Müşteri"
            style={input}
            value={formCustomerId}
            onChange={(e) => setFormCustomerId(e.target.value)}
            disabled={editing}
          >
            {initialCustomer && !customers.some((item) => item.id === initialCustomer.id) && (
              <option value={initialCustomer.id}>{initialCustomer.displayName}</option>
            )}
            {customers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <label style={field}>
          Sigorta Şirketi
          <select
            aria-label="Sigorta Şirketi"
            style={input}
            value={insurerId}
            onChange={(e) => {
              const nextInsurerId = e.target.value;
              setInsurerId(nextInsurerId);
              setProductId(
                catalogs?.products.find(
                  (product) => product.insurerId === nextInsurerId && product.branchId === branchId,
                )?.id ?? '',
              );
            }}
          >
            {editing &&
              selected &&
              !catalogs?.insurers.some((item) => item.id === selected.insurerId) && (
                <option value={selected.insurerId}>
                  {selected.insurer.name} (pasif geçmiş kayıt)
                </option>
              )}
            {catalogs?.insurers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label style={field}>
          Branş
          <select
            aria-label="Branş"
            style={input}
            value={branchId}
            onChange={(e) => {
              const nextBranchId = e.target.value;
              setBranchId(nextBranchId);
              setProductId(
                catalogs?.products.find(
                  (product) => product.insurerId === insurerId && product.branchId === nextBranchId,
                )?.id ?? '',
              );
            }}
          >
            {editing &&
              selected &&
              !catalogs?.branches.some((item) => item.id === selected.branchId) && (
                <option value={selected.branchId}>
                  {selected.branch.name} (pasif geçmiş kayıt)
                </option>
              )}
            {catalogs?.branches.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label style={field}>
          Ürün
          <select
            aria-label="Ürün"
            style={input}
            value={selectedProductId}
            onChange={(e) => setProductId(e.target.value)}
          >
            {editing &&
              selected &&
              !filteredProducts.some((item) => item.id === selected.productId) && (
                <option value={selected.productId}>
                  {selected.product.name} (pasif geçmiş kayıt)
                </option>
              )}
            {filteredProducts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label style={field}>
          Ödeme Yöntemi
          <select
            aria-label="Ödeme Yöntemi"
            style={input}
            value={paymentMethodId}
            onChange={(e) => setPaymentMethodId(e.target.value)}
          >
            {editing &&
              selected &&
              !catalogs?.paymentMethods.some((item) => item.id === selected.paymentMethodId) && (
                <option value={selected.paymentMethodId}>
                  {selected.paymentMethod.name} (pasif geçmiş kayıt)
                </option>
              )}
            {catalogs?.paymentMethods.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {healthBranch && (
        <div
          role="note"
          style={{
            background: '#fff7ed',
            color: '#9a3412',
            padding: '0.6rem',
            fontSize: '0.8125rem',
          }}
        >
          Bu branş sağlık sınıfındadır; sunucu ayrıca hassas sağlık yetkisini denetler. Arayüz
          görünürlüğü yetki sağlamaz.
        </div>
      )}
      <div style={row}>
        <label style={field}>
          Poliçe Numarası
          <input
            aria-label="Poliçe Numarası"
            style={input}
            value={policyNumber}
            onChange={(e) => setPolicyNumber(e.target.value)}
            required
          />
        </label>
        <label style={field}>
          Başlangıç Tarihi
          <input
            aria-label="Başlangıç Tarihi"
            type="date"
            style={input}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
          />
        </label>
        <label style={field}>
          Bitiş Tarihi
          <input
            aria-label="Bitiş Tarihi"
            type="date"
            style={input}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            required
          />
        </label>
        <label style={field}>
          Brüt Prim
          <input
            aria-label="Brüt Prim"
            aria-describedby="legacy-policy-money-help"
            inputMode="decimal"
            style={input}
            value={grossPremium}
            onChange={(e) => setGrossPremium(e.target.value)}
            required
          />
          <small id="legacy-policy-money-help">{MONEY_INPUT_HELP}</small>
        </label>
        <label style={field}>
          Para Birimi
          <input
            aria-label="Para Birimi"
            style={input}
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            required
          />
        </label>
        {selectedPaymentMethod?.supportsInstallments && (
          <label style={field}>
            Taksit Sayısı
            <input
              aria-label="Taksit Sayısı"
              type="number"
              min={2}
              max={selectedPaymentMethod.maxInstallments}
              style={input}
              value={installmentCount}
              onChange={(e) => setInstallmentCount(e.target.value)}
              required
            />
          </label>
        )}
        <label style={field}>
          Durum
          <select
            aria-label="Poliçe Durumu"
            style={input}
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="ACTIVE">Aktif</option>
            <option value="CANCELLED">İptal edildi</option>
            <option value="VOIDED">Geçersiz</option>
          </select>
        </label>
      </div>
      <div style={row}>
        <button type="submit" style={primary} disabled={submitting}>
          {editing ? 'Değişiklikleri Kaydet' : 'Poliçeyi Kaydet'}
        </button>
        <button
          type="button"
          style={secondary}
          onClick={() =>
            editing ? setShowEdit(false) : (setShowCreate(false), onInitialCustomerConsumed?.())
          }
        >
          Vazgeç
        </button>
      </div>
    </form>
  );

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {retryAttempt && (
        <div role="status">
          <p>
            Önceki işlemin sonucu kesinleşmedi. Alanlar ve hedef korunur; yalnız aynı istek tekrar
            edilir.
          </p>
          <Button
            type="button"
            disabled={submitting}
            onClick={() => void executeMutation(retryAttempt)}
          >
            Tekrar Dene
          </Button>
        </div>
      )}
      {navigation.leave && (
        <NavigationDecision onStay={navigation.stay}>
          <h3 id="navigation-decision-title">Poliçe taslağını bırakmadan önce</h3>
          <p>Kaydedilmeyen değişiklikleri bırakmak istiyor musunuz?</p>
          <Button onClick={navigation.stay}>Bu ekranda kal</Button>
          <Button
            variant="outline"
            onClick={() => {
              const go = navigation.leave;
              navigation.stay();
              if (!mutationLock.current && !unresolvedAttempt.current) go?.();
            }}
          >
            Taslağı bırak ve ayrıl
          </Button>
        </NavigationDecision>
      )}
      <fieldset
        disabled={held}
        aria-label="Poliçe çalışma alanı kontrolleri"
        style={{ display: 'contents', border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <div
          style={{
            ...card,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Poliçeler</h2>
            <small>
              Poliçe numarası tek başına benzersiz değildir; her kayıt bir sözleşme dönemidir.
            </small>
          </div>
          <button
            type="button"
            style={primary}
            onClick={() => {
              setShowCreate(true);
              setFormCustomerId(initialCustomer?.id ?? customers[0]?.id ?? '');
              resetAction();
            }}
          >
            + Yeni Poliçe
          </button>
        </div>
        {showCreate && policyForm(false)}
        {actionError && (
          <div role="alert" style={{ color: '#b91c1c' }}>
            {actionError.message}
          </div>
        )}
        {choicesError && (
          <div role="alert">
            Form seçenekleri yüklenemedi. {choicesError.message}
            <button type="button" onClick={() => void loadChoices(customerSearch.trim())}>
              Form Seçeneklerini Yeniden Yükle
            </button>
          </div>
        )}
        {listError && (
          <div role="alert">
            {listError.message}
            <button type="button" onClick={() => void loadList(failedListCursor)}>
              Poliçe Listesini Yeniden Yükle
            </button>
          </div>
        )}
        <form
          style={card}
          onSubmit={(event) => {
            event.preventDefault();
            const search = policySearch.trim();
            activePolicySearchRef.current = search;
            activePolicySearchModeRef.current = policySearchMode;
            setPolicies([]);
            setNextCursor(null);
            void loadList(null, search, policySearchMode);
          }}
        >
          <label style={field}>
            Poliçe numarası ara
            <input
              aria-label="Poliçe numarası ara"
              style={input}
              type="text"
              value={policySearch}
              onChange={(event) => setPolicySearch(event.target.value)}
            />
          </label>
          <label style={field}>
            Arama türü
            <select
              aria-label="Poliçe arama türü"
              style={input}
              value={policySearchMode}
              onChange={(event) => setPolicySearchMode(event.target.value as 'exact' | 'prefix')}
            >
              <option value="exact">Tam eşleşme</option>
              <option value="prefix">Önek</option>
            </select>
          </label>
          <button type="submit" style={secondary} disabled={listLoading}>
            Poliçelerde Ara
          </button>
        </form>
        <div style={card}>
          {listLoading && policies.length === 0 ? (
            'Poliçeler yükleniyor...'
          ) : policies.length === 0 ? (
            'Kayıtlı poliçe bulunamadı.'
          ) : (
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th>Poliçe No</th>
                    <th>Dönem</th>
                    <th>Prim</th>
                    <th>Durum</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {policies.map((item) => (
                    <tr key={item.id}>
                      <td>{item.policyNumber}</td>
                      <td>
                        {item.startDate} – {item.endDate}
                      </td>
                      <td>{money(item.grossPremiumMinor, item.currency)}</td>
                      <td>{item.archivedAt ? 'Arşivlendi' : item.status}</td>
                      <td>
                        <button
                          type="button"
                          style={secondary}
                          onClick={() => navigation.guard(() => void loadDetail(item.id))}
                        >
                          Detayı Aç
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hasMore && nextCursor && (
                <button
                  type="button"
                  style={secondary}
                  disabled={listLoading}
                  onClick={() => void loadList(nextCursor)}
                >
                  {listLoading ? 'Yükleniyor...' : 'Daha Fazla Poliçe'}
                </button>
              )}
            </>
          )}
        </div>

        {(selected || detailLoading || detailError) && (
          <section style={{ ...card, display: 'grid', gap: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Poliçe Detayı</h2>
              <button
                type="button"
                onClick={() =>
                  navigation.guard(() => {
                    activePolicyIdRef.current = null;
                    setRequestedPolicyId(null);
                    setSelected(null);
                    setDetailError(null);
                    resetAction();
                  })
                }
              >
                Kapat
              </button>
            </div>
            {detailLoading && !selected ? (
              <div>Poliçe detayı yükleniyor...</div>
            ) : detailError ? (
              <div role="alert">
                {detailError.message}
                {requestedPolicyId && (
                  <button type="button" onClick={() => void loadDetail(requestedPolicyId)}>
                    Poliçe Detayını Yeniden Yükle
                  </button>
                )}
              </div>
            ) : (
              selected && (
                <>
                  <div style={{ display: 'grid', gap: '0.35rem' }}>
                    <strong>{selected.policyNumber}</strong>
                    <span>
                      {selected.customer.displayName} · {selected.insurer.name} ·{' '}
                      {selected.product.name}
                    </span>
                    <span>
                      {selected.startDate} – {selected.endDate} ·{' '}
                      {money(selected.grossPremiumMinor, selected.currency)}
                    </span>
                    <span>
                      Durum: {selected.status} · Kimlik varyantı: {selected.identityVariant}
                    </span>
                    {isArchived && (
                      <strong style={{ color: '#9f1239' }}>
                        Arşivlenmiş poliçe · Neden: {selected.archiveReason}
                      </strong>
                    )}
                    <small>
                      Bu kayıt tek sözleşme dönemini temsil eder; zeyil veya arşiv yeni
                      dönem/yenileme değildir.
                    </small>
                  </div>
                  {selected.branch.dataClassification === 'HEALTH' && (
                    <div role="note" style={{ background: '#fff7ed', padding: '0.6rem' }}>
                      Sağlık sınıfı poliçe. Görüntüleme ve işlemler sunucudaki hassas sağlık
                      yetkisiyle korunur.
                    </div>
                  )}
                  {!isArchived && (
                    <DocumentSection
                      key={'POLICY:' + selected.id}
                      ownerType="POLICY"
                      ownerId={selected.id}
                    />
                  )}
                  {!isArchived && (
                    <div style={row}>
                      <button
                        type="button"
                        style={secondary}
                        onClick={() => {
                          setShowEdit(true);
                          resetAction();
                        }}
                      >
                        Poliçeyi Düzenle
                      </button>
                      {navigateToSecure ? (
                        <button
                          type="button"
                          style={secondary}
                          onClick={() =>
                            navigateToSecure(
                              `/secure/confirm/policies/${encodeURIComponent(selected.id)}/identity-variant`,
                            )
                          }
                        >
                          Güvenli Kimlik Varyantı
                        </button>
                      ) : (
                        <a
                          style={{ ...secondary, display: 'inline-block', textDecoration: 'none' }}
                          href={`/secure/confirm/policies/${encodeURIComponent(selected.id)}/identity-variant`}
                        >
                          Güvenli Kimlik Varyantı
                        </a>
                      )}
                      <button type="button" style={danger} onClick={() => setShowArchive(true)}>
                        Poliçeyi Arşivle
                      </button>
                    </div>
                  )}
                  {showEdit && policyForm(true)}

                  {!isArchived && (
                    <section style={card}>
                      <h3>Poliçe Sorumlusu</h3>
                      <div style={row}>
                        <label style={field}>
                          Poliçe Sorumlusu
                          <select
                            aria-label="Poliçe Sorumlusu"
                            style={input}
                            value={assignee}
                            onChange={(e) => setAssignee(e.target.value)}
                          >
                            {assignmentOptions.map((option) => (
                              <option key={option.membershipId} value={option.membershipId}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          style={primary}
                          disabled={submitting || assignee === selected.assigneeMembershipId}
                          onClick={submitAssign}
                        >
                          Sorumluyu Ata
                        </button>
                      </div>
                      <small>
                        Atama özel komutla yapılır; sunucu aktif ve aynı acente üyeliğini yeniden
                        denetler.
                      </small>
                    </section>
                  )}

                  {relatedError && (
                    <div role="alert">
                      İlişkili poliçe verileri yüklenemedi.
                      <button type="button" onClick={() => void loadRelated(selected.id)}>
                        İlişkili Verileri Yeniden Yükle
                      </button>
                    </div>
                  )}

                  <section style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <h3>Poliçe Tarafları</h3>
                      {!isArchived && (
                        <button
                          type="button"
                          style={secondary}
                          onClick={() => setShowParty(!showParty)}
                        >
                          Taraf Ekle
                        </button>
                      )}
                    </div>
                    {showParty && (
                      <form onSubmit={submitParty} style={row}>
                        <label style={field}>
                          Taraf Müşterisi Ara
                          <input
                            aria-label="Taraf Müşterisi Ara"
                            style={input}
                            value={customerSearch}
                            onChange={(event) => setCustomerSearch(event.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          style={secondary}
                          onClick={() => void loadChoices(customerSearch.trim())}
                        >
                          Taraf Seçeneklerini Ara
                        </button>
                        <label style={field}>
                          Müşteri
                          <select
                            aria-label="Taraf Müşterisi"
                            style={input}
                            value={partyCustomerId}
                            onChange={(e) => setPartyCustomerId(e.target.value)}
                          >
                            {customers.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.displayName}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={field}>
                          Rol
                          <select
                            aria-label="Taraf Rolü"
                            style={input}
                            value={partyRole}
                            onChange={(e) => setPartyRole(e.target.value as PolicyPartyRole)}
                          >
                            <option value="INSURED">Sigortalı</option>
                            <option value="BENEFICIARY">Lehtar</option>
                          </select>
                        </label>
                        <button type="submit" style={primary}>
                          Tarafı Kaydet
                        </button>
                      </form>
                    )}
                    <p>
                      <small>
                        Bu özet bağlantı, ilgili müşterinin kartına veya diğer poliçelerine erişim
                        sağlamaz.
                      </small>
                    </p>
                    {parties.length === 0 ? (
                      <p>Ek taraf bulunmuyor.</p>
                    ) : (
                      parties.map((party) => (
                        <div
                          key={party.id}
                          style={{ display: 'flex', justifyContent: 'space-between' }}
                        >
                          <span>
                            {party.customerDisplayName} · {party.role} · {party.status}
                          </span>
                          {!isArchived && party.status === 'ACTIVE' && (
                            <button
                              type="button"
                              style={secondary}
                              onClick={() => deactivateParty(party)}
                            >
                              Tarafı Pasifleştir
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </section>

                  <section style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <h3>Zeyil Geçmişi</h3>
                      {!isArchived && (
                        <button
                          type="button"
                          style={secondary}
                          onClick={() => setShowAmendment(!showAmendment)}
                        >
                          Zeyil Ekle
                        </button>
                      )}
                    </div>
                    <p>
                      <small>
                        Zeyil yeni poliçe veya yeni sözleşme dönemi oluşturmaz; mevcut dönemin
                        değişiklik kanıtıdır.
                      </small>
                    </p>
                    {showAmendment && (
                      <form onSubmit={submitAmendment} style={{ display: 'grid', gap: '0.5rem' }}>
                        <div style={row}>
                          <label style={field}>
                            Zeyil Referansı
                            <input
                              aria-label="Zeyil Referansı"
                              style={input}
                              value={amendmentReference}
                              onChange={(e) => setAmendmentReference(e.target.value)}
                              required
                            />
                          </label>
                          <label style={field}>
                            Yürürlük Tarihi
                            <input
                              aria-label="Yürürlük Tarihi"
                              type="date"
                              style={input}
                              value={effectiveDate}
                              onChange={(e) => setEffectiveDate(e.target.value)}
                              required
                            />
                          </label>
                          <label style={field}>
                            Prim Farkı
                            <input
                              aria-label="Prim Farkı"
                              style={input}
                              inputMode="decimal"
                              value={premiumDifference}
                              onChange={(e) => setPremiumDifference(e.target.value)}
                            />
                          </label>
                          <label style={field}>
                            Para Birimi
                            <input
                              aria-label="Zeyil Para Birimi"
                              style={input}
                              value={amendmentCurrency}
                              onChange={(e) => setAmendmentCurrency(e.target.value.toUpperCase())}
                              maxLength={3}
                            />
                          </label>
                        </div>
                        <label style={field}>
                          Zeyil Açıklaması
                          <textarea
                            aria-label="Zeyil Açıklaması"
                            style={input}
                            value={amendmentDescription}
                            onChange={(e) => setAmendmentDescription(e.target.value)}
                            required
                          />
                        </label>
                        <button type="submit" style={primary}>
                          Zeyli Kaydet
                        </button>
                      </form>
                    )}
                    {amendments.map((item) => (
                      <div key={item.id}>
                        {item.effectiveDate} · {item.externalReference} · {item.description} ·{' '}
                        {item.premiumDifferenceMinor == null || !item.currency
                          ? 'Prim farkı yok'
                          : money(item.premiumDifferenceMinor, item.currency)}
                      </div>
                    ))}
                  </section>

                  <section style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <h3>Harici Poliçe Referansları</h3>
                      {!isArchived && (
                        <button
                          type="button"
                          style={secondary}
                          onClick={() => setShowReference(!showReference)}
                        >
                          Referans Ekle
                        </button>
                      )}
                    </div>
                    {showReference && (
                      <form onSubmit={submitReference} style={row}>
                        <label style={field}>
                          Kaynak Sistem
                          <input
                            aria-label="Kaynak Sistem"
                            style={input}
                            value={sourceNamespace}
                            onChange={(e) => setSourceNamespace(e.target.value)}
                            required
                          />
                        </label>
                        <label style={field}>
                          Harici Anahtar
                          <input
                            aria-label="Harici Anahtar"
                            style={input}
                            value={externalKey}
                            onChange={(e) => setExternalKey(e.target.value)}
                            required
                          />
                        </label>
                        <button type="submit" style={primary}>
                          Referansı Kaydet
                        </button>
                      </form>
                    )}
                    {references.length === 0 ? (
                      <p>Harici referans bulunmuyor.</p>
                    ) : (
                      references.map((item) => (
                        <div key={item.id}>
                          {item.sourceNamespace} · {item.externalKey}
                        </div>
                      ))
                    )}
                  </section>

                  {!isArchived && showArchive && (
                    <form
                      onSubmit={submitArchive}
                      style={{ ...card, borderColor: '#fecaca', display: 'grid', gap: '0.5rem' }}
                    >
                      <strong>Poliçeyi arşivle</strong>
                      <p style={{ margin: 0, fontSize: '0.8125rem' }}>
                        Arşivleme sözleşme iptali veya VOID işlemi değildir; yaşam döngüsü durumunu
                        değiştirmez ve geçmişi korur.
                      </p>
                      <label style={field}>
                        Arşiv Nedeni
                        <input
                          aria-label="Arşiv Nedeni"
                          style={input}
                          value={archiveReason}
                          onChange={(e) => setArchiveReason(e.target.value)}
                          required
                        />
                      </label>
                      <button type="submit" style={danger}>
                        Arşivlemeyi Onayla
                      </button>
                    </form>
                  )}
                </>
              )
            )}
          </section>
        )}
      </fieldset>
    </div>
  );
};
