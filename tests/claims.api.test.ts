// @vitest-environment node
import { verifyClaimRecovery } from '../scripts/recovery/claim-data-proof';
import { writeClaim } from '../src/server/claims/service';
import { resolveAuthenticatedUserContext } from '../src/server/auth/identity';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { customerCoverageFixture } from './support/customer-coverage-fixture';
import type { ClaimFields, ClaimResult, ClaimDetail, ClaimPage } from '../src/shared/claims';
let f: Awaited<ReturnType<typeof customerCoverageFixture>>,
  serial = 0;
const fields = (): ClaimFields => ({
  lossDate: f.today,
  fileNumber: null,
  expertName: null,
  expertContact: null,
  status: 'WAITING',
  note: null,
});
async function data<T>(r: Response) {
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { data: T }).data;
}
async function write(body: unknown, key = crypto.randomUUID(), cookie = f.owner) {
  return f.request('/api/claims/commands', 'POST', cookie, body, await f.csrf(cookie), {
    'Idempotency-Key': key,
  });
}
async function create(extra: Partial<ClaimFields> = {}, displayName?: string) {
  const n = ++serial,
    c = 'claim-c' + n,
    p = 'claim-p' + n;
  await f.customer(c, undefined, displayName);
  await f.policy(p, c);
  const body = {
    kind: 'CREATE',
    policyId: p,
    customerId: c,
    expectedPolicyVersion: 1,
    fields: { ...fields(), ...extra },
  };
  return { body, result: await data<ClaimResult>(await write(body)) };
}
async function detail(id: string, cookie = f.owner) {
  return data<ClaimDetail>(await f.request('/api/claims/' + id, 'GET', cookie));
}
async function snapshot() {
  const all = [];
  for (const t of [
    'claim_files',
    'claim_history',
    'operation_receipts',
    'audit_events',
    'finance_receivables',
    'finance_entries',
  ])
    all.push((await f.db.prepare('SELECT * FROM ' + t + ' ORDER BY id').all()).results);
  return JSON.stringify(all);
}
beforeAll(async () => {
  f = await customerCoverageFixture();
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
it('persists a retried note with the newer expert and file number intact', async () => {
  const { body, result } = await create();
  const member = await f.editingMember('claim-editor-retry', 'claim');
  const original = { kind: 'UPDATE', claimId: result.claimId, expectedVersion: 1 };
  await data(
    await write({
      ...original,
      fields: {
        ...body.fields,
        fileNumber: 'race-2026-1',
        expertName: 'Yeni eksper',
        note: 'Dosya güncellendi',
      },
    }),
  );
  expect(
    (
      await write(
        { ...original, fields: { ...body.fields, note: 'Telefon görüşmesi' } },
        crypto.randomUUID(),
        member,
      )
    ).status,
  ).toBe(409);
  const { claim } = await detail(result.claimId, member);
  await data(
    await write(
      {
        ...original,
        expectedVersion: claim.version,
        fields: {
          ...body.fields,
          fileNumber: claim.fileNumber,
          expertName: claim.expertName,
          note: 'Telefon görüşmesi',
        },
      },
      crypto.randomUUID(),
      member,
    ),
  );
  const stored = await detail(result.claimId);
  expect(stored.claim).toMatchObject({
    version: 3,
    fileNumber: 'race-2026-1',
    expertName: 'Yeni eksper',
    note: 'Telefon görüşmesi',
  });
});
it('saves an explicit claim and immutable history with exact replay, insurer-number uniqueness and no finance effects', async () => {
  const { body, result } = await create({ fileNumber: '000/2026', expertName: 'Örnek Eksper' });
  const d = await detail(result.claimId);
  expect(d.claim).toMatchObject({
    fileNumber: '000/2026',
    status: 'WAITING',
    expertName: 'Örnek Eksper',
    customerId: body.customerId,
  });
  expect(d.history).toHaveLength(1);
  const update = {
      kind: 'UPDATE',
      claimId: result.claimId,
      expectedVersion: 1,
      fields: { ...body.fields, status: 'COMPLETED', note: 'Dosya sonuçlandı' },
    },
    key = crypto.randomUUID();
  const saved = await data(await write(update, key));
  expect(await data(await write(update, key))).toEqual(saved);
  expect((await detail(result.claimId)).history.map((h) => h.fields.note)).toEqual([
    'Dosya sonuçlandı',
    null,
  ]);
  expect(
    (await f.db.prepare('SELECT count(*) n FROM finance_receivables').first<{ n: number }>())!.n,
  ).toBe(0);
  expect(
    (await write({ ...update, fields: { ...update.fields, note: 'Farklı' } }, key)).status,
  ).toBe(409);
  expect((await write(body)).status).toBe(409);
  await expect(
    f.db.prepare('DELETE FROM claim_history WHERE claim_id=?').bind(result.claimId).run(),
  ).rejects.toThrow('CLAIM_HISTORY_IMMUTABLE');
});
it('rejects invalid or future/out-of-period dates, wrong policyholder, missing notes and missing CSRF without effects', async () => {
  const { body, result } = await create();
  const before = await snapshot();
  for (const lossDate of ['2026-02-30', f.day(1), f.day(-101)])
    expect((await write({ ...body, fields: { ...body.fields, lossDate } })).status).toBe(400);
  expect((await write({ ...body, customerId: 'not-the-policyholder' })).status).toBe(404);
  expect(
    (await write({ kind: 'UPDATE', claimId: result.claimId, expectedVersion: 1, fields: fields() }))
      .status,
  ).toBe(400);
  expect(
    (
      await f.request('/api/claims/commands', 'POST', f.owner, body, undefined, {
        'Idempotency-Key': crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect(await snapshot()).toBe(before);
});
it('does not infer claim authority from customer access and preserves agency, ASSIGNED and historical HEALTH boundaries', async () => {
  const { result } = await create(),
    url = '/api/claims/' + result.claimId;
  expect((await f.request(url, 'GET', f.member)).status).toBe(403);
  await f.db
    .prepare("DELETE FROM membership_permissions WHERE membership_id='membership-coverage-a'")
    .run();
  for (const [code, scope] of [
    ['claim.read', 'UNSCOPED'],
    ['customer.read', 'AGENCY'],
    ['policy.read', 'ASSIGNED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-coverage-a', code, scope)
      .run();
  expect((await f.request(url, 'GET', f.member)).status).toBe(404);
  const own = await detail(result.claimId);
  await f.db
    .prepare(
      "UPDATE customers SET assignee_membership_id='membership-coverage-a',version=version+1 WHERE id=?",
    )
    .bind(own.claim.customerId)
    .run();
  expect((await f.request(url, 'GET', f.member)).status).toBe(200);
  expect(
    (
      await write(
        {
          kind: 'UPDATE',
          claimId: result.claimId,
          expectedVersion: 1,
          fields: { ...fields(), note: 'Güncelleme' },
        },
        crypto.randomUUID(),
        f.member,
      )
    ).status,
  ).toBe(403);
  await f.customer('claim-health-c');
  await f.policy('claim-health-p', 'claim-health-c', 'health');
  const health = {
    kind: 'CREATE',
    policyId: 'claim-health-p',
    customerId: 'claim-health-c',
    expectedPolicyVersion: 1,
    fields: fields(),
  };
  expect((await write(health)).status).toBe(404);
  for (const code of ['sensitive.health.read', 'sensitive.health.write'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-coverage-owner', code, 'UNSCOPED')
      .run();
  const h = await data<ClaimResult>(await write(health));
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-coverage-owner' AND permission_code='sensitive.health.write'",
    )
    .run();
  expect((await detail(h.claimId)).canManage).toBe(false);
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-coverage-owner' AND permission_code='sensitive.health.read'",
    )
    .run();
  await f.db
    .prepare(
      "UPDATE policies SET branch_id='coverage-kasko',product_id='coverage-product-kasko',version=version+1 WHERE id='claim-health-p'",
    )
    .run();
  await f.db
    .prepare(
      "UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='coverage-health'",
    )
    .run();
  expect((await f.request('/api/claims/' + h.claimId, 'GET', f.owner)).status).toBe(404);
  await f.seed('claim-foreign', 'OWNER', false, 'claim-other-agency');
  expect((await f.request(url, 'GET', (await f.session('claim-foreign')).cookie)).status).toBe(404);
});
it('keeps a single concurrent update winner and atomically rolls back if final audit fails', async () => {
  const { result } = await create(),
    cmd = {
      kind: 'UPDATE',
      claimId: result.claimId,
      expectedVersion: 1,
      fields: { ...fields(), status: 'IN_PROGRESS', note: 'Eksper raporu bekleniyor' },
    };
  const rs = await Promise.all([
    write(cmd),
    write({ ...cmd, fields: { ...cmd.fields, note: 'Şirket değerlendirmesi' } }),
  ]);
  expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await detail(result.claimId)).history).toHaveLength(2);
  const before = await snapshot();
  await f.db
    .prepare(
      "CREATE TRIGGER claim_test_audit_fail BEFORE INSERT ON audit_events WHEN NEW.action='claim.update' BEGIN SELECT RAISE(ABORT,'FINAL_AUDIT_FAILED'); END",
    )
    .run();
  try {
    expect((await write({ ...cmd, expectedVersion: 2 })).status).toBe(500);
    expect(await snapshot()).toBe(before);
  } finally {
    await f.db.prepare('DROP TRIGGER claim_test_audit_fail').run();
  }
});
it('uses bounded actor/filter cursors and scoped version readback while keeping archived history read-only', async () => {
  const { result, body } = await create();
  await create();
  const page = await data<ClaimPage>(await f.request('/api/claims?limit=1', 'GET', f.owner));
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).toBeTruthy();
  const cursor = encodeURIComponent(page.nextCursor!);
  expect(
    (await f.request('/api/claims?limit=1&status=COMPLETED&cursor=' + cursor, 'GET', f.owner))
      .status,
  ).toBe(400);
  expect((await f.request('/api/claims?limit=1&cursor=' + cursor, 'GET', f.owner)).status).toBe(
    200,
  );
  expect(
    (await data<ClaimPage>(await f.request('/api/claims?q=claim-p', 'GET', f.owner))).items.length,
  ).toBeGreaterThan(0);
  expect(
    (await data<ClaimPage>(await f.request('/api/claims?q=%25', 'GET', f.owner))).items,
  ).toEqual([]);
  const d = await data<ClaimDetail>(
    await f.request('/api/claims/' + result.claimId + '?verifyVersion=1', 'GET', f.owner),
  );
  expect(d.verifiedHistory?.fields).toEqual(body.fields);
  await f.db
    .prepare(
      "UPDATE policies SET archived_at=?,archived_by_membership_id='membership-coverage-owner',archive_reason='TEST',version=version+1 WHERE id=?",
    )
    .bind(new Date().toISOString(), body.policyId)
    .run();
  expect((await detail(result.claimId)).canManage).toBe(false);
  expect(
    (
      await write({
        kind: 'UPDATE',
        claimId: result.claimId,
        expectedVersion: 1,
        fields: { ...fields(), note: 'Yazma' },
      })
    ).status,
  ).toBe(409);
});

it('rolls back a live permission-version change in the final atomic batch', async () => {
  const { result } = await create();
  await f.seed('claim-race');
  for (const code of ['claim.read', 'claim.manage', 'customer.read', 'policy.read'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        'membership-claim-race',
        code,
        code.startsWith('claim.') ? 'UNSCOPED' : 'AGENCY',
      )
      .run();
  const identity = await f.db
    .prepare("SELECT issuer,subject FROM auth_identities WHERE user_id='claim-race'")
    .first<{ issuer: string; subject: string }>();
  const ctx = await resolveAuthenticatedUserContext(f.db, {
    ...identity!,
    assurance: 'NORMAL',
    expiresAt: Date.now() + 60000,
  });
  const before = await snapshot();
  const db = {
    prepare: f.db.prepare.bind(f.db),
    batch: async (stmts: D1PreparedStatement[]) => {
      await f.db
        .prepare(
          "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-claim-race'",
        )
        .run();
      return f.db.batch(stmts);
    },
  } as D1Database;
  await expect(
    writeClaim(
      db,
      ctx,
      {
        kind: 'UPDATE',
        claimId: result.claimId,
        expectedVersion: 1,
        fields: { ...fields(), note: 'Yarış' },
      },
      crypto.randomUUID(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toBe(before);
});
it('retrospectively verifies strict snapshots and receipt/audit linkage and rejects rehashed historical tampering', async () => {
  const query = async (sql: string) => (await f.db.prepare(sql).all()).results;
  await expect(verifyClaimRecovery(query)).resolves.toBeUndefined();
  const h = await f.db
    .prepare('SELECT id,snapshot_json FROM claim_history LIMIT 1')
    .first<{ id: string; snapshot_json: string }>();
  await f.db.prepare('DROP TRIGGER claim_history_no_update').run();
  try {
    await f.db
      .prepare('UPDATE claim_history SET snapshot_json=? WHERE id=?')
      .bind(
        JSON.stringify({ ...JSON.parse(h!.snapshot_json), note: 'Değiştirilmiş geçmiş' }),
        h!.id,
      )
      .run();
    await expect(verifyClaimRecovery(query)).rejects.toThrow();
  } finally {
    await f.db
      .prepare('UPDATE claim_history SET snapshot_json=? WHERE id=?')
      .bind(h!.snapshot_json, h!.id)
      .run();
  }
});

it('matches a long Turkish and emoji query on D1 without interpreting punctuation as wildcards', async () => {
  const prefix = 'İIŞĞÜÖÇı'.repeat(7) + '😀'.repeat(20);
  const name = prefix + String.raw`%_\Q`;
  const { result } = await create({}, name);
  await create({}, prefix + String.raw`!_\Q`);
  const query = 'iisguoci'.repeat(7) + '😀'.repeat(20) + String.raw`%_\q`;
  for (const q of [query, name, String.raw`%_\q`]) {
    const page = await data<ClaimPage>(
      await f.request('/api/claims?q=' + encodeURIComponent(q), 'GET', f.owner),
    );
    expect(page.items.map((item) => item.id)).toEqual([result.claimId]);
  }
  expect(
    (await f.request('/api/claims?q=' + encodeURIComponent(query + 'z'), 'GET', f.owner)).status,
  ).toBe(400);
});
