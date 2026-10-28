import { describe, expect, it } from 'vitest';
import {
  createDefaultScopeResolvers,
  type ScopeResolutionContext,
} from '../src/server/auth/authorization';
import { PERMISSION_CATALOG } from '../src/shared/permissions';

describe('M3-T01 renewal and task parent scope resolvers', () => {
  const resolvers = createDefaultScopeResolvers();

  it('bounds ASSIGNED renewal scope by its live Policy/Customer parent, never Task assignment', async () => {
    const base: Omit<ScopeResolutionContext, 'resource'> = {
      userId: 'user-a',
      membershipId: 'member-a',
      agencyId: 'agency-a',
      effectiveScope: 'ASSIGNED',
      permissionCode: 'renewal.read',
    };
    expect(
      resolvers.renewal_record_resolver({
        ...base,
        resource: {
          agencyId: 'agency-a',
          policyAssigneeMembershipId: 'member-b',
          customerAssigneeMembershipId: 'member-a',
          taskAssigneeMembershipId: 'member-a',
        },
      }),
    ).toBe(true);
    expect(
      resolvers.renewal_record_resolver({
        ...base,
        resource: {
          agencyId: 'agency-a',
          policyAssigneeMembershipId: 'member-b',
          customerAssigneeMembershipId: 'member-c',
          taskAssigneeMembershipId: 'member-a',
        },
      }),
    ).toBe(false);
    expect(
      resolvers.renewal_record_resolver({
        ...base,
        resource: {
          agencyId: 'agency-b',
          policyAssigneeMembershipId: 'member-a',
        },
      }),
    ).toBe(false);
    expect(
      resolvers.renewal_record_resolver({
        ...base,
        resource: { agencyId: 'agency-a', policyAssigneeMembershipId: null },
      }),
    ).toBe(false);
  });

  it('keeps the explicit Renewal assignee stable when its Policy/Customer assignments differ', () => {
    expect(
      resolvers.renewal_record_resolver({
        userId: 'user-a',
        membershipId: 'member-a',
        agencyId: 'agency-a',
        effectiveScope: 'ASSIGNED',
        permissionCode: 'renewal.read',
        resource: {
          agencyId: 'agency-a',
          renewalAssigneeMembershipId: 'member-a',
          policyAssigneeMembershipId: 'member-b',
          customerAssigneeMembershipId: 'member-c',
        },
      }),
    ).toBe(true);
  });

  it('does not derive ASSIGNED Renewal scope from the source Policy assignee alone', () => {
    expect(
      resolvers.renewal_record_resolver({
        userId: 'user-a',
        membershipId: 'member-a',
        agencyId: 'agency-a',
        effectiveScope: 'ASSIGNED',
        permissionCode: 'renewal.read',
        resource: {
          agencyId: 'agency-a',
          renewalAssigneeMembershipId: 'member-b',
          policyAssigneeMembershipId: 'member-a',
          customerAssigneeMembershipId: 'member-c',
        },
      }),
    ).toBe(false);
  });

  it('allows AGENCY renewal access only inside the same agency', async () => {
    const base: Omit<ScopeResolutionContext, 'resource' | 'effectiveScope'> = {
      userId: 'user-a',
      membershipId: 'member-a',
      agencyId: 'agency-a',
      permissionCode: 'renewal.read',
    };
    expect(
      resolvers.renewal_record_resolver({
        ...base,
        effectiveScope: 'AGENCY',
        resource: { agencyId: 'agency-a' },
      }),
    ).toBe(true);
    expect(
      resolvers.renewal_record_resolver({
        ...base,
        effectiveScope: 'AGENCY',
        resource: { agencyId: 'agency-b' },
      }),
    ).toBe(false);
  });

  it('keeps Task scope inside its parent portfolio and leaves unassigned queue visibility to AGENCY scope', async () => {
    const assigned: Omit<ScopeResolutionContext, 'resource'> = {
      userId: 'user-a',
      membershipId: 'member-a',
      agencyId: 'agency-a',
      effectiveScope: 'ASSIGNED',
      permissionCode: 'task.read',
    };
    expect(
      resolvers.task_record_resolver({
        ...assigned,
        resource: {
          agencyId: 'agency-a',
          policyAssigneeMembershipId: 'member-a',
          customerAssigneeMembershipId: 'member-b',
          taskAssigneeMembershipId: 'member-a',
          parentReadAuthorized: true,
        },
      }),
    ).toBe(true);
    expect(
      resolvers.task_record_resolver({
        ...assigned,
        resource: {
          agencyId: 'agency-a',
          policyAssigneeMembershipId: 'member-b',
          customerAssigneeMembershipId: 'member-c',
          taskAssigneeMembershipId: 'member-a',
          parentReadAuthorized: true,
        },
      }),
    ).toBe(false);
    expect(
      resolvers.task_record_resolver({
        ...assigned,
        resource: { agencyId: 'agency-a', isCollection: true, parentReadAuthorized: true },
      }),
    ).toBe(true);
    expect(
      resolvers.task_record_resolver({
        ...assigned,
        resource: {
          agencyId: 'agency-a',
          isCollection: true,
          assigneeMembershipId: null,
          parentReadAuthorized: true,
        },
      }),
    ).toBe(true);
    expect(
      resolvers.task_record_resolver({
        ...assigned,
        effectiveScope: 'AGENCY',
        resource: {
          agencyId: 'agency-a',
          taskAssigneeMembershipId: null,
          parentReadAuthorized: true,
        },
      }),
    ).toBe(true);
    expect(
      resolvers.task_record_resolver({
        ...assigned,
        resource: {
          agencyId: 'agency-a',
          taskAssigneeMembershipId: 'member-a',
          renewalAssigneeMembershipId: 'member-a',
          policyAssigneeMembershipId: 'member-b',
          customerAssigneeMembershipId: 'member-c',
          parentReadAuthorized: true,
        },
      }),
    ).toBe(true);
  });

  it('requires server-confirmed linked-parent read proof for Task access', () => {
    const assigned: ScopeResolutionContext = {
      userId: 'user-a',
      membershipId: 'member-a',
      agencyId: 'agency-a',
      effectiveScope: 'ASSIGNED',
      permissionCode: 'task.read',
      resource: {
        agencyId: 'agency-a',
        policyAssigneeMembershipId: 'member-a',
        customerAssigneeMembershipId: 'member-a',
      },
    };
    expect(resolvers.task_record_resolver(assigned)).toBe(false);
    expect(
      resolvers.task_record_resolver({
        ...assigned,
        resource: {
          ...(assigned.resource as Record<string, unknown>),
          taskAssigneeMembershipId: 'member-a',
          parentReadAuthorized: true,
        },
      }),
    ).toBe(true);
    expect(
      resolvers.task_record_resolver({
        ...assigned,
        effectiveScope: 'AGENCY',
        resource: { agencyId: 'agency-a' },
      }),
    ).toBe(false);
    expect(
      PERMISSION_CATALOG.find((permission) => permission.code === 'task.read')?.dependencies,
    ).toEqual([]);
  });
});
