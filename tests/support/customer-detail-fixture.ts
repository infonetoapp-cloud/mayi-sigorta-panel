import type { CustomerDetailDto } from '../../src/shared/types';

export function customerDetailFixture(
  id: string,
  overrides: Partial<CustomerDetailDto> = {},
): CustomerDetailDto {
  return {
    id,
    agencyId: 'synthetic-agency',
    type: 'INDIVIDUAL',
    displayName: 'Sentetik müşteri',
    firstName: 'Sentetik',
    lastName: 'Müşteri',
    companyTitle: null,
    email: null,
    phone: null,
    address: null,
    assigneeMembershipId: 'synthetic-member',
    archivedAt: null,
    archivedByMembershipId: null,
    archiveReasonCode: null,
    hasIdentity: false,
    identityMasked: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
