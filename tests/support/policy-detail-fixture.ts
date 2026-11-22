import type { PolicyDetailDto } from '../../src/shared/types';

export function policyDetailFixture(
  id: string,
  overrides: Partial<PolicyDetailDto> = {},
): PolicyDetailDto {
  const customerId = overrides.customerId ?? 'c1';
  return {
    id,
    agencyId: 'synthetic-agency',
    customerId,
    insurerId: 'i1',
    productId: 'product1',
    branchId: 'b1',
    paymentMethodId: 'pay1',
    assigneeMembershipId: 'm1',
    policyNumber: 'POL-' + id,
    normalizedPolicyNumber: 'POL' + id,
    startDate: '2026-01-01',
    endDate: '2027-01-01',
    grossPremiumMinor: 123456,
    currency: 'TRY',
    installmentCount: null,
    status: 'ACTIVE',
    identityVariant: 0,
    archivedAt: null,
    archivedByMembershipId: null,
    archiveReason: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    customer: { id: customerId, displayName: 'Örnek Müşteri' },
    insurer: { id: 'i1', name: 'Sigorta Şirketi', status: 'ACTIVE' },
    product: { id: 'product1', name: 'Ürün', status: 'ACTIVE' },
    branch: {
      id: 'b1',
      name: 'Branş',
      status: 'ACTIVE',
      dataClassification: 'GENERAL',
      supportsVehicleDetails: false,
    },
    paymentMethod: { id: 'pay1', name: 'Kart', status: 'ACTIVE' },
    vehicle: null,
    ...overrides,
  };
}
