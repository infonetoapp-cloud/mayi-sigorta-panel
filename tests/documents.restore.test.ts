// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRestoreFixture, type RestoreFixture } from './support/restore-fixture';
import { explicitSyntheticSnapshotRows } from './support/explicit-synthetic-snapshot';
import { runLocalRestoreProof } from '../scripts/recovery/local-restore-proof';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseRestoreManifest,
  restoreManifestId,
  RESTORE_LIMITS,
  type RestoreManifest,
  type LocalRestoreInput,
} from '../scripts/recovery/local-restore-proof';
import { resolveAuthenticatedUserContext } from '../src/server/auth/identity';
import { createAuthorizationEvaluator } from '../src/server/auth/authorization';
import {
  createR2DocumentBackupAdapter,
  documentBackupObjectKey,
} from '../src/server/documents/backup-storage';
import { parseIdentityCryptoConfig } from '../src/server/security/identity-crypto';

let fixture: RestoreFixture;
beforeAll(async () => {
  fixture = await createRestoreFixture();
}, 180000);
afterAll(async () => {
  await fixture?.dispose();
});

function changeManifest(change: (m: RestoreManifest) => void, input = fixture.input()) {
  const manifest = JSON.parse(input.manifestJson) as RestoreManifest;
  change(manifest);
  return { ...input, manifestJson: JSON.stringify(manifest) };
}
function changeExport(change: (sql: string) => string, input = fixture.input()): LocalRestoreInput {
  const exportSql = explicitSyntheticSnapshotRows(
    change(input.exportSql),
    (JSON.parse(input.manifestJson) as RestoreManifest).createdAt,
  );
  expect(exportSql).not.toBe(input.exportSql);
  const manifest = JSON.parse(input.manifestJson) as RestoreManifest;
  manifest.dbExportSha256 = createHash('sha256').update(exportSql).digest('hex');
  return { ...input, exportSql, manifestJson: JSON.stringify(manifest) };
}
function changeInsert(sql: string, table: string, change: (line: string) => string): string {
  let changed = false;
  const result = sql
    .split('\n')
    .map((line) => {
      if (
        line.startsWith(`INSERT INTO "${table}"`) ||
        line.startsWith(`INSERT INTO ${table}`) ||
        line.startsWith(`INSERT INTO \`${table}\``)
      ) {
        const next = change(line);
        changed ||= next !== line;
        return next;
      }
      return line;
    })
    .join('\n');
  expect(changed, `native export INSERT for ${table}`).toBe(true);
  return result;
}
const sqlText = (text: string) => `'${text.replaceAll("'", "''")}'`;
function insertSnapshot(
  sql: string,
  counts: Record<string, number>,
  input = fixture.input(),
): LocalRestoreInput {
  return changeManifest(
    (m) => {
      for (const [table, count] of Object.entries(counts))
        m.rowCounts[table] = m.rowCounts[table]! + count;
    },
    changeExport((dump) => dump.replace('CREATE TRIGGER', `${sql}\nCREATE TRIGGER`), input),
  );
}
function quoteSnapshot(
  status = 'DRAFT',
  pointer: string | null = 'restore-quote-version',
  withVersion = true,
  installments = 'NULL',
) {
  const q = `INSERT INTO renewal_quotes(id,agency_id,renewal_id,status,current_version_id,created_by_user_id,created_by_membership_id) VALUES('restore-quote','backup-agency','restore-renewal',${sqlText(status)},${pointer === null ? 'NULL' : sqlText(pointer)},'backup-user','backup-member');`;
  const v = `INSERT INTO renewal_quote_versions(id,agency_id,quote_id,version_number,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,created_by_user_id,created_by_membership_id) VALUES('restore-quote-version','backup-agency','restore-quote',1,'restore-insurer','restore-product','restore-branch','restore-payment','2026-10-25','2027-10-24','2026-10-20',25000,'TRY',${installments},'backup-user','backup-member');`;
  return changeManifest(
    (m) => {
      if (withVersion) m.money.quotes.TRY = '25000';
    },
    insertSnapshot(q + (withVersion ? v : ''), {
      renewal_quotes: 1,
      ...(withVersion ? { renewal_quote_versions: 1 } : {}),
    }),
  );
}
async function clonedRow(
  table: string,
  row: Record<string, string | number | null>,
  changes: Record<string, string | number | null>,
) {
  const merged = { ...row, ...changes };
  const columns = (
    await fixture.db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>()
  ).results.map((c) => c.name);
  return `INSERT INTO "${table}"(${columns.map((c) => `"${c}"`).join(',')}) VALUES(${columns.map((c) => (merged[c] === null ? 'NULL' : typeof merged[c] === 'number' ? String(merged[c]) : sqlText(String(merged[c])))).join(',')});`;
}
async function changeColumns(
  table: string,
  changes: Record<string, string>,
  where: Record<string, string> = {},
  input = fixture.input(),
): Promise<LocalRestoreInput> {
  const columns = (
    await fixture.db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>()
  ).results;
  return changeExport(
    (sql) =>
      changeInsert(sql, table, (line) => {
        const start = line.indexOf('VALUES(') + 7,
          end = line.lastIndexOf(')');
        expect(start).toBeGreaterThan(6);
        const body = line.slice(start, end);
        const values = body.match(/'(?:[^']|'')*'|NULL|-?\d+(?:\.\d+)?/gu)!;
        expect(values.join(',')).toBe(body);
        expect(values.length).toBe(columns.length);
        if (
          Object.entries(where).some(
            ([column, value]) => values[columns.findIndex((c) => c.name === column)] !== value,
          )
        )
          return line;
        for (const [column, value] of Object.entries(changes)) {
          const index = columns.findIndex((c) => c.name === column);
          expect(index).toBeGreaterThanOrEqual(0);
          values[index] = value;
        }
        return line.slice(0, start) + values.join(',') + line.slice(end);
      }),
    input,
  );
}
async function wonSnapshot() {
  const time = sqlText((JSON.parse(fixture.input().manifestJson) as RestoreManifest).createdAt);
  let input = insertSnapshot(
    `INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,actor_membership_id,reason_code,created_at) VALUES('restore-won-history','backup-agency','restore-renewal','CONTACT_PENDING','WON','USER','backup-user','backup-member','WON',${time});`,
    { renewal_state_history: 1 },
  );
  input = await changeColumns(
    'renewal_opportunities',
    { state: sqlText('WON'), closed_at: time, closed_by_membership_id: sqlText('backup-member') },
    {},
    input,
  );
  return changeColumns(
    'tasks',
    {
      status: sqlText('COMPLETED'),
      completed_at: time,
      completed_by_membership_id: sqlText('backup-member'),
    },
    {},
    input,
  );
}
async function correctedResultCurrency(input = fixture.input()) {
  const updated = await changeColumns(
    'policies',
    {
      currency: sqlText('EUR'),
      updated_at: sqlText((JSON.parse(input.manifestJson) as RestoreManifest).createdAt),
    },
    { id: sqlText('restore-new') },
    input,
  );
  return changeManifest((m) => {
    m.money.policies = { TRY: '10000', EUR: '10000' };
  }, updated);
}
async function supersessionSnapshot(
  mode: 'valid' | 'active-previous' | 'wrong-renewal' | 'wrong-policy' | 'cycle',
) {
  const [policy, renewal, history, task, link] = await Promise.all(
    [
      ['policies', 'restore-new'],
      ['renewal_opportunities', 'restore-renewal'],
      ['renewal_state_history', 'restore-history'],
      ['tasks', 'restore-task'],
      ['renewal_policy_links', 'restore-link'],
    ].map(([table, id]) =>
      fixture.db
        .prepare(`SELECT * FROM "${table}" WHERE id=?`)
        .bind(id)
        .first<Record<string, string | number | null>>(),
    ),
  );
  const time = (JSON.parse(fixture.input().manifestJson) as RestoreManifest).createdAt;
  const previous = {
    id: 'restore-previous-link',
    renewal_id: mode === 'wrong-renewal' ? 'restore-other-renewal' : 'restore-renewal',
    new_policy_id: mode === 'wrong-policy' ? 'restore-third' : 'restore-new',
    status: 'SUPERSEDED',
    supersedes_link_id:
      mode === 'active-previous' ? 'restore-link' : mode === 'cycle' ? 'restore-cycle-link' : null,
    superseded_at: time,
    superseded_by_membership_id: 'backup-member',
    supersede_reason_code: 'ALLOCATION_REPLACED',
    superseded_operation_id: 'restore-chain-operation',
  };
  const sql =
    (await clonedRow('policies', policy!, {
      id: 'restore-third',
      policy_number: 'restore-third',
      normalized_policy_number: 'restore-third',
    })) +
    (await clonedRow('renewal_opportunities', renewal!, {
      id: 'restore-other-renewal',
      expiring_policy_id: 'restore-third',
    })) +
    (await clonedRow('renewal_state_history', history!, {
      id: 'restore-other-history',
      renewal_id: 'restore-other-renewal',
    })) +
    (await clonedRow('tasks', task!, {
      id: 'restore-other-task',
      renewal_id: 'restore-other-renewal',
    })) +
    `INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status) VALUES('restore-chain-operation','backup-agency','backup-user','backup-member','renewal.policy-links.allocate','synthetic-restore-chain',${sqlText('c'.repeat(64))},'IN_PROGRESS');` +
    (await clonedRow('renewal_policy_links', link!, previous)) +
    (mode === 'cycle'
      ? await clonedRow('renewal_policy_links', link!, {
          ...previous,
          id: 'restore-cycle-link',
          supersedes_link_id: 'restore-previous-link',
        })
      : '');
  let input = insertSnapshot(sql, {
    policies: 1,
    renewal_opportunities: 1,
    renewal_state_history: 1,
    tasks: 1,
    operation_receipts: 1,
    renewal_policy_links: mode === 'cycle' ? 2 : 1,
  });
  input = changeManifest((m) => {
    m.money.policies.TRY = (BigInt(m.money.policies.TRY!) + 10000n).toString();
  }, input);
  return changeColumns(
    'renewal_policy_links',
    {
      created_at: sqlText(time),
      supersedes_link_id: mode === 'active-previous' ? 'NULL' : sqlText('restore-previous-link'),
    },
    { id: sqlText('restore-link') },
    input,
  );
}
function queuedDocumentJobSnapshot(
  type: 'DOCUMENT_SCAN' | 'DOCUMENT_BACKUP',
  mode: 'valid' | 'checksum' | 'gap' | 'overlap' | 'queued-attempt',
) {
  const time = sqlText((JSON.parse(fixture.input().manifestJson) as RestoreManifest).createdAt);
  const versionHash = 'd'.repeat(64);
  const inputHash = mode === 'checksum' ? 'e'.repeat(64) : versionHash;
  const job = (id: string, generation: number) =>
    `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,generation,attempt_count,available_at,created_at,updated_at) VALUES(${sqlText(id)},'backup-agency',${sqlText(type)},'restore-queued-version',${sqlText(inputHash)},${generation},${mode === 'queued-attempt' ? 1 : 0},${time},${time},${time});`;
  const sql =
    `INSERT INTO documents(id,agency_id,owner_type,customer_id,created_by_user_id,created_by_membership_id,created_at,updated_at) VALUES('restore-queued-document','backup-agency','CUSTOMER','backup-customer','backup-user','backup-member',${time},${time});` +
    `INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id,created_at,updated_at) VALUES('restore-queued-version','backup-agency','restore-queued-document',1,'quarantine/00000000-0000-0000-0000-000000000090',${sqlText(versionHash)},1,'pending.pdf','application/pdf','backup-user','backup-member',${time},${time});` +
    job('restore-queued-job', mode === 'gap' ? 2 : 1) +
    (mode === 'overlap' ? job('restore-newer-queued-job', 2) : '') +
    (mode === 'queued-attempt'
      ? `INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash,status,started_at,completed_at) VALUES('restore-queued-run','backup-agency','restore-queued-job',1,${sqlText('c'.repeat(64))},'SUCCEEDED',${time},${time});`
      : '');
  return insertSnapshot(sql, {
    documents: 1,
    document_versions: 1,
    background_jobs: mode === 'overlap' ? 2 : 1,
    ...(mode === 'queued-attempt' ? { background_job_runs: 1 } : {}),
  });
}
async function failed(input: LocalRestoreInput, code: string) {
  const report = await runLocalRestoreProof(input);
  expect(report.verdict, JSON.stringify(report)).toBe('FAIL');
  expect(report.code).toBe(code);
  expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  return report;
}

describe('isolated local D1 + private backup object restore proof', () => {
  it.each(['historical-scan', 'historical-structural', 'unscanned-structural'] as const)(
    'rejects raw inspection JSON that D1 rejects without erasing syntax (%s)',
    async (mode) => {
      const current = mode === 'unscanned-structural' ? await createRestoreFixture(true) : fixture;
      try {
        const structural = mode !== 'historical-scan';
        const table = structural ? 'document_versions' : 'document_scan_evidence';
        const field = structural ? 'validation_result' : 'content_inspection_result';
        const canonical = ' { "pageCount" : 1, "valid" : true, "format" : "PDF" } ';
        const input = await changeColumns(
          table,
          structural
            ? {
                validation_version: sqlText('m4-content-inspection-v1'),
                [field]: sqlText(canonical),
              }
            : { [field]: sqlText(canonical) },
          {},
          current.input(),
        );
        expect((await runLocalRestoreProof(input)).verdict).toBe('PASS');
        for (const raw of [
          '{"valid":false,"valid":true,"format":"PDF","pageCount":1}',
          '{"valid":true,"format":"JPEG","format":"PDF","pageCount":1}',
          '{"valid":false,"val\\u0069d":true,"format":"PDF","pageCount":1}',
          '{"valid":true,"format":"PDF","pageCount":1.0}',
        ]) {
          const corrupted = await changeColumns(table, { [field]: sqlText(raw) }, {}, input);
          const report = await failed(corrupted, 'DB_DOMAIN_FAILED');
          expect(report.checks.rows).toBe(true);
          expect(report.checks.domain).toBe(false);
          expect(report.checks.objects).toBe(false);
        }
      } finally {
        if (current !== fixture) await current.dispose();
      }
    },
    300000,
  );
  it.each(['valid-history', 'scan-after-backup', 'latest-invalid-scan'] as const)(
    'preserves historical scan causality despite structural metadata (%s)',
    async (mode) => {
      let input = fixture.input();
      if (mode === 'scan-after-backup') {
        const backupRun = await fixture.db
          .prepare(
            `SELECT r.started_at FROM background_job_runs r JOIN background_jobs j
            ON j.agency_id=r.agency_id AND j.id=r.job_id WHERE j.job_type='DOCUMENT_BACKUP'`,
          )
          .first<{ started_at: string }>();
        const shifted = sqlText(new Date(Date.parse(backupRun!.started_at) + 1).toISOString());
        const scanJob = await fixture.db
          .prepare("SELECT id FROM background_jobs WHERE job_type='DOCUMENT_SCAN'")
          .first<{ id: string }>();
        input = await changeColumns(
          'background_job_runs',
          { started_at: shifted, completed_at: shifted },
          { job_id: sqlText(scanJob!.id) },
          input,
        );
        input = await changeColumns(
          'background_jobs',
          { completed_at: shifted },
          { id: sqlText(scanJob!.id) },
          input,
        );
        input = await changeColumns(
          'document_scan_evidence',
          { scanned_at: shifted, signature_updated_at: shifted },
          {},
          input,
        );
        await failed(input, 'DB_DOMAIN_FAILED');
      } else if (mode === 'latest-invalid-scan') {
        const copy = await fixture.db
          .prepare('SELECT created_at FROM document_backup_copies')
          .first<{ created_at: string }>();
        const later = new Date(Date.parse(copy!.created_at) + 1).toISOString();
        const job = await fixture.db
          .prepare("SELECT * FROM background_jobs WHERE job_type='DOCUMENT_SCAN'")
          .first<Record<string, string | number | null>>();
        const run = await fixture.db
          .prepare('SELECT * FROM background_job_runs WHERE job_id=?')
          .bind(job!.id)
          .first<Record<string, string | number | null>>();
        const evidence = await fixture.db
          .prepare('SELECT * FROM document_scan_evidence WHERE job_run_id=?')
          .bind(run!.id)
          .first<Record<string, string | number | null>>();
        input = insertSnapshot(
          (await clonedRow('background_jobs', job!, {
            id: 'restore-later-scan-job',
            generation: 2,
            created_at: later,
            updated_at: later,
            available_at: later,
            completed_at: later,
          })) +
            (await clonedRow('background_job_runs', run!, {
              id: 'restore-later-scan-run',
              job_id: 'restore-later-scan-job',
              status: 'PERMANENT_ERROR',
              reason_code: 'CONTENT_INVALID',
              started_at: later,
              completed_at: later,
            })) +
            (await clonedRow('document_scan_evidence', evidence!, {
              id: 'restore-later-scan-evidence',
              job_run_id: 'restore-later-scan-run',
              outcome: 'INVALID',
              reason_code: 'CONTENT_INVALID',
              scanned_at: later,
              signature_updated_at: null,
              signature_version: null,
              scanner_engine_version: null,
              content_inspection_version: null,
              content_inspection_result: null,
            })),
          { background_jobs: 1, background_job_runs: 1, document_scan_evidence: 1 },
          input,
        );
        await failed(input, 'DB_DOMAIN_FAILED');
      }
      input = await changeColumns(
        'document_versions',
        {
          validation_version: sqlText('m4-content-inspection-v1'),
          validation_result: sqlText(JSON.stringify({ valid: true, format: 'PDF', pageCount: 1 })),
        },
        {},
        input,
      );
      if (mode !== 'valid-history') {
        const report = await failed(input, 'DB_DOMAIN_FAILED');
        expect(report.checks.rows).toBe(true);
        expect(report.checks.domain).toBe(false);
      } else {
        const report = await runLocalRestoreProof(input);
        expect(report.verdict, JSON.stringify(report)).toBe('PASS');
        expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
      }
    },
    180000,
  );
  it('restores structurally accepted unscanned documents without inventing historical CLEAN', async () => {
    const current = await createRestoreFixture(true);
    try {
      expect(
        await current.db
          .prepare('SELECT count(*) AS count FROM document_scan_evidence')
          .first('count'),
      ).toBe(0);
      const report = await runLocalRestoreProof(current.input());
      expect(report.verdict, JSON.stringify(report)).toBe('PASS');
      expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
      expect(report.objectCount).toBe(1);
      const corrupted = changeExport(
        (sql) =>
          changeInsert(sql, 'document_versions', (line) =>
            line.replace('"pageCount":1', '"pageCount":0'),
          ),
        current.input(),
      );
      expect((await runLocalRestoreProof(corrupted)).code).toBe('DB_DOMAIN_FAILED');
    } finally {
      await current.dispose();
    }
  }, 180000);
  describe.each(['document_scan_evidence', 'document_backup_copies'] as const)(
    'completed job output identity (%s)',
    (table) => {
      it.each(['version', 'checksum'] as const)(
        'rejects contradictory durable %s despite valid foreign keys',
        async (kind) => {
          let input: LocalRestoreInput;
          if (kind === 'version') {
            const version = await fixture.db
              .prepare('SELECT * FROM document_versions')
              .first<Record<string, string | number | null>>();
            input = insertSnapshot(
              await clonedRow('document_versions', version!, {
                id: 'restore-output-other-version',
                version_number: 2,
                object_key: `quarantine/${crypto.randomUUID()}`,
                status: 'PENDING_UPLOAD',
              }),
              { document_versions: 1 },
            );
            input = await changeColumns('documents', { current_version_id: 'NULL' }, {}, input);
            input = await changeColumns(
              table,
              { document_version_id: sqlText('restore-output-other-version') },
              {},
              input,
            );
          } else {
            input = await changeColumns(
              table,
              table === 'document_scan_evidence'
                ? { sha256: sqlText('b'.repeat(64)) }
                : {
                    source_sha256: sqlText('b'.repeat(64)),
                    backup_sha256: sqlText('b'.repeat(64)),
                  },
            );
          }
          const report = await failed(input, 'DB_DOMAIN_FAILED');
          expect(report.checks.foreignKeys).toBe(true);
          expect(report.checks.rows).toBe(true);
          expect(report.checks.objects).toBe(false);
        },
      );
    },
  );
  it.each(['valid-retired', 'DOCUMENT_SCAN', 'DOCUMENT_BACKUP'] as const)(
    'requires immutable output for completed document work (%s)',
    async (type) => {
      let input = await changeColumns('document_versions', { status: sqlText('RETIRED') });
      input = await changeColumns(
        'documents',
        { status: sqlText('ARCHIVED'), current_version_id: 'NULL' },
        {},
        input,
      );
      if (type !== 'valid-retired') {
        const job = await fixture.db
          .prepare('SELECT * FROM background_jobs WHERE job_type=?')
          .bind(type)
          .first<Record<string, string | number | null>>();
        const run = await fixture.db
          .prepare('SELECT * FROM background_job_runs WHERE job_id=?')
          .bind(job!.id)
          .first<Record<string, string | number | null>>();
        const time = (JSON.parse(input.manifestJson) as RestoreManifest).createdAt;
        input = insertSnapshot(
          (await clonedRow('background_jobs', job!, {
            id: 'restore-outputless-job',
            generation: 2,
            created_at: time,
            updated_at: time,
            available_at: time,
            completed_at: time,
          })) +
            (await clonedRow('background_job_runs', run!, {
              id: 'restore-outputless-run',
              job_id: 'restore-outputless-job',
              started_at: time,
              completed_at: time,
            })),
          { background_jobs: 1, background_job_runs: 1 },
          input,
        );
        await failed(input, 'DB_DOMAIN_FAILED');
        return;
      }
      const report = await runLocalRestoreProof(input);
      expect(report.verdict, JSON.stringify(report)).toBe('PASS');
      expect(report.checks.domain).toBe(true);
      expect(report.checks.objects).toBe(true);
      expect(report.objectCount).toBe(1);
    },
  );
  it.each([2, 1])(
    'enforces retry budget after restored completed attempt (max=%s)',
    async (max) => {
      const time = sqlText((JSON.parse(fixture.input().manifestJson) as RestoreManifest).createdAt);
      const input = insertSnapshot(
        `INSERT INTO background_jobs(id,agency_id,job_type,status,attempt_count,max_attempts,created_at,updated_at,available_at) VALUES('restore-retry-budget-job','backup-agency','DOCUMENT_RECONCILE','RETRY_WAIT',1,${max},${time},${time},${time});` +
          `INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash,status,started_at,completed_at) VALUES('restore-retry-budget-run','backup-agency','restore-retry-budget-job',1,${sqlText('f'.repeat(64))},'STALE',${time},${time});`,
        { background_jobs: 1, background_job_runs: 1 },
      );
      if (max === 1) {
        await failed(input, 'DB_DOMAIN_FAILED');
        return;
      }
      const report = await runLocalRestoreProof(input);
      expect(report.verdict, JSON.stringify(report)).toBe('PASS');
      expect(report.checks.domain).toBe(true);
      expect(report.checks.objects).toBe(true);
      expect(report.objectCount).toBe(1);
    },
  );
  it.each([1, 7])('enforces contiguous immutable document revisions (first=%s)', async (number) => {
    const input =
      number === 1
        ? fixture.input()
        : await changeColumns('document_versions', { version_number: String(number) });
    if (number !== 1) {
      await failed(input, 'DB_DOMAIN_FAILED');
      return;
    }
    const report = await runLocalRestoreProof(input);
    expect(report.verdict, JSON.stringify(report)).toBe('PASS');
    expect(report.checks.domain).toBe(true);
    expect(report.checks.objects).toBe(true);
    expect(report.objectCount).toBe(1);
  });
  it.each(['final-actor', 'stale-actor'] as const)(
    'binds same-millisecond reclosure to final causal stage (%s)',
    async (mode) => {
      const time = (JSON.parse(fixture.input().manifestJson) as RestoreManifest).createdAt;
      const [member, link, task] = await Promise.all(
        [
          ['agency_memberships', 'backup-member'],
          ['renewal_policy_links', 'restore-link'],
          ['tasks', 'restore-task'],
        ].map(([table, id]) =>
          fixture.db
            .prepare(`SELECT * FROM "${table}" WHERE id=?`)
            .bind(id)
            .first<Record<string, string | number | null>>(),
        ),
      );
      let input = await changeColumns(
        'renewal_policy_links',
        {
          status: sqlText('SUPERSEDED'),
          superseded_at: sqlText(time),
          superseded_by_membership_id: sqlText('backup-member'),
          supersede_reason_code: sqlText('WON_CORRECTED'),
          superseded_operation_id: sqlText('restore-reclosure-operation'),
        },
        {},
        await wonSnapshot(),
      );
      const history = (id: string, from: string, to: string, reason: string, final = false) =>
        `INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,actor_membership_id,reason_code,created_at) VALUES(${sqlText(id)},'backup-agency','restore-renewal',${sqlText(from)},${sqlText(to)},'USER',${sqlText(final ? 'restore-recloser-user' : 'backup-user')},${sqlText(final ? 'restore-recloser-member' : 'backup-member')},${sqlText(reason)},${sqlText(time)});`;
      input = insertSnapshot(
        "INSERT INTO users(id,status) VALUES('restore-recloser-user','ACTIVE');" +
          (await clonedRow('agency_memberships', member!, {
            id: 'restore-recloser-member',
            user_id: 'restore-recloser-user',
          })) +
          `INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status) VALUES('restore-reclosure-operation','backup-agency','backup-user','backup-member','renewal.policy-links.allocate','restore-reclosure',${sqlText('f'.repeat(64))},'IN_PROGRESS');` +
          (await clonedRow('renewal_policy_links', link!, {
            id: 'restore-reclosure-link',
            supersedes_link_id: 'restore-link',
            allocation_operation_id: 'restore-reclosure-operation',
            created_by_membership_id: 'restore-recloser-member',
            created_at: time,
          })) +
          (await clonedRow('tasks', task!, {
            id: 'restore-reclosure-task',
            status: 'COMPLETED',
            completed_at: time,
            completed_by_membership_id: 'restore-recloser-member',
            created_at: time,
            updated_at: time,
          })) +
          history('restore-reclosure-reopen', 'WON', 'CONTACT_PENDING', 'WON_CORRECTED') +
          history(
            'restore-reclosure-progress',
            'CONTACT_PENDING',
            'QUOTE_PREPARING',
            'STATE_CHANGE',
          ) +
          history('restore-reclosure-final', 'QUOTE_PREPARING', 'WON', 'WON', true),
        {
          users: 1,
          agency_memberships: 1,
          renewal_state_history: 3,
          operation_receipts: 1,
          renewal_policy_links: 1,
          tasks: 1,
        },
        input,
      );
      if (mode === 'stale-actor') {
        await failed(input, 'DB_DOMAIN_FAILED');
        return;
      }
      input = await changeColumns(
        'renewal_opportunities',
        { closed_by_membership_id: sqlText('restore-recloser-member') },
        {},
        input,
      );
      const report = await runLocalRestoreProof(input);
      expect(report.verdict, JSON.stringify(report)).toBe('PASS');
      expect(report.checks.domain).toBe(true);
      expect(report.checks.objects).toBe(true);
      expect(report.objectCount).toBe(1);
    },
  );
  it.each(['valid', 'malformed', 'future', 'wrong-actor'] as const)(
    'binds terminal renewal closure to causal history (%s)',
    async (mode) => {
      let input = await wonSnapshot();
      if (mode === 'wrong-actor') {
        const member = await fixture.db
          .prepare("SELECT * FROM agency_memberships WHERE id='backup-member'")
          .first<Record<string, string | number | null>>();
        input = insertSnapshot(
          "INSERT INTO users(id,status) VALUES('restore-other-user','ACTIVE');" +
            (await clonedRow('agency_memberships', member!, {
              id: 'restore-other-closer',
              user_id: 'restore-other-user',
            })),
          { users: 1, agency_memberships: 1 },
          input,
        );
        input = await changeColumns(
          'renewal_opportunities',
          { closed_by_membership_id: sqlText('restore-other-closer') },
          {},
          input,
        );
      } else if (mode !== 'valid') {
        input = await changeColumns(
          'renewal_opportunities',
          { closed_at: sqlText(mode === 'malformed' ? 'not-a-time' : '2099-01-01T00:00:00.000Z') },
          {},
          input,
        );
      }
      if (mode !== 'valid') {
        await failed(input, 'DB_DOMAIN_FAILED');
        return;
      }
      const report = await runLocalRestoreProof(input);
      expect(report.verdict, JSON.stringify(report)).toBe('PASS');
      expect(report.objectCount).toBe(1);
      expect(report.checks.domain).toBe(true);
      expect(report.checks.objects).toBe(true);
    },
  );
  it.each(['valid', 'older-running', 'overlap'] as const)(
    'binds open job run to only current attempt (%s)',
    async (mode) => {
      const time = sqlText((JSON.parse(fixture.input().manifestJson) as RestoreManifest).createdAt);
      const lease = sqlText('a'.repeat(64));
      const input = insertSnapshot(
        `INSERT INTO background_jobs(id,agency_id,job_type,status,attempt_count,lease_token_hash,lease_expires_at,created_at,updated_at,available_at) VALUES('restore-attempt-job','backup-agency','DOCUMENT_RECONCILE','RUNNING',2,${lease},'2099-01-01T00:00:00.000Z',${time},${time},${time});` +
          `INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash,status,started_at,completed_at) VALUES('restore-attempt-one','backup-agency','restore-attempt-job',1,${sqlText('b'.repeat(64))},${sqlText(mode === 'older-running' ? 'RUNNING' : 'STALE')},${time},${mode === 'older-running' ? 'NULL' : mode === 'overlap' ? sqlText('2099-01-01T00:00:00.000Z') : time});` +
          `INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash,status,started_at) VALUES('restore-attempt-two','backup-agency','restore-attempt-job',2,${lease},'RUNNING',${time});`,
        { background_jobs: 1, background_job_runs: 2 },
      );
      if (mode !== 'valid') {
        await failed(input, 'DB_DOMAIN_FAILED');
        return;
      }
      const report = await runLocalRestoreProof(input);
      expect(report.verdict, JSON.stringify(report)).toBe('PASS');
      expect(report.objectCount).toBe(1);
      expect(report.checks.domain).toBe(true);
      expect(report.checks.objects).toBe(true);
    },
  );
  describe.each(['DOCUMENT_SCAN', 'DOCUMENT_BACKUP'] as const)(
    'evidence-free %s job invariant',
    (type) => {
      it.each(['valid', 'checksum', 'gap', 'overlap', 'queued-attempt'] as const)(
        'verifies immutable job/version binding and generation (%s)',
        async (mode) => {
          const input = queuedDocumentJobSnapshot(type, mode);
          if (mode !== 'valid') {
            await failed(input, 'DB_DOMAIN_FAILED');
            return;
          }
          const report = await runLocalRestoreProof(input);
          expect(report.verdict, JSON.stringify(report)).toBe('PASS');
          expect(report.rowCounts.document_versions).toBe(2);
          expect(report.checks.domain).toBe(true);
          expect(report.checks.objects).toBe(true);
          expect(report.objectCount).toBe(1);
          expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
        },
      );
    },
  );
  it.each(['valid', 'active-previous', 'wrong-renewal', 'wrong-policy', 'cycle'] as const)(
    'verifies immutable allocation supersession graph (%s)',
    async (mode) => {
      const input = await supersessionSnapshot(mode);
      if (mode !== 'valid') {
        await failed(input, 'DB_DOMAIN_FAILED');
        return;
      }
      const report = await runLocalRestoreProof(input);
      expect(report.verdict, JSON.stringify(report)).toBe('PASS');
      expect(report.rowCounts.renewal_policy_links).toBe(2);
      expect(report.money.allocations.TRY).toBe('10000');
      expect(report.checks.domain).toBe(true);
      expect(report.checks.objects).toBe(true);
      expect(report.objectCount).toBe(1);
      expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
    },
  );
  it('preserves superseded historical currency after result policy currency correction', async () => {
    let input = insertSnapshot(
      `INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status) VALUES('restore-supersede-operation','backup-agency','backup-user','backup-member','renewal.policy-links.allocate','synthetic-restore-supersede',${sqlText('b'.repeat(64))},'IN_PROGRESS');`,
      { operation_receipts: 1 },
    );
    input = await changeColumns(
      'renewal_policy_links',
      {
        status: sqlText('SUPERSEDED'),
        superseded_at: sqlText((JSON.parse(input.manifestJson) as RestoreManifest).createdAt),
        superseded_by_membership_id: sqlText('backup-member'),
        supersede_reason_code: sqlText('ALLOCATION_REPLACED'),
        superseded_operation_id: sqlText('restore-supersede-operation'),
      },
      {},
      input,
    );
    input = changeManifest((m) => {
      m.money.allocations = {};
    }, input);
    const baseline = await runLocalRestoreProof(input);
    expect(baseline.verdict, JSON.stringify(baseline)).toBe('PASS');
    const report = await runLocalRestoreProof(await correctedResultCurrency(input));
    expect(report.verdict, JSON.stringify(report)).toBe('PASS');
    expect(report.money.policies).toEqual({ EUR: '10000', TRY: '10000' });
    expect(report.money.allocations).toEqual({});
    expect(report.rowCounts.renewal_policy_links).toBe(1);
    expect(report.checks.domain).toBe(true);
    expect(report.checks.objects).toBe(true);
    expect(report.objectCount).toBe(1);
    expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  });
  it('rejects active allocation currency mismatch despite corrected monetary manifest', async () => {
    await failed(await correctedResultCurrency(), 'DB_DOMAIN_FAILED');
  });
  it('preserves WON history and allocation after result policy cancellation', async () => {
    const won = await wonSnapshot();
    const baseline = await runLocalRestoreProof(won);
    expect(baseline.verdict, JSON.stringify(baseline)).toBe('PASS');
    const input = await changeColumns(
      'policies',
      { status: sqlText('CANCELLED') },
      { id: sqlText('restore-new') },
      won,
    );
    const report = await runLocalRestoreProof(input);
    expect(report.verdict, JSON.stringify(report)).toBe('PASS');
    expect(report.money.allocations.TRY).toBe('10000');
    expect(report.rowCounts.renewal_state_history).toBe(2);
    expect(report.checks.domain).toBe(true);
    expect(report.checks.objects).toBe(true);
    expect(report.objectCount).toBe(1);
    expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  });
  it('preserves WON history and allocation after result policy archival', async () => {
    const input = await changeColumns(
      'policies',
      {
        archived_at: sqlText(
          (JSON.parse(fixture.input().manifestJson) as RestoreManifest).createdAt,
        ),
        archived_by_membership_id: sqlText('backup-member'),
        archive_reason: sqlText('synthetic'),
      },
      { id: sqlText('restore-new') },
      await wonSnapshot(),
    );
    const report = await runLocalRestoreProof(input);
    expect(report.verdict, JSON.stringify(report)).toBe('PASS');
    expect(report.money.allocations.TRY).toBe('10000');
    expect(report.rowCounts.renewal_state_history).toBe(2);
    expect(report.checks.objects).toBe(true);
    expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  });
  it.each(['CANCELLED', 'VOIDED', 'ARCHIVED'] as const)(
    'rejects open-renewal allocation to %s result policy',
    async (lifecycle) => {
      const changes: Record<string, string> =
        lifecycle === 'ARCHIVED'
          ? {
              archived_at: sqlText(
                (JSON.parse(fixture.input().manifestJson) as RestoreManifest).createdAt,
              ),
              archived_by_membership_id: sqlText('backup-member'),
              archive_reason: sqlText('synthetic'),
            }
          : { status: sqlText(lifecycle) };
      await failed(
        await changeColumns('policies', changes, { id: sqlText('restore-new') }),
        'DB_DOMAIN_FAILED',
      );
    },
  );
  it('rejects incomplete WON allocation despite later result policy cancellation', async () => {
    let input = await changeColumns(
      'policies',
      { status: sqlText('CANCELLED') },
      { id: sqlText('restore-new') },
      await wonSnapshot(),
    );
    input = await changeColumns(
      'renewal_policy_links',
      { allocated_new_premium_minor: '9999' },
      {},
      input,
    );
    input = changeManifest((m) => {
      m.money.allocations.TRY = '9999';
    }, input);
    await failed(input, 'DB_DOMAIN_FAILED');
  });
  it.each(['deadline', 'identity'] as const)(
    'returns sealed failure and cleans targets without awaiting stalled source cancellation (%s)',
    async (failure) => {
      const input = fixture.input();
      const entry = parseRestoreManifest(input.manifestJson).objects[0]!;
      const saved = await fixture.backup.get(entry.objectKey);
      const bytes = new Uint8Array(await saved!.arrayBuffer());
      const targets = () =>
        readdirSync(tmpdir())
          .filter((name) => name.startsWith('mayi-sealed-restore-'))
          .sort();
      const before = targets();
      const controller = new AbortController();
      let releaseCancel!: () => void;
      let observeCancel!: () => void;
      let cancellationSettled = false;
      const cancellation = new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
      void cancellation.then(() => {
        cancellationSettled = true;
      });
      const cancelStarted = new Promise<void>((resolve) => {
        observeCancel = resolve;
      });
      const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let observationTimer: ReturnType<typeof setTimeout> | undefined;
      const proof = runLocalRestoreProof({
        ...input,
        backup: {
          get: async (objectKey: string) => {
            expect(objectKey).toBe(entry.objectKey);
            if (failure === 'deadline') deadlineTimer = setTimeout(() => controller.abort(), 20);
            return {
              size: entry.sizeBytes,
              customMetadata: {
                ...saved!.customMetadata,
                ...(failure === 'identity' ? { agencyId: 'other-agency' } : {}),
              },
              body: new ReadableStream<Uint8Array>({
                start(stream) {
                  stream.enqueue(bytes); // Expected bytes, deliberately no EOF.
                },
                cancel() {
                  observeCancel();
                  return cancellation;
                },
              }),
            } as R2ObjectBody;
          },
        } as Pick<R2Bucket, 'get'>,
      });
      try {
        await Promise.race([
          cancelStarted,
          proof.then((report) => {
            throw new Error(`SOURCE_CANCELLATION_NOT_REACHED:${report.code}`);
          }),
        ]);
        const outcome = await Promise.race([
          proof,
          new Promise<null>((resolve) => {
            observationTimer = setTimeout(() => resolve(null), 5000);
          }),
        ]);
        expect(outcome, 'report/target cleanup must not await source cancellation').not.toBeNull();
        if (outcome) {
          expect(outcome.verdict).toBe('FAIL');
          expect(outcome.code).toBe(
            failure === 'deadline' ? 'RESTORE_TIMEOUT' : 'OBJECT_IDENTITY_MISMATCH',
          );
          expect(outcome.checks.schema).toBe(true);
          expect(outcome.checks.domain).toBe(true);
          expect(outcome.checks.objects).toBe(false);
          expect(outcome.objectCount).toBe(0);
          expect(outcome.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
          expect(cancellationSettled).toBe(false);
          expect(targets()).toEqual(before);
        }
      } finally {
        releaseCancel();
        controller.abort();
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (observationTimer) clearTimeout(observationTimer);
        timer.mockRestore();
        await proof;
      }
    },
  );
  it('accepts retired historical backup with original CLEAN and later INFECTED rescan', async () => {
    const inputBase = fixture.input();
    const t = (JSON.parse(inputBase.manifestJson) as RestoreManifest).createdAt;
    const job = await fixture.db
      .prepare("SELECT * FROM background_jobs WHERE job_type='DOCUMENT_SCAN'")
      .first<Record<string, string | number | null>>();
    const run = await fixture.db
      .prepare('SELECT * FROM background_job_runs WHERE job_id=?')
      .bind(job!.id)
      .first<Record<string, string | number | null>>();
    const scan = await fixture.db
      .prepare('SELECT * FROM document_scan_evidence')
      .first<Record<string, string | number | null>>();
    const additions =
      (await clonedRow('background_jobs', job!, {
        id: 'later-scan-job',
        generation: 2,
        created_at: t,
        updated_at: t,
        available_at: t,
        completed_at: t,
      })) +
      (await clonedRow('background_job_runs', run!, {
        id: 'later-scan-run',
        job_id: 'later-scan-job',
        status: 'INFECTED',
        started_at: t,
        completed_at: t,
      })) +
      (await clonedRow('document_scan_evidence', scan!, {
        id: 'later-scan-evidence',
        job_run_id: 'later-scan-run',
        outcome: 'INFECTED',
        scanned_at: t,
        content_inspection_version: null,
        content_inspection_result: null,
      }));
    let input = insertSnapshot(
      additions,
      { background_jobs: 1, background_job_runs: 1, document_scan_evidence: 1 },
      inputBase,
    );
    input = await changeColumns('document_versions', { status: sqlText('RETIRED') }, {}, input);
    input = await changeColumns(
      'documents',
      { status: sqlText('ARCHIVED'), current_version_id: 'NULL' },
      {},
      input,
    );
    const report = await runLocalRestoreProof(input);
    expect(report.verdict, JSON.stringify(report)).toBe('PASS');
  });
  it.each([true, false])(
    'validates actual 0018 early-DEAD backup exception (valid=%s)',
    async (valid) => {
      const source = await fixture.db
        .prepare("SELECT * FROM background_jobs WHERE job_type='DOCUMENT_BACKUP'")
        .first<Record<string, string | number | null>>();
      const run = await fixture.db
        .prepare('SELECT * FROM background_job_runs WHERE job_id=?')
        .bind(source!.id)
        .first<Record<string, string | number | null>>();
      const t = (JSON.parse(fixture.input().manifestJson) as RestoreManifest).createdAt;
      const code = valid ? 'BACKUP_CHECKSUM_MISMATCH' : 'UNRECOGNIZED';
      const extra =
        (await clonedRow('background_jobs', source!, {
          id: 'early-dead',
          generation: 2,
          status: 'DEAD',
          last_error_code: code,
          created_at: t,
          updated_at: t,
          available_at: t,
          completed_at: t,
        })) +
        (await clonedRow('background_job_runs', run!, {
          id: 'early-dead-run',
          job_id: 'early-dead',
          status: 'PERMANENT_ERROR',
          reason_code: code,
          started_at: t,
          completed_at: t,
        }));
      let input = insertSnapshot(extra, { background_jobs: 1, background_job_runs: 1 });
      input = await changeColumns('document_versions', { status: sqlText('RETIRED') }, {}, input);
      input = await changeColumns(
        'documents',
        { status: sqlText('ARCHIVED'), current_version_id: 'NULL' },
        {},
        input,
      );
      const report = await runLocalRestoreProof(input);
      expect(report.verdict, JSON.stringify(report)).toBe(valid ? 'PASS' : 'FAIL');
      if (!valid) expect(report.code).toBe('DB_DOMAIN_FAILED');
    },
  );
  it('rejects VOIDED source policy with open renewal', async () => {
    await failed(
      await changeColumns(
        'policies',
        { status: sqlText('VOIDED') },
        { id: sqlText('restore-old') },
      ),
      'DB_DOMAIN_FAILED',
    );
  });
  it('rejects archived source policy with open renewal', async () => {
    await failed(
      await changeColumns(
        'policies',
        {
          archived_at: sqlText('2026-10-02T00:00:00.000Z'),
          archived_by_membership_id: sqlText('backup-member'),
          archive_reason: sqlText('synthetic'),
        },
        { id: sqlText('restore-old') },
      ),
      'DB_DOMAIN_FAILED',
    );
  });
  it.each(['document_backup_copies', 'system_audit_events'])(
    'rejects completion chronology before own job/run in %s',
    async (table) => {
      await failed(
        await changeColumns(table, { created_at: sqlText('2000-01-01T00:00:00.000Z') }),
        'DB_DOMAIN_FAILED',
      );
    },
  );
  it.each(['DOCUMENT_RECONCILE', 'DOCUMENT_RESTORE'])(
    'rejects runless COMPLETED %s',
    async (type) => {
      const t = sqlText((JSON.parse(fixture.input().manifestJson) as RestoreManifest).createdAt);
      await failed(
        insertSnapshot(
          `INSERT INTO background_jobs(id,agency_id,job_type,status,attempt_count,available_at,created_at,updated_at,completed_at) VALUES('runless-job','backup-agency',${sqlText(type)},'COMPLETED',0,${t},${t},${t},${t});`,
          { background_jobs: 1 },
        ),
        'DB_DOMAIN_FAILED',
      );
    },
  );
  it('rejects retired historical backup without any CLEAN evidence', async () => {
    let input = await changeColumns('document_versions', { status: sqlText('RETIRED') });
    input = await changeColumns(
      'documents',
      { status: sqlText('ARCHIVED'), current_version_id: 'NULL' },
      {},
      input,
    );
    input = changeExport((sql) => changeInsert(sql, 'document_scan_evidence', () => ''), input);
    input = changeManifest((m) => {
      m.rowCounts.document_scan_evidence = 0;
    }, input);
    await failed(input, 'DB_DOMAIN_FAILED');
  });
  it('rejects Quote pointer to missing version', async () => {
    await failed(quoteSnapshot('DRAFT', 'missing-version', false), 'DB_DOMAIN_FAILED');
  });
  it('rejects SENT Quote without SENT event', async () => {
    await failed(quoteSnapshot('SENT'), 'DB_DOMAIN_FAILED');
  });
  it('rejects non-installment QuoteVersion with installments', async () => {
    await failed(quoteSnapshot('DRAFT', 'restore-quote-version', true, '2'), 'DB_DOMAIN_FAILED');
  });
  it('accepts valid DRAFT QuoteVersion and optional NULL installments', async () => {
    const report = await runLocalRestoreProof(quoteSnapshot());
    expect(report.verdict, JSON.stringify(report)).toBe('PASS');
  });
  it('rejects malformed initial history timestamp in actual D1', async () => {
    await failed(
      await changeColumns('renewal_state_history', { created_at: sqlText('not-a-time') }),
      'DB_DOMAIN_FAILED',
    );
  });
  it('verifies same-millisecond causal history in actual restored D1 without UUID sorting', async () => {
    const base = fixture.input();
    const time = sqlText((JSON.parse(base.manifestJson) as RestoreManifest).createdAt);
    let input = changeExport(
      (sql) =>
        changeInsert(
          sql,
          'renewal_state_history',
          (line) =>
            line +
            `\nINSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,actor_membership_id,reason_code,created_at) VALUES ('aa-second','backup-agency','restore-renewal','CONTACTED','QUOTE_PREPARING','USER','backup-user','backup-member','PROGRESS',${time});\nINSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,actor_membership_id,reason_code,created_at) VALUES ('zz-first','backup-agency','restore-renewal','CONTACT_PENDING','CONTACTED','USER','backup-user','backup-member','PROGRESS',${time});`,
        ),
      base,
    );
    input = await changeColumns(
      'renewal_opportunities',
      { state: sqlText('QUOTE_PREPARING') },
      {},
      input,
    );
    input = changeManifest((m) => {
      m.rowCounts.renewal_state_history = 3;
    }, input);
    const report = await runLocalRestoreProof(input);
    expect(report.verdict, JSON.stringify(report)).toBe('PASS');
    expect(report.checks.domain).toBe(true);
  });
  it('rejects cancelled source policy with an open renewal', async () => {
    await failed(
      await changeColumns(
        'policies',
        { status: sqlText('CANCELLED') },
        { id: sqlText('restore-old') },
      ),
      'DB_DOMAIN_FAILED',
    );
  });
  it('rejects job completion before creation and run completion', async () => {
    await failed(
      await changeColumns(
        'background_jobs',
        { completed_at: sqlText('2000-01-01T00:00:00.000Z') },
        { job_type: sqlText('DOCUMENT_BACKUP') },
      ),
      'DB_DOMAIN_FAILED',
    );
  });
  it.each(['INFECTED', 'INVALID', 'ERROR'])(
    'rejects non-CLEAN scan tied to successful run (%s)',
    async (outcome) => {
      let input = await changeColumns('document_scan_evidence', {
        outcome: sqlText(outcome),
        content_inspection_version: 'NULL',
        content_inspection_result: 'NULL',
      });
      input = await changeColumns('document_versions', { status: sqlText('RETIRED') }, {}, input);
      input = await changeColumns(
        'documents',
        { status: sqlText('ARCHIVED'), current_version_id: 'NULL' },
        {},
        input,
      );
      await failed(input, 'DB_DOMAIN_FAILED');
    },
  );
  it('rejects CompanyContact whose parent is an INDIVIDUAL', async () => {
    const input = changeManifest(
      (m) => {
        m.rowCounts.company_contacts = 1;
      },
      changeExport((sql) =>
        sql.replace(
          'CREATE TRIGGER',
          `INSERT INTO company_contacts (id,agency_id,customer_id,first_name,last_name) VALUES ('invalid-company-contact','backup-agency','backup-customer','Synthetic','Contact');\nCREATE TRIGGER`,
        ),
      ),
    );
    await failed(input, 'DB_DOMAIN_FAILED');
  });
  it('rejects non-canonical initial renewal history', async () => {
    await failed(
      await changeColumns('renewal_state_history', { to_state: sqlText('CONTACTED') }),
      'DB_DOMAIN_FAILED',
    );
  });
  it('rejects disconnected historical terminal reopen without closure', async () => {
    const input = changeManifest(
      (m) => {
        m.rowCounts.renewal_state_history = 2;
      },
      changeExport((sql) =>
        changeInsert(
          sql,
          'renewal_state_history',
          (line) =>
            line +
            `\nINSERT INTO renewal_state_history (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at) VALUES ('invalid-history','backup-agency','restore-renewal','WON','CONTACT_PENDING','SYSTEM','BAD','2027-10-03T00:00:00.000Z');`,
        ),
      ),
    );
    await failed(input, 'DB_DOMAIN_FAILED');
  });
  it('restores a native D1 export and exact backup bytes, verifies both, and stays sealed', async () => {
    const report = await runLocalRestoreProof(fixture.input());
    expect(report.verdict, JSON.stringify(report)).toBe('PASS');
    expect(report.code).toBe('VERIFIED_SEALED');
    expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
    expect(report.checks).toEqual(
      expect.objectContaining({
        dbHash: true,
        schema: true,
        foreignKeys: true,
        domain: true,
        objects: true,
        recoveryKeys: true,
      }),
    );
    expect(report.objectCount).toBe(1);
    expect(report.rowCounts.document_versions).toBe(1);
    expect(report.money.policies.TRY).toBe('20000');
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    [
      'completion',
      (m: RestoreManifest) => {
        Reflect.deleteProperty(m, 'completion');
      },
      'MANIFEST_INVALID',
    ],
    [
      'object list',
      (m: RestoreManifest) => {
        Reflect.deleteProperty(m, 'objects');
      },
      'MANIFEST_INVALID',
    ],
    [
      'object count',
      (m: RestoreManifest) => {
        m.expectedObjectCount++;
      },
      'MANIFEST_INVALID',
    ],
    [
      'schema version',
      (m: RestoreManifest) => {
        m.schemaVersion = '0017' as '0020';
      },
      'MANIFEST_INVALID',
    ],
    [
      'duplicate identity',
      (m: RestoreManifest) => {
        m.objects.push({ ...m.objects[0]! });
        m.expectedObjectCount++;
      },
      'MANIFEST_DUPLICATE',
    ],
    [
      'contradictory duplicate',
      (m: RestoreManifest) => {
        m.objects.push({ ...m.objects[0]!, sha256: 'a'.repeat(64) });
        m.expectedObjectCount++;
      },
      'MANIFEST_DUPLICATE',
    ],
    [
      'cross-agency key',
      (m: RestoreManifest) => {
        m.objects[0]!.agencyId = 'other-agency';
      },
      'MANIFEST_OBJECT_IDENTITY',
    ],
  ] as const)('rejects manifest %s', async (_name, change, code) => {
    await failed(changeManifest(change), code);
  });
  it('rejects malformed JSON', async () => {
    await failed({ ...fixture.input(), manifestJson: '{' }, 'MANIFEST_INVALID');
  });
  it('rejects DB export hash mismatch', async () => {
    await failed(
      { ...fixture.input(), exportSql: fixture.exportSql + '\n--changed' },
      'DB_EXPORT_HASH_MISMATCH',
    );
  });
  it('rejects object-only without a DB export', async () => {
    await failed({ ...fixture.input(), exportSql: '' }, 'DB_EXPORT_HASH_MISMATCH');
  });
  it('rejects SQL without the required DB schema', async () => {
    await failed(
      changeExport(() => 'CREATE TABLE synthetic(id TEXT PRIMARY KEY);'),
      'SCHEMA_MISMATCH',
    );
  });
  it('rejects removed current unique/check/trigger schema', async () => {
    await failed(
      changeExport((sql) => sql.replace('CHECK(length(trim("agencies"."id")) > 0)', 'CHECK(1)')),
      'SCHEMA_MISMATCH',
    );
  });
  it('rejects DB-only without required backup bytes (no primary fallback)', async () => {
    await failed(
      { ...fixture.input(), backup: { get: async () => null } as Pick<R2Bucket, 'get'> },
      'OBJECT_MISSING',
    );
  });
  it('rejects an omitted DB-owned manifest entry', async () => {
    await failed(
      changeManifest((m) => {
        m.objects = [];
        m.expectedObjectCount = 0;
      }),
      'DB_OBJECT_MAPPING_MISMATCH',
    );
  });
  it('rejects a manifest entry with no restored DB owner', async () => {
    await failed(
      changeManifest((m) => {
        m.objects[0]!.documentId = 'nonexistent';
      }),
      'DB_OBJECT_MAPPING_MISMATCH',
    );
  });
  it('rejects a valid-shaped but wrong DocumentVersion/key pair', async () => {
    await failed(
      changeManifest((m) => {
        const e = m.objects[0]!;
        e.documentVersionId = 'wrong-version';
        e.objectKey = documentBackupObjectKey(e);
      }),
      'DB_OBJECT_MAPPING_MISMATCH',
    );
  });
  it('rejects a changed checksum with a correspondingly changed key', async () => {
    await failed(
      changeManifest((m) => {
        const e = m.objects[0]!;
        e.sha256 = 'a'.repeat(64);
        e.objectKey = documentBackupObjectKey(e);
      }),
      'DB_OBJECT_MAPPING_MISMATCH',
    );
  });
  it.each(['missing', 'corrupt', 'tenant', 'length'] as const)(
    'rejects actual local R2 %s',
    async (kind) => {
      const e = parseRestoreManifest(fixture.input().manifestJson).objects[0]!;
      const saved = await fixture.backup.get(e.objectKey);
      const original = new Uint8Array(await saved!.arrayBuffer());
      try {
        if (kind === 'missing') await fixture.backup.delete(e.objectKey);
        else {
          const bytes = original.slice();
          if (kind === 'corrupt') bytes[0] = bytes[0]! ^ 1;
          await fixture.backup.put(e.objectKey, kind === 'length' ? bytes.slice(1) : bytes, {
            customMetadata: {
              ...saved!.customMetadata,
              ...(kind === 'tenant' ? { agencyId: 'other-agency' } : {}),
            },
          });
        }
        await failed(
          fixture.input(),
          kind === 'missing'
            ? 'OBJECT_MISSING'
            : kind === 'corrupt'
              ? 'OBJECT_CHECKSUM_MISMATCH'
              : 'OBJECT_IDENTITY_MISMATCH',
        );
      } finally {
        await fixture.backup.put(e.objectKey, original, { customMetadata: saved!.customMetadata });
      }
    },
  );
  it('detects an FK-corrupt export rather than calling syntax import success', async () => {
    const input = changeExport((sql) =>
      changeInsert(sql, 'tasks', (line) => line.replace("'backup-customer'", "'missing-customer'")),
    );
    // Canonical preparation now rejects the invalid graph before target import.
    await failed(input, 'FOREIGN_KEY_INVALID');
  });
  it('detects a logically inconsistent but FK-valid Task assignment', async () => {
    await failed(
      changeExport((sql) =>
        changeInsert(sql, 'tasks', (line) => line.replace("'backup-member'", 'NULL')),
      ),
      'DB_DOMAIN_FAILED',
    );
  });
  it('rejects a dangling non-null current-version pointer after real D1 import', async () => {
    const row = await fixture.db
      .prepare('SELECT current_version_id FROM documents')
      .first<{ current_version_id: string }>();
    await failed(
      changeExport((sql) =>
        changeInsert(sql, 'documents', (line) =>
          line.replace(`'${row!.current_version_id}'`, "'missing-version'"),
        ),
      ),
      'DB_DOMAIN_FAILED',
    );
  });
  it('allows a deliberately sealed null publication pointer with intact version/backup evidence', async () => {
    const row = await fixture.db
      .prepare('SELECT current_version_id FROM documents')
      .first<{ current_version_id: string }>();
    const report = await runLocalRestoreProof(
      changeExport((sql) =>
        changeInsert(sql, 'documents', (line) =>
          line.replace(`'${row!.current_version_id}'`, 'NULL'),
        ),
      ),
    );
    expect(report.verdict, JSON.stringify(report)).toBe('PASS');
    expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  });
  it.each(['before-run', 'after-run', 'before-signature', 'stale-at-scan'] as const)(
    'rejects historical scan interval %s',
    async (kind) => {
      const row = await fixture.db
        .prepare('SELECT scanned_at,signature_updated_at FROM document_scan_evidence')
        .first<{ scanned_at: string; signature_updated_at: string }>();
      const old =
        kind === 'before-signature' || kind === 'stale-at-scan'
          ? row!.signature_updated_at
          : row!.scanned_at;
      const replacement =
        kind === 'before-run' || kind === 'stale-at-scan'
          ? '2000-01-01T00:00:00.000Z'
          : '2099-01-01T00:00:00.000Z';
      await failed(
        changeExport((sql) =>
          changeInsert(sql, 'document_scan_evidence', (line) =>
            line.replace(`'${old}'`, `'${replacement}'`),
          ),
        ),
        'DB_DOMAIN_FAILED',
      );
    },
  );
  it.each(['start-before-job', 'end-before-start'] as const)(
    'rejects backup run chronology %s without relying on scan-evidence checks',
    async (kind) => {
      const row = await fixture.db
        .prepare(
          "SELECT r.started_at,r.completed_at FROM background_job_runs r JOIN background_jobs j ON j.id=r.job_id WHERE j.job_type='DOCUMENT_BACKUP'",
        )
        .first<{ started_at: string; completed_at: string }>();
      const old = kind === 'start-before-job' ? row!.started_at : row!.completed_at;
      await failed(
        changeExport((sql) =>
          changeInsert(sql, 'background_job_runs', (line) =>
            line.replace(`'${old}'`, "'2000-01-01T00:00:00.000Z'"),
          ),
        ),
        'DB_DOMAIN_FAILED',
      );
    },
  );
  it('validates historical intervals without imposing present-day scanner freshness on a sealed snapshot', async () => {
    const input = changeExport((sql) =>
      sql.replace(
        /'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z'/gu,
        (stamp) =>
          `'${new Date(Date.parse(stamp.slice(1, -1)) - 30 * 24 * 60 * 60 * 1000).toISOString()}'`,
      ),
    );
    const report = await runLocalRestoreProof(input);
    expect(report.verdict, JSON.stringify(report)).toBe('PASS');
    expect(report.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  });
  it('detects malformed historical CLEAN inspection evidence after trigger-free import', async () => {
    await failed(
      changeExport((sql) =>
        changeInsert(sql, 'document_scan_evidence', (line) =>
          line.replace('"valid":true', '"valid":false'),
        ),
      ),
      'DB_DOMAIN_FAILED',
    );
  });
  it('detects a run attempt number outside its job history despite matching run counts', async () => {
    await failed(
      changeExport((sql) =>
        changeInsert(sql, 'background_job_runs', (line) =>
          line.replace(/,1,'([0-9a-f]{64})'/u, ",2,'$1'"),
        ),
      ),
      'DB_DOMAIN_FAILED',
    );
  });
  it('fails closed on an already expired proof deadline before touching any target', async () => {
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    try {
      await failed(fixture.input(), 'RESTORE_TIMEOUT');
    } finally {
      timer.mockRestore();
    }
  });
  it('detects RenewalPolicyLink allocation overflow even with updated monetary manifest', async () => {
    const input = changeExport((sql) =>
      changeInsert(sql, 'renewal_policy_links', (line) => line.replace(',10000,', ',10001,')),
    );
    const m = JSON.parse(input.manifestJson) as RestoreManifest;
    m.money.allocations.TRY = '10001';
    await failed({ ...input, manifestJson: JSON.stringify(m) }, 'DB_DOMAIN_FAILED');
  });
  it('detects a monetary-total mismatch', async () => {
    await failed(
      changeManifest((m) => {
        m.money.policies.TRY = '19999';
      }),
      'DB_MONEY_MISMATCH',
    );
  });
  it('detects a row-count mismatch', async () => {
    await failed(
      changeManifest((m) => {
        m.rowCounts.customers = 2;
      }),
      'DB_ROW_COUNT_MISMATCH',
    );
  });
  it.each([
    'identity_type',
    'identity_ciphertext',
    'identity_iv',
    'identity_tag',
    'identity_search_hash',
    'identity_key_version',
  ] as const)(
    'rejects partial identity envelope missing %s even without recovery keys',
    async (field) => {
      const input = await changeColumns('customers', { [field]: 'NULL' });
      await failed({ ...input, recoveryKeys: new Map() }, 'IDENTITY_ENVELOPE_INVALID');
    },
  );
  it('rejects identity type inconsistent with Customer type before key recovery', async () => {
    await failed(
      await changeColumns('customers', { identity_type: sqlText('VKN') }),
      'IDENTITY_ENVELOPE_INVALID',
    );
  });
  it('allows completely absent optional identity without claiming recovery keys exist', async () => {
    const input = await changeColumns(
      'customers',
      Object.fromEntries(
        [
          'identity_type',
          'identity_ciphertext',
          'identity_iv',
          'identity_tag',
          'identity_search_hash',
          'identity_key_version',
        ].map((k) => [k, 'NULL']),
      ),
    );
    const result = await runLocalRestoreProof({ ...input, recoveryKeys: new Map() });
    expect(result.verdict, JSON.stringify(result)).toBe('PASS');
    expect(result.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  });
  it('rejects installments on a non-installment payment method', async () => {
    await failed(await changeColumns('policies', { installment_count: '2' }), 'DB_DOMAIN_FAILED');
  });
  it.each(['loss_reason_id', 'loss_reason_notes', 'void_reason_code'] as const)(
    'rejects non-terminal history with %s',
    async (field) => {
      await failed(
        await changeColumns('renewal_state_history', { [field]: sqlText('INVALID_EVIDENCE') }),
        'DB_DOMAIN_FAILED',
      );
    },
  );
  it.each([
    ['correlation_id', 'missing-run'],
    ['idempotency_key', 'missing-job'],
    ['target_id', 'missing-version'],
    ['system_actor_code', 'wrong-actor'],
    ['outcome', 'FAILURE'],
    ['reason_code', 'WRONG_REASON'],
  ] as const)('rejects backup completion audit with incorrect %s', async (field, value) => {
    await failed(
      await changeColumns('system_audit_events', { [field]: sqlText(value) }),
      'DB_DOMAIN_FAILED',
    );
  });
  it('rejects contradictory backup audit metadata', async () => {
    const row = await fixture.db
      .prepare('SELECT metadata_json FROM system_audit_events')
      .first<{ metadata_json: string }>();
    const metadata = JSON.parse(row!.metadata_json);
    metadata.generation++;
    await failed(
      await changeColumns('system_audit_events', {
        metadata_json: sqlText(JSON.stringify(metadata)),
      }),
      'DB_DOMAIN_FAILED',
    );
  });
  it('rejects a backup copy without required completion audit even with corrected row counts', async () => {
    const input = changeExport((sql) =>
      sql
        .split('\n')
        .filter((line) => !line.startsWith('INSERT INTO "system_audit_events"'))
        .join('\n'),
    );
    const manifest = JSON.parse(input.manifestJson) as RestoreManifest;
    manifest.rowCounts.system_audit_events = 0;
    await failed({ ...input, manifestJson: JSON.stringify(manifest) }, 'DB_DOMAIN_FAILED');
  });
  it('fails closed without required recovery-key version', async () => {
    await failed({ ...fixture.input(), recoveryKeys: new Map() }, 'RECOVERY_KEY_MISSING');
  });
  it('fails closed for wrong AES recovery key despite correct key_version', async () => {
    const keys = parseIdentityCryptoConfig({
      IDENTITY_ENCRYPTION_KEY: '33'.repeat(32),
      IDENTITY_HMAC_KEY: '22'.repeat(32),
      IDENTITY_KEY_VERSION: 1,
    });
    await failed(
      { ...fixture.input(), recoveryKeys: new Map([[1, keys]]) },
      'RECOVERY_KEY_INVALID',
    );
  });
  it('fails closed for missing search/HMAC recovery material', async () => {
    const original = fixture.input().recoveryKeys!.get(1)!;
    const keys = parseIdentityCryptoConfig({
      IDENTITY_ENCRYPTION_KEY: Buffer.from(original.encryptionKey).toString('hex'),
      IDENTITY_HMAC_KEY: '33'.repeat(32),
      IDENTITY_KEY_VERSION: 1,
    });
    await failed(
      { ...fixture.input(), recoveryKeys: new Map([[1, keys]]) },
      'RECOVERY_KEY_INVALID',
    );
  });
  it('repeated exact proof has stable canonical identity/results and never replays changed input', async () => {
    const a = await runLocalRestoreProof(fixture.input());
    const b = await runLocalRestoreProof(fixture.input());
    const facts = ({ startedAt: _s, endedAt: _e, durationMs: _d, ...rest }: typeof a) => rest;
    expect(a.verdict).toBe('PASS');
    expect(facts(a)).toEqual(facts(b));
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(fixture.input().manifestJson)).reverse()),
    );
    expect(restoreManifestId(reordered)).toBe(a.manifestId);
    const changed = changeManifest((m) => {
      m.money.policies.TRY = '1';
    });
    expect(restoreManifestId(changed.manifestJson)).not.toBe(a.manifestId);
    await failed(changed, 'DB_MONEY_MISMATCH');
  }, 180000);
  it('historical ACTIVE authority does not publish after current canonical identity revocation', async () => {
    const principal = {
      issuer: 'https://synthetic.cloudflareaccess.com',
      subject: 'restore-subject',
      assurance: 'NORMAL',
      expiresAt: 4102444800,
    } as const;
    const context = await resolveAuthenticatedUserContext(fixture.db, principal);
    const evaluator = createAuthorizationEvaluator({ db: fixture.db });
    expect(
      (
        await evaluator.authorize({
          context,
          action: 'customer.read',
          agencyId: 'backup-agency',
          resource: { agencyId: 'backup-agency', id: 'backup-customer' },
        })
      ).decision,
    ).toBe('ALLOW');
    // Current authority is the existing AuthIdentity/User/Membership graph, not a parallel auth model.
    // Keep a separately verified owner identity so the canonical last-owner guard remains intact.
    await fixture.db
      .prepare(
        "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email) VALUES('current-owner-identity','backup-user','https://synthetic.cloudflareaccess.com','current-owner-subject','owner@example.test')",
      )
      .run();
    await fixture.db
      .prepare(
        "UPDATE auth_identities SET status='REVOKED',version=version+1,revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='restore-identity'",
      )
      .run();
    expect(
      (
        await evaluator.authorize({
          context,
          action: 'customer.read',
          agencyId: 'backup-agency',
          resource: { agencyId: 'backup-agency', id: 'backup-customer' },
        })
      ).decision,
    ).toBe('DENY');
    await expect(resolveAuthenticatedUserContext(fixture.db, principal)).rejects.toMatchObject({
      code: 'IDENTITY_REVOKED',
    });
    const restored = await runLocalRestoreProof(fixture.input());
    expect(restored.verdict).toBe('PASS');
    expect(restored.publication).toBe('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
    expect(
      await fixture.db
        .prepare("SELECT status FROM auth_identities WHERE id='restore-identity'")
        .first(),
    ).toEqual({ status: 'REVOKED' });
  });
  it('failure preserves source DB, primary, and backup while the harness owns cleanup only', async () => {
    const before = await fixture.db.prepare('SELECT * FROM customers').all();
    const e = parseRestoreManifest(fixture.input().manifestJson).objects[0]!;
    const version = await fixture.db
      .prepare('SELECT object_key FROM document_versions WHERE id=?')
      .bind(e.documentVersionId)
      .first<{ object_key: string }>();
    const primaryBefore = new Uint8Array(
      await (await fixture.primary.get(version!.object_key))!.arrayBuffer(),
    );
    const backupBefore = new Uint8Array(
      await (await fixture.backup.get(e.objectKey))!.arrayBuffer(),
    );
    await failed({ ...fixture.input(), recoveryKeys: new Map() }, 'RECOVERY_KEY_MISSING');
    expect((await fixture.db.prepare('SELECT * FROM customers').all()).results).toEqual(
      before.results,
    );
    expect(
      new Uint8Array(await (await fixture.primary.get(version!.object_key))!.arrayBuffer()),
    ).toEqual(primaryBefore);
    expect(new Uint8Array(await (await fixture.backup.get(e.objectKey))!.arrayBuffer())).toEqual(
      backupBefore,
    );
    expect(Object.keys(createR2DocumentBackupAdapter(fixture.backup))).toEqual(['createAndVerify']);
    expect(Object.keys(fixture.input().backup)).toEqual(['get']);
  });
  it('rejects oversized export and object manifests before target allocation', async () => {
    await failed(
      { ...fixture.input(), exportSql: ' '.repeat(RESTORE_LIMITS.exportBytes + 1) },
      'EXPORT_INVALID',
    );
    await failed(
      changeManifest((m) => {
        m.objects[0]!.sizeBytes = 20 * 1024 * 1024 + 1;
      }),
      'MANIFEST_INVALID',
    );
  });
});
