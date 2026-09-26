import { z } from 'zod';

const version = z.number().int().min(1).max(1_000_000_000);
const membershipOrEntityId = z.string().trim().min(1).max(128);
const note = z.string().trim().min(1).max(500).nullable();
const quoteDifferenceReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

export const closeRenewalLostSchema = z
  .object({
    expectedRenewalVersion: version,
    expectedTaskVersion: version,
    lossReasonId: membershipOrEntityId,
    lossReasonNotes: note,
  })
  .strict();

export type CloseRenewalLostInput = z.infer<typeof closeRenewalLostSchema>;

const renewalWonPolicyResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CREATE_POLICY'), policy: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal('LINK_POLICY'),
      newPolicyId: membershipOrEntityId,
      expectedPolicyVersion: version,
      allocatedNewPremiumMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .strict(),
  z.object({ kind: z.literal('EXISTING_LINKS') }).strict(),
]);

export const closeRenewalWonSchema = z
  .object({
    expectedRenewalVersion: version,
    expectedTaskVersion: version,
    result: renewalWonPolicyResultSchema,
    acceptedQuoteVersionId: membershipOrEntityId.optional(),
    quoteDifferenceReasonCode: quoteDifferenceReasonCode.optional(),
  })
  .strict();

export type CloseRenewalWonInput = z.infer<typeof closeRenewalWonSchema>;

export const voidRenewalSchema = z
  .object({
    expectedRenewalVersion: version,
    expectedTaskVersion: version,
    voidReasonCode: z.enum([
      'TECHNICAL_ERROR',
      'DUPLICATE',
      'NOT_ELIGIBLE_AFTER_CANCELLATION_OR_RESTRUCTURE',
    ]),
  })
  .strict();

export type VoidRenewalInput = z.infer<typeof voidRenewalSchema>;

export const reopenRenewalSchema = z
  .object({
    expectedRenewalVersion: version,
    expectedTaskVersion: version,
    replacementDueAt: z.string().datetime({ offset: true }),
    reopenReasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  })
  .strict();

export type ReopenRenewalInput = z.infer<typeof reopenRenewalSchema>;

export const wonRenewalCorrectionGrantSchema = z
  .object({
    expectedRenewalVersion: version,
    expectedTaskVersion: version,
    replacementDueAt: z.string().datetime({ offset: true }),
    correctionReasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  })
  .strict();

export const correctWonRenewalSchema = wonRenewalCorrectionGrantSchema
  .extend({ grantEvidenceToken: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

export type WonRenewalCorrectionInput = z.infer<typeof correctWonRenewalSchema>;

const exactEntityId = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());

const allocationReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

const renewalPolicyAllocationLinkSchema = z
  .object({
    renewalId: exactEntityId,
    expectedRenewalVersion: version,
    newPolicyId: exactEntityId,
    expectedPolicyVersion: version,
    allocatedNewPremiumMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    differentPolicyholderReasonCode: allocationReasonCode.optional(),
  })
  .strict();

const renewalPolicyAllocationLinks = z
  .array(renewalPolicyAllocationLinkSchema)
  .min(1)
  .max(100)
  .superRefine((links, context) => {
    const pairKeys = new Set<string>();
    const renewalVersions = new Map<string, number>();
    const policyVersions = new Map<string, number>();
    const targetKinds = new Map<string, 'renewal' | 'policy'>();
    links.forEach((link, index) => {
      const pair = `${link.renewalId}\u0000${link.newPolicyId}`;
      if (pairKeys.has(pair)) {
        context.addIssue({ code: 'custom', path: [index], message: 'DUPLICATE_LINK' });
      }
      pairKeys.add(pair);
      const currentRenewalVersion = renewalVersions.get(link.renewalId);
      if (
        currentRenewalVersion !== undefined &&
        currentRenewalVersion !== link.expectedRenewalVersion
      ) {
        context.addIssue({
          code: 'custom',
          path: [index, 'expectedRenewalVersion'],
          message: 'VERSION_MISMATCH',
        });
      }
      renewalVersions.set(link.renewalId, link.expectedRenewalVersion);
      const currentPolicyVersion = policyVersions.get(link.newPolicyId);
      if (
        currentPolicyVersion !== undefined &&
        currentPolicyVersion !== link.expectedPolicyVersion
      ) {
        context.addIssue({
          code: 'custom',
          path: [index, 'expectedPolicyVersion'],
          message: 'VERSION_MISMATCH',
        });
      }
      policyVersions.set(link.newPolicyId, link.expectedPolicyVersion);
      const priorRenewalKind = targetKinds.get(link.renewalId);
      if (priorRenewalKind && priorRenewalKind !== 'renewal') {
        context.addIssue({
          code: 'custom',
          path: [index, 'renewalId'],
          message: 'TARGET_KIND_COLLISION',
        });
      }
      targetKinds.set(link.renewalId, 'renewal');
      const priorPolicyKind = targetKinds.get(link.newPolicyId);
      if (priorPolicyKind && priorPolicyKind !== 'policy') {
        context.addIssue({
          code: 'custom',
          path: [index, 'newPolicyId'],
          message: 'TARGET_KIND_COLLISION',
        });
      }
      targetKinds.set(link.newPolicyId, 'policy');
    });
  });

export const allocateRenewalPolicyLinksGrantSchema = z
  .object({
    reasonCode: allocationReasonCode,
    links: renewalPolicyAllocationLinks,
  })
  .strict();

export type AllocateRenewalPolicyLinksInput = z.infer<typeof allocateRenewalPolicyLinksGrantSchema>;

export const allocateRenewalPolicyLinksCommandSchema = z
  .object({
    reasonCode: allocationReasonCode,
    links: renewalPolicyAllocationLinks,
    grantEvidenceToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type AllocateRenewalPolicyLinksCommandInput = z.infer<
  typeof allocateRenewalPolicyLinksCommandSchema
>;

const wonGroupRenewalSchema = z
  .object({
    renewalId: exactEntityId,
    expectedRenewalVersion: version,
    expectedTaskVersion: version,
  })
  .strict();

const wonGroupLinkSchema = z
  .object({
    renewalId: exactEntityId,
    newPolicyId: exactEntityId,
    expectedPolicyVersion: version,
    allocatedNewPremiumMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    differentPolicyholderReasonCode: allocationReasonCode.optional(),
  })
  .strict();

const wonGroupMembers = z
  .array(wonGroupRenewalSchema)
  .min(2)
  .max(20)
  .superRefine((renewals, context) => {
    const ids = renewals.map((renewal) => renewal.renewalId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: [], message: 'DUPLICATE_RENEWAL' });
    }
  });

const wonGroupLinks = z
  .array(wonGroupLinkSchema)
  .min(2)
  .max(100)
  .superRefine((links, context) => {
    const pairs = new Set<string>();
    const policyVersions = new Map<string, number>();
    links.forEach((link, index) => {
      const pair = `${link.renewalId}\u0000${link.newPolicyId}`;
      if (pairs.has(pair)) {
        context.addIssue({ code: 'custom', path: [index], message: 'DUPLICATE_LINK' });
      }
      pairs.add(pair);
      const priorVersion = policyVersions.get(link.newPolicyId);
      if (priorVersion !== undefined && priorVersion !== link.expectedPolicyVersion) {
        context.addIssue({
          code: 'custom',
          path: [index, 'expectedPolicyVersion'],
          message: 'VERSION_MISMATCH',
        });
      }
      policyVersions.set(link.newPolicyId, link.expectedPolicyVersion);
    });
  });

function addWonGroupMembershipIssues(
  value: {
    readonly renewals: readonly z.infer<typeof wonGroupRenewalSchema>[];
    readonly links: readonly z.infer<typeof wonGroupLinkSchema>[];
  },
  context: z.RefinementCtx,
): void {
  const renewalIds = new Set(value.renewals.map((item) => item.renewalId));
  const linkedRenewalIds = new Set(value.links.map((link) => link.renewalId));
  value.links.forEach((link, index) => {
    if (!renewalIds.has(link.renewalId)) {
      context.addIssue({
        code: 'custom',
        path: ['links', index, 'renewalId'],
        message: 'RENEWAL_NOT_IN_GROUP',
      });
    }
  });
  value.renewals.forEach((renewal, index) => {
    if (!linkedRenewalIds.has(renewal.renewalId)) {
      context.addIssue({
        code: 'custom',
        path: ['renewals', index, 'renewalId'],
        message: 'RENEWAL_LINK_REQUIRED',
      });
    }
  });
}

export const closeRenewalWonGroupGrantSchema = z
  .object({
    reasonCode: allocationReasonCode,
    renewals: wonGroupMembers,
    links: wonGroupLinks,
  })
  .strict()
  .superRefine(addWonGroupMembershipIssues);

export type CloseRenewalWonGroupGrantInput = z.infer<typeof closeRenewalWonGroupGrantSchema>;

export const closeRenewalWonGroupSchema = closeRenewalWonGroupGrantSchema
  .extend({ grantEvidenceToken: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
  .superRefine(addWonGroupMembershipIssues);

export type CloseRenewalWonGroupInput = z.infer<typeof closeRenewalWonGroupSchema>;

const quoteVersionPayloadSchema = z
  .object({
    insurerId: exactEntityId,
    productId: exactEntityId,
    branchId: exactEntityId,
    paymentMethodId: exactEntityId,
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    validUntil: z.string().datetime({ offset: true }),
    grossPremiumMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    installmentCount: z.number().int().min(2).max(36).nullable(),
    termsSummary: z.string().trim().max(1000).nullable(),
  })
  .strict();

export const createRenewalQuoteSchema = z
  .object({
    expectedRenewalVersion: version,
    version: quoteVersionPayloadSchema,
  })
  .strict();

export const createRenewalQuoteVersionSchema = z
  .object({
    expectedQuoteVersion: version,
    version: quoteVersionPayloadSchema,
  })
  .strict();

export const sendRenewalQuoteSchema = z
  .object({
    expectedQuoteVersion: version,
    quoteVersionId: exactEntityId,
  })
  .strict();

export const createRenewalInteractionSchema = z
  .object({
    outcome: z.enum(['CONTACT_CONFIRMED', 'ATTEMPT_NO_RESPONSE', 'WHATSAPP_OPENED', 'NOTE']),
    channel: z.enum(['PHONE', 'EMAIL', 'WHATSAPP', 'IN_PERSON', 'OTHER']),
    occurredAt: z.string().datetime({ offset: true }),
    companyContactId: exactEntityId.nullable(),
    note: z.string().trim().min(1).max(1000).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === 'NOTE') {
      if (value.channel !== 'OTHER' || value.note === null) {
        context.addIssue({
          code: 'custom',
          path: ['note'],
          message: 'NOTE_REQUIRES_OTHER_CHANNEL',
        });
      }
    } else if (value.note !== null) {
      context.addIssue({ code: 'custom', path: ['note'], message: 'NOTE_ONLY_OUTCOME' });
    }
  });
