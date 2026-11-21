// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';

let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string, viewer: string, foreign: string, caseId: string;
const branchPath = '/api/catalogs/branches';
const validBody = { expectedVersion: 1, reasonCode: 'LEGACY_IMPORT_CLASSIFICATION' };
const membershipId = 'membership-branch-owner';

async function post(path: string, body: unknown, cookie = owner, key = crypto.randomUUID()) {
  return f.request(path, 'POST', cookie, body, await f.csrf(cookie), { 'idempotency-key': key });
}

beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('branch-owner', 'OWNER');
  await f.seed('branch-viewer', 'OWNER');
  await f.seed('branch-foreign', 'OWNER', false, 'branch-other-agency');
  for (const permission of ['sensitive.health.read', 'sensitive.health.write']) {
    for (const membership of [membershipId, 'membership-branch-foreign']) {
      await f.db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,'UNSCOPED')",
        )
        .bind(crypto.randomUUID(), membership, permission)
        .run();
    }
  }
  owner = (await f.session('branch-owner')).cookie;
  viewer = (await f.session('branch-viewer')).cookie;
  foreign = (await f.session('branch-foreign')).cookie;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('bc-legacy','agency-auth-test','BCL','Sentetik Eski Branş')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('bc-race','agency-auth-test','BCR','Sentetik İkinci Branş')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('bc-company','agency-auth-test','BCC','Sentetik Sigorta')",
    ),
  ]);
  const customer = await post('/api/customers', {
    type: 'INDIVIDUAL',
    firstName: 'Sentetik',
    lastName: 'Müşteri',
    insurerNumber: { insurerId: 'bc-company', customerNumber: '000-BRANCH' },
  });
  expect(customer.status).toBe(201);
  const { data } = (await customer.json()) as { data: { id: string } };
  const sale = await post(`/api/customers/${data.id}/sales-cases`, {
    context: 'NEW_BUSINESS',
    branchId: 'bc-legacy',
    cycleDate: null,
    dateBasis: 'MANUAL',
    followup: { dueAt: new Date(Date.now() + 86400000 * 7).toISOString() },
    confirmSimilar: true,
  });
  expect(sale.status, await sale.clone().text()).toBe(201);
  caseId = ((await sale.json()) as { data: { caseId: string } }).data.caseId;
}, 180000);

afterAll(async () => {
  await f?.mf.dispose();
});

it('audits a reasoned versioned correction and protects existing sales without rewriting their classification', async () => {
  const path = `${branchPath}/bc-legacy/correct-classification`;
  const sale = `/api/sales-cases/${caseId}`;
  expect((await f.request(sale, 'GET', viewer)).status).toBe(200);
  for (const [cookie, canCorrectClassification] of [
    [owner, true],
    [viewer, false],
  ] as const) {
    expect(await (await f.request(branchPath, 'GET', cookie)).json()).toMatchObject({
      data: expect.arrayContaining(
        [{ id: 'bc-legacy', dataClassification: 'GENERAL', canCorrectClassification }].map((row) =>
          expect.objectContaining(row),
        ),
      ),
    });
  }
  expect((await post(path, validBody, viewer)).status).toBe(403);
  expect((await post(path, validBody, foreign)).status).toBe(404);
  expect((await post(path, { expectedVersion: 1 })).status).toBe(400);
  expect((await post(path, { ...validBody, expectedVersion: 3 })).status).toBe(409);

  const key = crypto.randomUUID();
  const response = await post(path, validBody, owner, key);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { id: 'bc-legacy', dataClassification: 'HEALTH', version: 2 },
  });
  expect((await post(path, validBody, owner, key)).status).toBe(200);
  expect((await post(path, { ...validBody, expectedVersion: 2 })).status).toBe(409);
  expect((await f.request(sale, 'GET', viewer)).status).toBe(404);
  expect((await f.request(sale, 'GET', owner)).status).toBe(200);
  expect(
    await f.db
      .prepare('SELECT data_classification FROM sales_cases WHERE id=?')
      .bind(caseId)
      .first(),
  ).toEqual({
    data_classification: 'GENERAL',
  });
  const audits = await f.db
    .prepare(
      "SELECT metadata_json FROM audit_events WHERE action='catalog.branch.correct_classification' AND target_id='bc-legacy'",
    )
    .all<{ metadata_json: string }>();
  expect(audits.results.map((row) => JSON.parse(row.metadata_json))).toEqual([
    {
      branchId: 'bc-legacy',
      targetVersion: 2,
      resultCode: 'GENERAL_TO_HEALTH',
      reasonCode: validBody.reasonCode,
    },
  ]);
});

it('rechecks current health permissions inside the write batch and leaves no receipt on denial', async () => {
  const db = f.env.DB;
  const path = `${branchPath}/bc-race/correct-classification`;
  const csrf = await f.csrf(owner);
  const key = crypto.randomUUID();
  let revoked = false;
  f.env.DB = new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!revoked) {
            revoked = true;
            await db
              .prepare(
                "DELETE FROM membership_permissions WHERE membership_id=? AND permission_code='sensitive.health.write'",
              )
              .bind(membershipId)
              .run();
          }
          return db.batch(statements);
        };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const response = await f.request(path, 'POST', owner, validBody, csrf, {
      'idempotency-key': key,
    });
    expect(response.status, await response.clone().text()).toBe(403);
  } finally {
    f.env.DB = db;
  }
  expect(revoked).toBe(true);
  expect(
    await db
      .prepare("SELECT data_classification,version FROM insurance_branches WHERE id='bc-race'")
      .first(),
  ).toEqual({
    data_classification: 'GENERAL',
    version: 1,
  });
  expect(
    await db.prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?').bind(key).first(),
  ).toBeNull();
  expect(
    await db.prepare('SELECT id FROM audit_events WHERE idempotency_key=?').bind(key).first(),
  ).toBeNull();
});
