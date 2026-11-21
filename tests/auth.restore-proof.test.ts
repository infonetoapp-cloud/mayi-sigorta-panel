import { closeRenewalLost, reopenRenewal } from '../src/server/renewals/commands';
import { closeSalesLost, salesLossSummary } from '../src/server/sales/loss';
import { verifySalesLossRecovery } from '../scripts/recovery/sales-loss-proof';
import { writeSalesPriceEvent } from '../src/server/sales/price-events';
import { verifySalesPriceEventRecovery } from '../scripts/recovery/sales-price-event-proof';
// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizePayload } from '../src/server/mutations/canonical';
import {
  createSyntheticAuthBackup,
  restoreSyntheticAuthBackup,
  SYNTHETIC_AUTH_TIME,
  type SyntheticAuthBackup,
  type AuthBackupArtifact,
} from '../scripts/recovery/local-auth-restore-proof';
import { createApp } from '../src/server/index';
import type { PasswordHasher } from '../src/server/auth/password';
import { writeClaim, claimDetail } from '../src/server/claims/service';
import { writeFinance, financeDetail } from '../src/server/finance/service';
import { resolveAuthenticatedUserContext } from '../src/server/auth/identity';
import { runRenewalGenerationForAgency } from '../src/server/renewals/generation';
import { writeSales } from '../src/server/sales/service';
import { adoptRenewalCase } from '../src/server/sales/adoption';
import { verifySalesRecovery } from '../scripts/recovery/sales-data-proof';
import { writeGeneralTask, readGeneralTask } from '../src/server/tasks/general-commands';
import { verifyGeneralTaskRecovery } from '../scripts/recovery/general-task-proof';
import { writeSalesPrice } from '../src/server/sales/prices';
import { verifySalesPriceRecovery } from '../scripts/recovery/sales-price-proof';
import {
  policyCancellationContext,
  executePolicyLifecycle,
} from '../src/server/policies/cancellation';

let source: Awaited<ReturnType<typeof createSyntheticAuthBackup>>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
beforeAll(async () => {
  source = await createSyntheticAuthBackup(undefined, async (db) => {
    const ctx = await resolveAuthenticatedUserContext(db, {
      issuer: 'urn:mayisigorta:local-auth:v1',
      subject: 'synthetic-subject-temporary',
      assurance: 'NORMAL',
      expiresAt: Date.now() + 60000,
    });
    const policyholder = await db
      .prepare("SELECT customer_id FROM policies WHERE id='synthetic-policy-00'")
      .first<{ customer_id: string }>();
    const fields = {
      lossDate: '2026-09-01',
      fileNumber: '000/RESTORE',
      expertName: 'Sentetik Eksper',
      expertContact: null,
      status: 'WAITING' as const,
      note: null,
    };
    const claim = await writeClaim(
      db,
      ctx,
      {
        kind: 'CREATE',
        policyId: 'synthetic-policy-00',
        customerId: policyholder!.customer_id,
        expectedPolicyVersion: 1,
        fields,
      },
      'restore-claim-create',
    );
    await writeClaim(
      db,
      ctx,
      {
        kind: 'UPDATE',
        claimId: claim.data.claimId,
        expectedVersion: 1,
        fields: { ...fields, status: 'IN_PROGRESS', note: 'Eksper raporu bekleniyor' },
      },
      'restore-claim-update',
    );
    const c = await writeFinance(
      db,
      ctx,
      {
        kind: 'CREATE',
        policyId: 'synthetic-policy-00',
        expectedPolicyVersion: 1,
        amount: '100.00',
        dueDate: '2026-09-20',
        method: 'DEFERRED',
      },
      'restore-finance-create',
    );
    const pay = await writeFinance(
      db,
      ctx,
      {
        kind: 'COLLECT',
        receivableId: c.data.receivableId,
        expectedVersion: 1,
        amount: '30.00',
        receivedDate: '2026-09-01',
        method: 'BANK',
      },
      'restore-finance-collect',
    );
    await writeFinance(
      db,
      ctx,
      {
        kind: 'ADJUST',
        receivableId: c.data.receivableId,
        expectedVersion: 2,
        amount: '120.00',
        dueDate: '2026-09-25',
        reasonCode: 'CUSTOMER_AGREED',
      },
      'restore-finance-adjust',
    );
    await writeFinance(
      db,
      ctx,
      {
        kind: 'REVERSE',
        receivableId: c.data.receivableId,
        expectedVersion: 3,
        entryId: pay.data.entryId!,
        reasonCode: 'DATA_ERROR',
      },
      'restore-finance-reverse',
    );
    await writeFinance(
      db,
      ctx,
      {
        kind: 'COLLECT',
        receivableId: c.data.receivableId,
        expectedVersion: 4,
        amount: '15.00',
        receivedDate: '2026-09-01',
        method: 'CASH',
      },
      'restore-finance-final-payment',
    );
    await db
      .prepare(
        "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('restore-cancel-other','synthetic-auth-agency','OTHER','Diğer')",
      )
      .run();
    const cancel = await policyCancellationContext(db, ctx, 'synthetic-policy-01');
    await executePolicyLifecycle(
      db,
      ctx,
      'synthetic-policy-01',
      'cancel',
      {
        expectedPolicyVersion: cancel.policyVersion,
        cancellationDate: '2026-09-01',
        reasonCode: 'OTHER',
        reasonNotes: 'Sentetik iptal',
        lossReasonId: 'restore-cancel-other',
        expectedRenewal: cancel.expectedRenewal,
        targetSetFingerprint: cancel.targetSetFingerprint,
      },
      'restore-policy-cancel',
    );
    const sales = await writeSales(
      db,
      ctx,
      policyholder!.customer_id,
      'create',
      {
        context: 'NEW_BUSINESS',
        branchId: 'synthetic-branch',
        cycleDate: '2027-09-15',
        dateBasis: 'KNOWN_END_DATE',
        followup: { dueAt: '2027-09-01T06:00:00.000Z' },
        confirmSimilar: true,
      },
      'restore-sales-create',
    );
    await writeSales(
      db,
      ctx,
      sales.data.caseId,
      'followup',
      {
        expectedCaseVersion: 1,
        expectedTaskId: sales.data.taskId,
        expectedTaskVersion: 1,
        dueAt: '2027-09-02T06:00:00.000Z',
        reasonCode: 'CALL_AGAIN',
        notes: 'Sentetik takip',
      },
      'restore-sales-followup',
    );
    const price = await writeSalesPrice(
      db,
      ctx,
      sales.data.caseId,
      null,
      {
        expectedCaseVersion: 2,
        insurerId: 'synthetic-insurer',
        amountMinor: 12500,
        currency: 'TRY',
        termsNote: null,
        offeredPeriod: null,
      },
      'restore-price-create',
    );
    const revisedPrice = await writeSalesPrice(
      db,
      ctx,
      sales.data.caseId,
      price.data.priceId,
      {
        expectedCaseVersion: 3,
        expectedPriceVersion: 1,
        amountMinor: 13050,
        currency: 'TRY',
        termsNote: 'Sentetik fiyat düzeltmesi',
        offeredPeriod: { startDate: '2027-09-15', endDate: '2028-01-10' },
      },
      'restore-price-revise',
    );
    const sharedPrice = await writeSalesPriceEvent(
      db,
      ctx,
      sales.data.caseId,
      {
        expectedCaseVersion: revisedPrice.data.caseVersion,
        revisionId: revisedPrice.data.revisionId,
        event: 'SHARED',
        occurredAt: new Date().toISOString(),
        expectedTaskId: sales.data.taskId,
        expectedTaskVersion: 2,
      },
      'restore-price-shared',
    );
    const acceptedPrice = await writeSalesPriceEvent(
      db,
      ctx,
      sales.data.caseId,
      {
        expectedCaseVersion: sharedPrice.data.caseVersion,
        revisionId: revisedPrice.data.revisionId,
        event: 'CUSTOMER_ACCEPTED',
        occurredAt: new Date().toISOString(),
        expectedTaskId: sales.data.taskId,
        expectedTaskVersion: 2,
      },
      'restore-price-accepted',
    );
    await db
      .prepare(
        "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('restore-loss-reason',?,'RESTORE_PRICE','Başka şirketten yaptırdı')",
      )
      .bind(ctx.memberships[0]!.agencyId)
      .run();
    await closeSalesLost(
      db,
      ctx,
      sales.data.caseId,
      {
        expectedCaseVersion: acceptedPrice.data.caseVersion,
        expectedTaskId: sales.data.taskId,
        expectedTaskVersion: 2,
        lossReasonId: 'restore-loss-reason',
        notes: 'Sonraki dönem tekrar görüşülecek.',
        nextCycle: {
          mode: 'FOLLOW_UP',
          cycleDate: '2028-02-29',
          dateBasis: 'KNOWN_END_DATE',
          dueAt: '2028-01-30T06:00:00.000Z',
        },
      },
      'restore-sales-lost',
    );
    const admission = await db
      .prepare(
        `SELECT p.customer_id,r.id renewal_id,r.version renewal_version,t.id task_id,t.version task_version
         FROM renewal_opportunities r JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
         JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id AND t.customer_id=p.customer_id
         WHERE p.id='synthetic-policy-02' AND p.status='ACTIVE' AND p.archived_at IS NULL
         AND r.closed_at IS NULL AND t.kind='RENEWAL_FOLLOWUP' AND t.status='OPEN'
         AND t.assignee_membership_id='synthetic-membership-temporary'`,
      )
      .first<{
        customer_id: string;
        renewal_id: string;
        renewal_version: number;
        task_id: string;
        task_version: number;
      }>();
    expect(admission).not.toBeNull();
    const tasksBefore = (await db.prepare('SELECT * FROM tasks ORDER BY id').all()).results;
    const renewalsBefore = (
      await db.prepare('SELECT * FROM renewal_opportunities ORDER BY id').all()
    ).results;
    const renewalCase = await adoptRenewalCase(
      db,
      ctx,
      admission!.customer_id,
      {
        context: 'RENEWAL',
        renewalId: admission!.renewal_id,
        expectedVersion: admission!.renewal_version,
        expectedPrimaryTaskId: admission!.task_id,
        expectedPrimaryTaskVersion: admission!.task_version,
      },
      'restore-sales-adopt',
    );
    expect((await db.prepare('SELECT * FROM tasks ORDER BY id').all()).results).toEqual(
      tasksBefore,
    );
    expect(
      (await db.prepare('SELECT * FROM renewal_opportunities ORDER BY id').all()).results,
    ).toEqual(renewalsBefore);
    const cycleClosure = await closeRenewalLost(
      ctx,
      db,
      admission!.renewal_id,
      {
        expectedPrimaryTaskId: admission!.task_id,
        expectedRenewalVersion: admission!.renewal_version,
        expectedTaskVersion: admission!.task_version,
        lossReasonId: 'restore-loss-reason',
        lossReasonNotes: null,
        salesCycle: {
          caseId: renewalCase.data.caseId,
          expectedCaseVersion: 1,
          notes: 'Yenileme sonrası tekrar görüşülecek.',
          nextCycle: {
            mode: 'FOLLOW_UP',
            cycleDate: '2028-06-20',
            dateBasis: 'KNOWN_END_DATE',
            dueAt: '2028-05-20T06:00:00.000Z',
          },
        },
      },
      'restore-renewal-lost-cycle',
    );
    const cycle = cycleClosure.data.salesCycle!;
    await reopenRenewal(
      ctx,
      db,
      admission!.renewal_id,
      {
        expectedRenewalVersion: cycleClosure.data.renewalVersion,
        expectedTaskVersion: cycleClosure.data.taskVersion,
        reopenReasonCode: 'CUSTOMER_RETURNED',
        replacementDueAt: '2028-01-15T06:00:00.000Z',
        salesCycle: {
          caseId: cycle.caseId,
          expectedCaseVersion: cycle.caseVersion,
          resultRevisionId: cycle.resultRevisionId,
          successorCaseId: cycle.followup!.caseId,
        },
      },
      'restore-renewal-recall',
    );
    await db
      .prepare(
        `INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,actor_kind,created_by_user_id,created_by_membership_id,created_at,updated_at)
       VALUES('synthetic-legacy-general','synthetic-auth-agency',?,'GENERAL','Sentetik genel müşteri takibi',
       '2026-09-01T06:00:00.000Z','synthetic-membership-permanent','USER','synthetic-temporary','synthetic-membership-temporary',?,?)`,
      )
      .bind(
        policyholder!.customer_id,
        new Date(SYNTHETIC_AUTH_TIME).toISOString(),
        new Date(SYNTHETIC_AUTH_TIME).toISOString(),
      )
      .run();
    await writeGeneralTask(
      db,
      ctx,
      'synthetic-legacy-general',
      'reschedule',
      {
        expectedTaskVersion: 1,
        dueAt: '2027-10-01T06:00:00.000Z',
        reasonCode: 'CALL_AGAIN',
        notes: 'Sentetik geri arama',
      },
      'restore-general-reschedule',
    );
    await writeGeneralTask(
      db,
      ctx,
      'synthetic-legacy-general',
      'assign',
      {
        expectedTaskVersion: 2,
        assigneeMembershipId: 'synthetic-membership-temporary',
        reasonCode: 'REASSIGN',
        notes: 'Sentetik görev devri',
      },
      'restore-general-assign',
    );
    await writeGeneralTask(
      db,
      ctx,
      'synthetic-legacy-general',
      'complete',
      {
        expectedTaskVersion: 3,
        reasonCode: 'COMPLETED',
        notes: 'Sentetik görüşme tamamlandı',
      },
      'restore-general-complete',
    );
  });
}, 180000);
afterAll(async () => {
  await source?.dispose();
});
function manifestChange(change: (b: SyntheticAuthBackup) => void) {
  const b = structuredClone(source.backup);
  change(b);
  b.manifestSha256 = sha(canonicalizePayload(b.manifest));
  return b;
}
function artifactChange(change: (a: AuthBackupArtifact) => void, rehashRows = false) {
  const b = structuredClone(source.backup),
    a = JSON.parse(b.artifactJson) as AuthBackupArtifact;
  change(a);
  for (const name of Object.keys(a.data))
    a.data[name] = a.data[name]!.map((r) => JSON.parse(canonicalizePayload(r))).sort((x, y) =>
      canonicalizePayload(x) < canonicalizePayload(y)
        ? -1
        : canonicalizePayload(x) > canonicalizePayload(y)
          ? 1
          : 0,
    );
  b.artifactJson = JSON.stringify(a);
  b.manifest.artifactSha256 = sha(b.artifactJson);
  if (rehashRows)
    for (const name of Object.keys(a.data)) {
      b.manifest.rowCounts[name] = a.data[name]!.length;
      b.manifest.fingerprints[name] = sha(JSON.stringify(a.data[name]));
    }
  b.manifestSha256 = sha(canonicalizePayload(b.manifest));
  return b;
}

it('restores current 0040 profile, vehicles, notes and pending generation, resumes exactly once and remains sealed', async () => {
  expect(source.backup.manifest.schemaVersion).toBe('0040');
  expect(source.backup.manifest.highestMigration).toBe('0040_branch_vehicle_details.sql');
  expect(source.backup.manifest.history).toHaveLength(41);
  const restored = await restoreSyntheticAuthBackup(source.backup);
  try {
    for (const table of [
      'customers',
      'customer_notes',
      'operation_receipts',
      'audit_events',
      'renewal_generation_cursors',
      'customer_vehicles',
      'policy_vehicle_snapshots',
      'finance_receivables',
      'finance_entries',
      'finance_revisions',
      'claim_files',
      'claim_history',
      'policy_cancellations',
      'policy_void_events',
      'policy_lifecycle_targets',
      'sales_cases',
      'sales_case_tasks',
      'sales_case_history',
      'sales_prices',
      'sales_price_revisions',
      'sales_price_events',
      'sales_case_result_revisions',
      'tasks',
      'renewal_opportunities',
    ])
      expect(
        (await restored.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results,
      ).toEqual((await source.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results);
    const finance = await restored.db
      .prepare('SELECT id FROM finance_receivables')
      .first<{ id: string }>();
    const financialContext = await resolveAuthenticatedUserContext(restored.db, {
      issuer: 'urn:mayisigorta:local-auth:v1',
      subject: 'synthetic-subject-temporary',
      assurance: 'NORMAL',
      expiresAt: Date.now() + 60000,
    });
    const claimRow = await restored.db
      .prepare('SELECT id FROM claim_files')
      .first<{ id: string }>();
    const restoredClaim = await claimDetail(restored.db, financialContext, claimRow!.id);
    const cancelReceipt = await restored.db
      .prepare(
        "SELECT response_body FROM operation_receipts WHERE idempotency_key='restore-policy-cancel'",
      )
      .first<{ response_body: string }>();
    const cancelled = await executePolicyLifecycle(
      restored.db,
      financialContext,
      'synthetic-policy-01',
      'cancel',
      JSON.parse(cancelReceipt!.response_body).command,
      'restore-policy-cancel',
    );
    expect(cancelled.replayed).toBe(true);
    const salesReceipt = await restored.db
      .prepare(
        "SELECT response_body FROM operation_receipts WHERE idempotency_key='restore-sales-followup'",
      )
      .first<{ response_body: string }>();
    const savedSales = JSON.parse(salesReceipt!.response_body) as {
      result: { caseId: string };
      command: unknown;
    };
    expect(
      (
        await writeSales(
          restored.db,
          financialContext,
          savedSales.result.caseId,
          'followup',
          savedSales.command,
          'restore-sales-followup',
        )
      ).replayed,
    ).toBe(true);
    expect(
      await salesLossSummary(restored.db, financialContext, savedSales.result.caseId),
    ).toMatchObject({ reason: 'Başka şirketten yaptırdı' });
    const lossReceipt = await restored.db
      .prepare(
        "SELECT response_body FROM operation_receipts WHERE idempotency_key='restore-sales-lost'",
      )
      .first<{ response_body: string }>();
    const loss = JSON.parse(lossReceipt!.response_body);
    expect(
      await closeSalesLost(
        restored.db,
        financialContext,
        savedSales.result.caseId,
        loss.command,
        'restore-sales-lost',
      ),
    ).toEqual({ data: loss.result, replayed: true });
    await verifySalesLossRecovery(async (sql) => (await restored.db.prepare(sql).all()).results);
    for (const omitted of ['sales_case_result_revisions', 'sales_cases']) {
      await expect(
        verifySalesLossRecovery(async (sql) => {
          const rows = (await restored.db.prepare(sql).all()).results;
          return sql === `SELECT * FROM ${omitted}`
            ? rows.filter(
                (r) =>
                  r.id !==
                  (omitted === 'sales_cases'
                    ? loss.result.followup.caseId
                    : loss.result.resultRevisionId),
              )
            : rows;
        }),
      ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
    }
    for (const key of ['restore-price-create', 'restore-price-revise']) {
      const receipt = await restored.db
        .prepare('SELECT response_body FROM operation_receipts WHERE idempotency_key=?')
        .bind(key)
        .first<{ response_body: string }>();
      const saved = JSON.parse(receipt!.response_body) as {
        targetId: string;
        priceId: string | null;
        command: unknown;
        result: unknown;
      };
      expect(
        await writeSalesPrice(
          restored.db,
          financialContext,
          saved.targetId,
          saved.priceId,
          saved.command,
          key,
        ),
      ).toEqual({ data: saved.result, replayed: true });
    }
    await expect(
      verifySalesPriceRecovery(async (sql) => {
        const rows = (await restored.db.prepare(sql).all()).results;
        return sql === 'SELECT * FROM sales_price_revisions'
          ? rows.filter((row) => row.revision_number !== 1)
          : rows;
      }),
    ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
    for (const key of ['restore-price-shared', 'restore-price-accepted']) {
      const receipt = await restored.db
        .prepare('SELECT response_body FROM operation_receipts WHERE idempotency_key=?')
        .bind(key)
        .first<{ response_body: string }>();
      const saved = JSON.parse(receipt!.response_body) as {
        targetId: string;
        command: unknown;
        result: unknown;
      };
      expect(
        await writeSalesPriceEvent(
          restored.db,
          financialContext,
          saved.targetId,
          saved.command,
          key,
        ),
      ).toEqual({ data: saved.result, replayed: true });
    }
    await expect(
      verifySalesPriceEventRecovery(async (sql) => {
        const rows = (await restored.db.prepare(sql).all()).results;
        return sql === 'SELECT * FROM sales_price_events'
          ? rows.filter((e) => e.event_code !== 'SHARED')
          : rows;
      }),
    ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
    const cycleReceipt = await restored.db
      .prepare(
        "SELECT response_body FROM operation_receipts WHERE idempotency_key='restore-renewal-lost-cycle'",
      )
      .first<{ response_body: string }>();
    const cycleSaved = JSON.parse(cycleReceipt!.response_body);
    const { cycleCommand: ignoredCycleCommand, ...cycleResult } = cycleSaved;
    void ignoredCycleCommand;
    expect(
      await closeRenewalLost(
        financialContext,
        restored.db,
        cycleSaved.renewalId,
        cycleSaved.cycleCommand,
        'restore-renewal-lost-cycle',
      ),
    ).toEqual({ data: cycleResult, replayed: true });
    const recallReceipt = await restored.db
      .prepare(
        "SELECT response_body FROM operation_receipts WHERE idempotency_key='restore-renewal-recall'",
      )
      .first<{ response_body: string }>();
    const { cycleCommand: recallCommand, ...recallResult } = JSON.parse(
      recallReceipt!.response_body,
    );
    expect(
      await reopenRenewal(
        financialContext,
        restored.db,
        recallResult.renewalId,
        recallCommand,
        'restore-renewal-recall',
      ),
    ).toEqual({ data: recallResult, replayed: true });
    const admissionReceipt = await restored.db
      .prepare(
        "SELECT response_body FROM operation_receipts WHERE idempotency_key='restore-sales-adopt'",
      )
      .first<{ response_body: string }>();
    const savedAdmission = JSON.parse(admissionReceipt!.response_body) as {
      targetId: string;
      command: unknown;
      result: { caseId: string; taskId: string; taskVersion: number };
    };
    const admissionReplay = await adoptRenewalCase(
      restored.db,
      financialContext,
      savedAdmission.targetId,
      savedAdmission.command,
      'restore-sales-adopt',
    );
    expect(admissionReplay).toEqual({ replayed: true, data: savedAdmission.result });
    expect(savedAdmission.result.taskId).toBe('synthetic-task-02');
    expect(
      await restored.db
        .prepare('SELECT context_kind,result,active_task_id,renewal_id FROM sales_cases WHERE id=?')
        .bind(savedAdmission.result.caseId)
        .first(),
    ).toEqual({
      context_kind: 'RENEWAL',
      result: null,
      active_task_id: null,
      renewal_id: 'synthetic-renewal-02',
    });
    expect(
      await restored.db
        .prepare('SELECT task_id FROM sales_case_tasks WHERE case_id=?')
        .bind(savedAdmission.result.caseId)
        .first(),
    ).toEqual({ task_id: 'synthetic-task-02' });
    await expect(
      verifySalesRecovery(async (sql) => {
        const rows = (await restored.db.prepare(sql).all()).results;
        return sql === 'SELECT * FROM sales_case_tasks'
          ? rows.filter((row) => row.case_id !== savedAdmission.result.caseId)
          : rows;
      }),
    ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
    for (const kind of ['reschedule', 'assign', 'complete'] as const) {
      const operationKey = `restore-general-${kind}`;
      const receipt = await restored.db
        .prepare('SELECT response_body FROM operation_receipts WHERE idempotency_key=?')
        .bind(operationKey)
        .first<{ response_body: string }>();
      const saved = JSON.parse(receipt!.response_body) as { command: unknown; result: unknown };
      expect(
        await writeGeneralTask(
          restored.db,
          financialContext,
          'synthetic-legacy-general',
          kind,
          saved.command,
          operationKey,
        ),
      ).toEqual({ replayed: true, data: saved.result });
    }
    expect(
      await readGeneralTask(restored.db, financialContext, 'synthetic-legacy-general'),
    ).toMatchObject({
      kind: 'GENERAL',
      taskVersion: 4,
      status: 'COMPLETED',
      policyId: null,
      caseId: null,
      assigneeMembershipId: 'synthetic-membership-temporary',
      dueAt: '2027-10-01T06:00:00.000Z',
      canReschedule: false,
      canComplete: false,
      canAssign: false,
    });
    await expect(
      verifyGeneralTaskRecovery(async (sql) => {
        const rows = (await restored.db.prepare(sql).all()).results;
        return sql.startsWith("SELECT * FROM audit_events WHERE action IN ('task.general.")
          ? rows.filter((row) => row.action !== 'task.general.complete')
          : rows;
      }),
    ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
    expect(cancelled.data).toMatchObject({
      policyId: 'synthetic-policy-01',
      status: 'CANCELLED',
      closedRenewalId: 'synthetic-renewal-01',
      completedTaskId: 'synthetic-task-01',
    });
    expect(
      await restored.db
        .prepare(
          "SELECT count(*) n FROM policy_cancellations WHERE policy_id='synthetic-policy-01'",
        )
        .first(),
    ).toEqual({ n: 1 });
    expect(restoredClaim.claim).toMatchObject({
      fileNumber: '000/RESTORE',
      status: 'IN_PROGRESS',
      note: 'Eksper raporu bekleniyor',
      version: 2,
    });
    expect(restoredClaim.history).toHaveLength(2);
    const replayClaim = await writeClaim(
      restored.db,
      financialContext,
      {
        kind: 'UPDATE',
        claimId: claimRow!.id,
        expectedVersion: 1,
        fields: restoredClaim.history[0]!.fields,
      },
      'restore-claim-update',
    );
    expect(replayClaim.replayed).toBe(true);
    const financialDetail = await financeDetail(restored.db, financialContext, finance!.id);
    expect(financialDetail.receivable).toMatchObject({
      amountMinor: 12000,
      collectedMinor: 1500,
      remainingMinor: 10500,
      version: 5,
    });
    expect(financialDetail.entries).toHaveLength(3);
    expect(financialDetail.revisions).toHaveLength(2);
    const replay = await writeFinance(
      restored.db,
      financialContext,
      {
        kind: 'COLLECT',
        receivableId: finance!.id,
        expectedVersion: 4,
        amount: '15.00',
        receivedDate: '2026-09-01',
        method: 'CASH',
      },
      'restore-finance-final-payment',
    );
    expect(replay.replayed).toBe(true);
    expect(
      await restored.db
        .prepare(
          "SELECT json_extract(details_json,'$.model') model,version FROM customer_vehicles WHERE id='synthetic-vehicle'",
        )
        .first(),
    ).toEqual({ model: 'Güncel model', version: 2 });
    expect(
      await restored.db
        .prepare(
          "SELECT json_extract(details_json,'$.model') model,vehicle_version FROM policy_vehicle_snapshots WHERE policy_id='synthetic-policy-00'",
        )
        .first(),
    ).toEqual({ model: 'İlk model', vehicle_version: 1 });
    expect(
      await restored.db.prepare('SELECT content,author_name FROM customer_notes').first(),
    ).toEqual({
      content: 'Sentetik müşteri notu.\nİkinci satır: “alıntı”.',
      author_name: 'Sentetik İlk Ad',
    });
    expect(
      await restored.db
        .prepare("SELECT display_name FROM users WHERE id='synthetic-permanent'")
        .first(),
    ).toEqual({ display_name: 'Sonraki Ad' });
    const before = await restored.db.prepare('SELECT * FROM renewal_generation_cursors').first<{
      continuation_json: string;
      last_attempt_order: number;
      last_successful_local_date: string;
    }>();
    expect(before).toMatchObject({
      last_successful_local_date: '2026-08-31',
      last_attempt_order: 7,
    });
    expect(JSON.parse(before!.continuation_json)).toMatchObject({
      through: '2026-09-01',
      key: { policyId: 'synthetic-policy-03' },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T06:00:00.000Z'));
    try {
      expect(
        await runRenewalGenerationForAgency(restored.db, 'synthetic-auth-agency'),
      ).toMatchObject({ createdCount: 2, completedThrough: '2026-09-01' });
      expect(
        (await runRenewalGenerationForAgency(restored.db, 'synthetic-auth-agency')).createdCount,
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    for (const table of ['renewal_opportunities', 'tasks', 'renewal_state_history'])
      expect(await restored.db.prepare(`SELECT count(*) AS count FROM ${table}`).first()).toEqual({
        count: table === 'tasks' ? 11 : table === 'renewal_state_history' ? 9 : 6,
      });
    expect(
      await restored.db
        .prepare(
          "SELECT count(*) AS count FROM system_audit_events WHERE action='renewal.generate'",
        )
        .first(),
    ).toEqual({ count: 6 });
    expect(
      await restored.db
        .prepare(
          'SELECT last_successful_local_date,continuation_json,last_attempt_order FROM renewal_generation_cursors',
        )
        .first(),
    ).toEqual({
      last_successful_local_date: '2026-09-01',
      continuation_json: null,
      last_attempt_order: 7,
    });
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await expect(
      restored.db.prepare("UPDATE customer_notes SET content='forged'").run(),
    ).rejects.toThrow('CUSTOMER_NOTE_IMMUTABLE');
    await expect(restored.db.prepare('DELETE FROM customer_notes').run()).rejects.toThrow(
      'CUSTOMER_NOTE_IMMUTABLE',
    );
    expect(restored.assertPublication).toThrow('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  } finally {
    await restored.dispose();
  }
}, 120000);

it.each(['note author', 'continuation JSON'] as const)(
  'rejects inconsistent %s even after unsigned artifact fingerprints are recomputed',
  async (kind) => {
    const changed = artifactChange((artifact) => {
      if (kind === 'note author')
        artifact.data.customer_notes![0]!.author_user_id = 'synthetic-temporary';
      else artifact.data.renewal_generation_cursors![0]!.continuation_json = '{"offset":4}';
    }, true);
    expect(await rejectedRelation(changed)).toEqual({
      accepted: false,
      code: 'OPERATIONAL_RECOVERY_INVALID',
    });
  },
);

it.each([
  'note membership',
  'receipt payload',
  'receipt result',
  'note audit',
  'audit actor',
  'extra audit',
  'missing note',
  'completed date',
  'rotation',
  'window',
  'key',
  'generation history',
  'generation audit',
  'missing cursor',
] as const)(
  'rejects corrupted %s recovery evidence even with recomputed fingerprints',
  async (kind) => {
    const changed = artifactChange((a) => {
      const saved = a.data.renewal_generation_cursors![0]!;
      const receipt = a.data.operation_receipts!.find(
        (row) => row.action === 'customer.note.create',
      )!;
      if (kind === 'note membership')
        a.data.customer_notes![0]!.author_membership_id = 'synthetic-membership-temporary';
      if (kind === 'receipt payload') receipt.payload_fingerprint = '0'.repeat(64);
      if (kind === 'receipt result')
        receipt.response_body = JSON.stringify({ id: '22222222-2222-4222-8222-222222222222' });
      if (kind === 'note audit') a.data.audit_events = [];
      if (kind === 'audit actor') {
        const noteAudit = a.data.audit_events!.find(
          (row) =>
            row.action === 'customer.note.created' &&
            row.idempotency_key === receipt.idempotency_key,
        )!;
        noteAudit.actor_user_id = 'synthetic-temporary';
        noteAudit.actor_membership_id = 'synthetic-membership-temporary';
      }
      if (kind === 'extra audit')
        a.data.audit_events!.push({
          ...a.data.audit_events![0]!,
          id: 'synthetic-extra-note-audit',
          actor_user_id: 'synthetic-temporary',
          actor_membership_id: 'synthetic-membership-temporary',
        });
      if (kind === 'missing note') a.data.customer_notes = [];
      if (kind === 'completed date') saved.last_successful_local_date = '2026-08-30';
      if (kind === 'rotation') saved.last_attempt_order = -1;
      if (kind === 'window' || kind === 'key') {
        const pending = JSON.parse(String(saved.continuation_json));
        if (kind === 'window') pending.upperDate = '2026-10-02';
        else pending.key.endDate = '2026-12-01';
        saved.continuation_json = JSON.stringify(pending);
      }
      if (kind === 'generation history') a.data.renewal_state_history!.pop();
      if (kind === 'generation audit')
        a.data.system_audit_events = a.data.system_audit_events!.filter(
          (row) => row.id !== 'synthetic-generation-00',
        );
      if (kind === 'missing cursor') a.data.renewal_generation_cursors = [];
    }, true);
    expect(await rejectedRelation(changed)).toEqual({
      accepted: false,
      code: 'OPERATIONAL_RECOVERY_INVALID',
    });
  },
);
it.each(['content', 'author snapshot', 'checkpoint', 'rotation', 'completion date'] as const)(
  'detects %s changes against the original deterministic table fingerprint',
  async (kind) => {
    const changed = artifactChange((a) => {
      if (kind === 'content') a.data.customer_notes![0]!.content = 'Changed content';
      if (kind === 'author snapshot') a.data.customer_notes![0]!.author_name = 'Changed author';
      if (kind === 'checkpoint') a.data.renewal_generation_cursors![0]!.continuation_json = '{}';
      if (kind === 'rotation') a.data.renewal_generation_cursors![0]!.last_attempt_order = 8;
      if (kind === 'completion date')
        a.data.renewal_generation_cursors![0]!.last_successful_local_date = '2026-08-30';
    });
    await expect(restoreSyntheticAuthBackup(changed)).rejects.toThrow('DATA_FINGERPRINT_MISMATCH');
  },
);
it('rejects a note with a missing customer FK even after fingerprints are recomputed', async () => {
  await expect(
    restoreSyntheticAuthBackup(
      artifactChange((a) => {
        a.data.customer_notes![0]!.customer_id = 'synthetic-missing-customer';
      }, true),
    ),
  ).rejects.toThrow('DB_FK_FAILED');
});
it('does not relabel a 0020 manifest as a current recovery proof', async () => {
  const changed = manifestChange((backup) => {
    (backup.manifest as unknown as Record<string, unknown>).schemaVersion = '0020';
  });
  await expect(restoreSyntheticAuthBackup(changed)).rejects.toThrow();
});

it('restores populated synthetic F-27 auth into a fresh native D1 and stays sealed', async () => {
  const restored = await restoreSyntheticAuthBackup(source.backup);
  try {
    expect(restored.report.code).toBe('VERIFIED_SEALED');
    expect(restored.report.schemaHash).toBe(
      '84be40bb8d3df1c456342270fc87a35da73b6bd4da37ddab268f1696dacdbce5',
    );
    expect(restored.report.fingerprints).toEqual(source.backup.manifest.fingerprints);
    expect(await restored.db.prepare('PRAGMA foreign_key_check').all()).toMatchObject({
      results: [],
    });
    expect(restored.assertPublication).toThrow('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
    for (const table of [
      'agencies',
      'users',
      'agency_memberships',
      'auth_identities',
      'local_credentials',
      'local_sessions',
      'system_audit_events',
      'credential_operation_receipts',
    ]) {
      const sorted = (rows: unknown[]) => rows.map((r) => canonicalizePayload(r)).sort();
      expect(sorted((await restored.db.prepare(`SELECT * FROM ${table}`).all()).results)).toEqual(
        sorted((await source.db.prepare(`SELECT * FROM ${table}`).all()).results),
      );
    }
    expect(
      await restored.db
        .prepare(
          "SELECT must_change_password,temporary_expires_at,credential_version FROM local_credentials WHERE user_id='synthetic-temporary'",
        )
        .first(),
    ).toEqual({
      must_change_password: 1,
      temporary_expires_at: SYNTHETIC_AUTH_TIME + 86400000,
      credential_version: 7,
    });
    expect(
      await restored.db
        .prepare(
          "SELECT must_change_password,temporary_expires_at,credential_version FROM local_credentials WHERE user_id='synthetic-permanent'",
        )
        .first(),
    ).toEqual({ must_change_password: 0, temporary_expires_at: null, credential_version: 7 });
    // Explicit test composition only; no password generation, real KDF or raw tokens.
    const hasher: PasswordHasher = {
      supports: () => true,
      async hash() {
        throw new Error('KDF_FORBIDDEN');
      },
      async verify() {
        return { matches: false, needsRehash: false };
      },
    };
    const app = createApp({ passwordHasher: hasher });
    const response = await app.fetch(new Request('https://panel.mayisigorta.com/api/me'), {
      DB: restored.db,
      APP_ENV: 'test',
      PANEL_ORIGIN: 'https://panel.mayisigorta.com',
      CSRF_SECRET: 'synthetic-test-only-csrf-not-in-backup',
      DOCUMENTS_ENABLED: 'false',
    });
    expect(response.status).toBe(401);
    // Safe LOCAL measurements only; no exported rows or runtime configuration.
    writeFileSync(
      join(tmpdir(), 'mayi-local-auth-restore-timings.json'),
      JSON.stringify({
        classification: 'LOCAL/SYNTHETIC',
        productionRpoAccepted: false,
        productionRtoAccepted: false,
        exportElapsedMs: source.exportElapsedMs,
        restoreElapsedMs: restored.report.restoreElapsedMs,
        verificationElapsedMs: restored.report.verificationElapsedMs,
      }),
    );
  } finally {
    await restored.dispose();
  }
});

it('fresh target repeatability preserves identical fingerprints and never mutates source', async () => {
  const before = (await source.db.prepare('SELECT * FROM local_credentials').all()).results;
  const a = await restoreSyntheticAuthBackup(source.backup);
  try {
    const b = await restoreSyntheticAuthBackup(source.backup);
    try {
      expect(a.db === b.db).toBe(false);
      expect(a.report.fingerprints).toEqual(b.report.fingerprints);
      expect(a.report.schemaHash).toBe(b.report.schemaHash);
    } finally {
      await b.dispose();
    }
  } finally {
    await a.dispose();
  }
  expect((await source.db.prepare('SELECT * FROM local_credentials').all()).results).toEqual(
    before,
  );
});
it('rejects rehashed malformed birthdays and cross-agency reference links', async () => {
  for (const change of [
    (row: Record<string, unknown>) => {
      row.birth_date = '2023-02-29';
    },
    (row: Record<string, unknown>) => {
      row.reference_membership_id = 'absent-reference';
    },
  ])
    await expect(
      restoreSyntheticAuthBackup(
        artifactChange((a) => {
          change(a.data.customers![0]!);
        }, true),
      ),
    ).rejects.toThrow();
});
it('rejects rehashed invalid vehicle snapshots without equating historical data to current vehicle details', async () => {
  for (const change of [
    (a: AuthBackupArtifact) => {
      a.data.customer_vehicles![0]!.normalized_plate = 'WRONG';
    },
    (a: AuthBackupArtifact) => {
      a.data.policy_vehicle_snapshots![0]!.vehicle_version = 999;
    },
    (a: AuthBackupArtifact) => {
      a.data.policy_vehicle_snapshots![0]!.details_json = JSON.stringify({ plate: 'X' });
    },
  ])
    await expect(restoreSyntheticAuthBackup(artifactChange(change, true))).rejects.toThrow();
});
it('manifest is canonical/deterministic and contains hashes only, not credential payloads', () => {
  const m = source.backup.manifest;
  expect(sha(canonicalizePayload(Object.fromEntries(Object.entries(m).reverse())))).toBe(
    source.backup.manifestSha256,
  );
  expect(m.history.map((r) => r.name.slice(0, 4))).toEqual(
    Array.from({ length: 41 }, (_, i) => String(i).padStart(4, '0')),
  );
  expect(JSON.stringify(m)).not.toContain('synthetic-verifier');
  expect(JSON.stringify(m)).not.toContain('a'.repeat(64));
  const a = JSON.parse(source.backup.artifactJson) as AuthBackupArtifact;
  expect(Object.keys(a.data.local_sessions![0]!)).not.toContain('token');
  expect(Object.keys(a.data.local_credentials![0]!)).not.toContain('password');
});
it('independent deterministic synthetic sources produce identical artifact and manifest', async () => {
  // Compare two identical base fixtures, not the operationally extended source.
  const [first, other] = await Promise.all([
    createSyntheticAuthBackup(),
    createSyntheticAuthBackup(),
  ]);
  try {
    expect(other.backup.artifactJson).toBe(first.backup.artifactJson);
    expect(other.backup.manifest).toEqual(first.backup.manifest);
    expect(other.backup.manifestSha256).toBe(first.backup.manifestSha256);
  } finally {
    await first.dispose();
    await other.dispose();
  }
}, 180000);
it('source/target identity confusion is rejected instead of accepting caller-supplied target', async () => {
  await expect(
    restoreSyntheticAuthBackup({
      ...source.backup,
      target: 'synthetic-local-auth-source',
    } as SyntheticAuthBackup),
  ).rejects.toThrow();
});
it('backup artifact hash mismatch fails closed', async () => {
  await expect(
    restoreSyntheticAuthBackup({
      ...source.backup,
      artifactJson: source.backup.artifactJson + ' ',
    }),
  ).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
});
it('manifest hash mismatch fails closed', async () => {
  await expect(
    restoreSyntheticAuthBackup({ ...source.backup, manifestSha256: '0'.repeat(64) }),
  ).rejects.toThrow('MANIFEST_HASH_MISMATCH');
});
it.each(['schema hash', 'missing migration', 'reordered migration history'] as const)(
  '%s fails closed',
  async (kind) => {
    const b = manifestChange((b) => {
      if (kind === 'schema hash') b.manifest.schemaHash = '0'.repeat(64);
      else if (kind === 'missing migration') b.manifest.history.pop();
      else b.manifest.history.reverse();
    });
    await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow();
  },
);
it.each(['missing table', 'changed trigger', 'changed index', 'missing view'] as const)(
  '%s fails closed even with updated artifact hash',
  async (kind) => {
    const b = artifactChange((a) => {
      const type =
        kind === 'missing table'
          ? 'table'
          : kind === 'changed trigger'
            ? 'trigger'
            : kind === 'changed index'
              ? 'index'
              : 'view';
      const i = a.schema.findIndex((r) => r.type === type && r.sql !== null);
      if (kind.startsWith('missing')) a.schema.splice(i, 1);
      else
        a.schema[i]!.sql =
          type === 'trigger'
            ? a.schema[i]!.sql!.replace(
                'BEGIN',
                "BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CORRUPTION');",
              )
            : a.schema[i]!.sql + ' WHERE 0';
    });
    await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow();
  },
);
it.each([
  'verifier',
  'credential_version',
  'must_change_password',
  'temporary_expires_at',
] as const)('corrupted %s fails closed', async (field) => {
  const b = artifactChange((a) => {
    const r = a.data.local_credentials!.find((r) => r.user_id === 'synthetic-temporary')!;
    r[field] =
      field === 'verifier'
        ? 'corrupted-verifier'
        : field === 'must_change_password'
          ? 0
          : Number(r[field]) + 1;
  });
  await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow('DATA_FINGERPRINT_MISMATCH');
});
it.each(['auth_identities', 'agency_memberships', 'local_credentials', 'local_sessions'] as const)(
  'orphan %s fails closed even with recomputed unsigned fingerprints',
  async (table) => {
    const b = artifactChange((a) => {
      a.data[table]![0]!.user_id = 'synthetic-missing-user';
    }, true);
    await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow('DB_FK_FAILED');
  },
);
it('missing audit row fails closed', async () => {
  await expect(
    restoreSyntheticAuthBackup(
      artifactChange((a) => {
        a.data.system_audit_events!.pop();
      }),
    ),
  ).rejects.toThrow('DATA_FINGERPRINT_MISMATCH');
});
it('duplicate protected auth row fails closed even with recomputed fingerprints', async () => {
  await expect(
    restoreSyntheticAuthBackup(
      artifactChange((a) => {
        a.data.local_credentials!.push({ ...a.data.local_credentials![0]! });
      }, true),
    ),
  ).rejects.toThrow();
});
it.each(['plaintext_password', 'raw_session_token'] as const)(
  '%s export field fails closed even with recomputed fingerprints',
  async (field) => {
    const b = artifactChange((a) => {
      a.data.local_credentials![0]![field] = 'synthetic-forbidden-marker';
    }, true);
    await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow();
  },
);
it('foreign key corruption fails closed', async () => {
  await expect(
    restoreSyntheticAuthBackup(
      artifactChange((a) => {
        a.data.credential_operation_receipts![0]!.agency_id = 'synthetic-missing-agency';
      }, true),
    ),
  ).rejects.toThrow('DB_FK_FAILED');
});
it('missing session credential relation fails closed even when declared foreign keys are valid', async () => {
  const result = await restoreSyntheticAuthBackup(
    artifactChange((a) => {
      a.data.local_credentials = a.data.local_credentials!.filter(
        (r) => r.user_id !== 'synthetic-permanent',
      );
    }, true),
  ).then(
    async (r) => {
      await r.dispose();
      return { accepted: true, code: r.report.code };
    },
    (error: Error) => ({ accepted: false, code: error.message }),
  );
  expect(result).toEqual({ accepted: false, code: 'AUTH_RELATION_MISMATCH' });
});
it('publication before reconciliation is denied and fetch is not used by native proof', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  try {
    const r = await restoreSyntheticAuthBackup(source.backup);
    try {
      expect(r.assertPublication).toThrow('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
      expect(r.report.reconciliationRequired).toHaveLength(6);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await r.dispose();
    }
  } finally {
    fetch.mockRestore();
  }
});
async function rejectedRelation(backup: SyntheticAuthBackup) {
  return restoreSyntheticAuthBackup(backup).then(
    async (r) => {
      await r.dispose();
      return { accepted: true, code: r.report.code };
    },
    (error: Error) => ({ accepted: false, code: error.message }),
  );
}
it('receipt actor membership must resolve to the same actor user and agency', async () => {
  const result = await rejectedRelation(
    artifactChange((a) => {
      a.data.credential_operation_receipts![0]!.actor_membership_id =
        'synthetic-membership-permanent';
    }, true),
  );
  expect(result).toEqual({ accepted: false, code: 'AUTH_RELATION_MISMATCH' });
});
it.each(['NORMAL temporary', 'ACTIVATION permanent', 'ACTIVATION expiry'] as const)(
  'retrospective session state rejects %s',
  async (kind) => {
    const result = await rejectedRelation(
      artifactChange((a) => {
        if (kind === 'NORMAL temporary')
          a.data.local_sessions!.find((r) => r.kind === 'ACTIVATION')!.kind = 'NORMAL';
        else if (kind === 'ACTIVATION permanent') {
          const r = a.data.local_sessions!.find(
            (r) => r.kind === 'NORMAL' && r.revoked_at === null,
          )!;
          r.kind = 'ACTIVATION';
          r.recent_password_at = null;
          r.expires_at = Number(r.created_at) + 900000;
        } else
          a.data.local_credentials!.find(
            (r) => r.must_change_password === 1,
          )!.temporary_expires_at = SYNTHETIC_AUTH_TIME + 1;
      }, true),
    );
    expect(result).toEqual({ accepted: false, code: 'AUTH_RELATION_MISMATCH' });
  },
);
it('manifest carries deterministic app version, snapshot timestamp and synthetic bookmark', () => {
  expect(source.backup.manifest).toMatchObject({
    appVersion: '0.1.0',
    createdAt: '2026-09-01T00:00:00.000Z',
    bookmark: 'synthetic-paused-native-export',
  });
});
it.each(['appVersion', 'createdAt', 'bookmark'] as const)(
  'manifest %s is strictly bound and hashed',
  async (field) => {
    const b = manifestChange((b) => {
      (b.manifest as unknown as Record<string, unknown>)[field] = 'unsupported-synthetic-value';
    });
    await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow();
  },
);
it('historical revoked session versions remain forensic state, not live authority', async () => {
  const b = artifactChange((a) => {
    const r = a.data.local_sessions!.find((r) => r.revoked_at !== null)!;
    r.credential_version = 6;
    r.permission_version = 2;
  }, true);
  const restored = await restoreSyntheticAuthBackup(b);
  try {
    expect(
      await restored.db
        .prepare(
          'SELECT credential_version,permission_version FROM local_sessions WHERE revoked_at IS NOT NULL',
        )
        .first(),
    ).toEqual({ credential_version: 6, permission_version: 2 });
    expect(restored.assertPublication).toThrow('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  } finally {
    await restored.dispose();
  }
});
it('receipt actor membership cannot cross agency even when all referenced rows exist', async () => {
  const b = artifactChange((a) => {
    a.data.agencies!.push({
      ...a.data.agencies![0]!,
      id: 'synthetic-other-agency',
      status: 'PROVISIONING',
      bootstrap_completed_at: null,
      activated_at: null,
    });
    a.data.credential_operation_receipts![0]!.agency_id = 'synthetic-other-agency';
  }, true);
  expect(await rejectedRelation(b)).toEqual({ accepted: false, code: 'AUTH_RELATION_MISMATCH' });
});
