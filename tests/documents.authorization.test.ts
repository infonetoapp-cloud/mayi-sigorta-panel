import { describe, expect, it } from 'vitest';
import {
  createDefaultActionRegistry,
  createDefaultScopeResolvers,
  type ScopeResolutionContext,
} from '../src/server/auth/authorization';

const MEMBER_ID = 'member-a';

function context(
  effectiveScope: 'ASSIGNED' | 'AGENCY',
  resource: unknown,
  membershipId = MEMBER_ID,
): ScopeResolutionContext {
  return {
    userId: 'user-a',
    membershipId,
    agencyId: 'agency-a',
    effectiveScope,
    permissionCode: 'document.read',
    resource,
  };
}

async function resolveDocumentScope(
  effectiveScope: 'ASSIGNED' | 'AGENCY',
  resource: unknown,
  membershipId = MEMBER_ID,
): Promise<boolean> {
  return await createDefaultScopeResolvers().document_record_resolver(
    context(effectiveScope, resource, membershipId),
  );
}

const customerDocument = {
  id: 'document-a',
  agencyId: 'agency-a',
  ownerType: 'CUSTOMER',
  customerId: 'customer-a',
  policyId: null,
  quoteId: null,
  parentReadAuthorized: true,
  assigneeMembershipId: MEMBER_ID,
};

describe('Document record-scope resolver', () => {
  it('allows an agency-scope read only after the linked parent was authorized', async () => {
    expect(await resolveDocumentScope('AGENCY', customerDocument)).toBe(true);
    expect(
      await resolveDocumentScope('AGENCY', {
        ...customerDocument,
        parentReadAuthorized: false,
      }),
    ).toBe(false);
  });

  it('allows an assigned member only for the server-derived linked-parent assignee', async () => {
    expect(await resolveDocumentScope('ASSIGNED', customerDocument)).toBe(true);
    expect(
      await resolveDocumentScope('ASSIGNED', {
        ...customerDocument,
        assigneeMembershipId: 'member-b',
        customerAssigneeMembershipId: MEMBER_ID,
        policyAssigneeMembershipId: MEMBER_ID,
      }),
    ).toBe(false);
  });

  it('supports each typed parent while rejecting missing, mismatched, and ambiguous links', async () => {
    expect(
      await resolveDocumentScope('ASSIGNED', {
        ...customerDocument,
        ownerType: 'POLICY',
        customerId: null,
        policyId: 'policy-a',
      }),
    ).toBe(true);
    expect(
      await resolveDocumentScope('ASSIGNED', {
        ...customerDocument,
        ownerType: 'QUOTE',
        customerId: null,
        quoteId: 'quote-a',
        renewalAssigneeMembershipId: MEMBER_ID,
      }),
    ).toBe(true);
    expect(
      await resolveDocumentScope('ASSIGNED', {
        ...customerDocument,
        ownerType: 'POLICY',
        customerId: null,
        policyId: null,
      }),
    ).toBe(false);
    expect(
      await resolveDocumentScope('ASSIGNED', {
        ...customerDocument,
        ownerType: 'QUOTE',
        quoteId: 'quote-a',
      }),
    ).toBe(false);
    expect(
      await resolveDocumentScope('ASSIGNED', {
        ...customerDocument,
        policyId: 'policy-a',
      }),
    ).toBe(false);
  });

  it('preserves POLICY and QUOTE access from either eligible assigned parent', async () => {
    const policyDocument = {
      ...customerDocument,
      ownerType: 'POLICY',
      customerId: null,
      policyId: 'policy-a',
      assigneeMembershipId: 'member-policy',
      customerAssigneeMembershipId: 'member-customer',
    };
    expect(await resolveDocumentScope('ASSIGNED', policyDocument, 'member-policy')).toBe(true);
    expect(await resolveDocumentScope('ASSIGNED', policyDocument, 'member-customer')).toBe(true);
    expect(await resolveDocumentScope('ASSIGNED', policyDocument, 'member-other')).toBe(false);

    const quoteDocument = {
      ...customerDocument,
      ownerType: 'QUOTE',
      customerId: null,
      policyId: null,
      quoteId: 'quote-a',
      renewalAssigneeMembershipId: 'member-renewal',
      customerAssigneeMembershipId: 'member-customer',
    };
    expect(await resolveDocumentScope('ASSIGNED', quoteDocument, 'member-renewal')).toBe(true);
    expect(await resolveDocumentScope('ASSIGNED', quoteDocument, 'member-customer')).toBe(true);
    expect(await resolveDocumentScope('ASSIGNED', quoteDocument, 'member-other')).toBe(false);
  });

  it('denies cross-agency, unknown-scope, and parent-unproven collection resources', async () => {
    expect(
      await resolveDocumentScope('AGENCY', {
        ...customerDocument,
        agencyId: 'agency-b',
      }),
    ).toBe(false);
    expect(
      await resolveDocumentScope('ASSIGNED', {
        ...customerDocument,
        isCollection: true,
        id: undefined,
        assigneeMembershipId: 'member-b',
      }),
    ).toBe(false);
    expect(
      await resolveDocumentScope('AGENCY', {
        ...customerDocument,
        isCollection: true,
        id: undefined,
      }),
    ).toBe(true);
    expect(
      await createDefaultScopeResolvers().document_record_resolver({
        ...context('AGENCY', customerDocument),
        effectiveScope: 'UNSCOPED',
      } as unknown as ScopeResolutionContext),
    ).toBe(false);
  });
});

describe('Document sensitive actions', () => {
  it('keeps sensitive read/write grants additive to normal document scope', () => {
    const actions = createDefaultActionRegistry();

    expect(actions.get('document.health.read')).toMatchObject({
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['document.read'],
      requiredSensitivePermissions: ['sensitive.health.read'],
    });
    expect(actions.get('document.health.upload')).toMatchObject({
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['document.upload'],
      requiredSensitivePermissions: ['sensitive.health.read', 'sensitive.health.write'],
    });
    expect(actions.get('document.identity.read')).toMatchObject({
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['document.read'],
      requiredSensitivePermissions: ['sensitive.identity.read'],
    });
    expect(actions.get('document.identity.upload')).toMatchObject({
      authority: 'MEMBERSHIP_AUTHORIZED',
      requiredNormalPermissions: ['document.upload'],
      requiredSensitivePermissions: ['sensitive.identity.read', 'sensitive.identity.write'],
    });
    expect(actions.get('document.upload')?.requiredSensitivePermissions).toEqual([]);
  });
});
