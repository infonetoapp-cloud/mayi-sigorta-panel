// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import type { RenewalBrowseDetail, RenewalBrowsePage } from '../src/shared/renewal-browsing';
let f: Awaited<ReturnType<typeof localAuthFixture>>, owner: string, member: string, foreign: string;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('browse-owner', 'OWNER');
  await f.seed('browse-member');
  await f.seed('browse-foreign', 'OWNER', false, 'browse-foreign-agency');
  for (const [code, scope] of [
    ['customer.read', 'AGENCY'],
    ['policy.read', 'AGENCY'],
    ['renewal.read', 'AGENCY'],
    ['task.read', 'ASSIGNED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-browse-member', code, scope)
      .run();
  owner = (await f.session('browse-owner')).cookie;
  member = (await f.session('browse-member')).cookie;
  foreign = (await f.session('browse-foreign')).cookie;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id,phone,reference_name) VALUES('browse-c','agency-auth-test','INDIVIDUAL','Işık Örnek','Işık','Örnek','membership-browse-owner','+905550000000','Abdurrahman')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('browse-i','agency-auth-test','BR','Anadolu Sigorta')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('browse-b','agency-auth-test','BR','Kasko','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('browse-h','agency-auth-test','BRH','Özel Sağlık','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('browse-pr','agency-auth-test','browse-i','browse-b','BR','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('browse-phr','agency-auth-test','browse-i','browse-h','BRH','HIDDEN-HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('browse-pay','agency-auth-test','BR','Nakit')",
    ),
    f.db.prepare(
      "INSERT INTO external_customer_references(id,agency_id,customer_id,source_namespace,external_key) VALUES('browse-num','agency-auth-test','browse-c','insurer:browse-i','00012345')",
    ),
  ]);
  for (let i = 0; i < 4; i++) {
    await f.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES(?,'agency-auth-test','browse-c','browse-i',?,?,'browse-pay','membership-browse-owner',?,?,'2026-01-01',?,12345,'TRY')",
      )
      .bind(
        'browse-p' + i,
        i === 3 ? 'browse-phr' : 'browse-pr',
        i === 3 ? 'browse-h' : 'browse-b',
        i === 3 ? 'HIDDEN-HEALTH' : 'POL-' + i,
        'POL' + i,
        '2030-01-0' + (i + 1),
      )
      .run();
    await f.db
      .prepare(
        "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id) VALUES(?,'agency-auth-test',?,'membership-browse-owner')",
      )
      .bind('browse-r' + i, 'browse-p' + i)
      .run();
  }
  await f.db
    .prepare(
      "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,actor_kind) VALUES('HIDDEN-PRIVATE-TASK','agency-auth-test','browse-c','browse-r1','RENEWAL_FOLLOWUP','HIDDEN-PRIVATE-TITLE','2026-11-14T09:00:00.000Z','membership-browse-owner','SYSTEM')",
    )
    .run();
  await f.db
    .prepare(
      "UPDATE renewal_opportunities SET state='VOIDED',void_reason_code='TEST_HISTORY',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),closed_by_membership_id='membership-browse-owner',version=version+1 WHERE id='browse-r2'",
    )
    .run();
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function list(query = '', cookie = member) {
  const r = await f.request('/api/renewals' + query, 'GET', cookie);
  expect(r.status).toBe(200);
  return ((await r.json()) as { data: RenewalBrowsePage }).data;
}
it('lists and opens shared renewals with no Task or another employee private Task without leaking its fields', async () => {
  const page = await list();
  expect(page.items.map((row) => row.id)).toEqual(['browse-r0', 'browse-r1']);
  const tasks = await f.request('/api/tasks/today', 'GET', member);
  expect(tasks.status).toBe(200);
  expect(((await tasks.json()) as { data: { items: unknown[] } }).data.items).toEqual([]);
  for (const id of ['browse-r0', 'browse-r1']) {
    const r = await f.request('/api/renewals/' + id, 'GET', member);
    expect(r.status).toBe(200);
    const data = ((await r.json()) as { data: RenewalBrowseDetail }).data;
    expect(data.insurerCustomerNumber).toBe('00012345');
    expect(data.referenceName).toBe('Abdurrahman');
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/HIDDEN-PRIVATE|taskId|dueAt|primaryTask|assigneeMembershipId/);
  }
});
it('paginates the server dataset in expiry order with filter/actor-bound cursors and date/name filters', async () => {
  const first = await list('?view=ALL&limit=1');
  expect(first.items.map((row) => row.id)).toEqual(['browse-r0']);
  expect(first.nextCursor).toBeTruthy();
  const next = await list('?view=ALL&limit=1&cursor=' + encodeURIComponent(first.nextCursor!));
  expect(next.items.map((row) => row.id)).toEqual(['browse-r1']);
  for (const [query, cookie] of [
    ['?view=OPEN&limit=1', member],
    ['?view=ALL&limit=1', owner],
  ] as const)
    expect(
      (
        await f.request(
          '/api/renewals' + query + '&cursor=' + encodeURIComponent(first.nextCursor!),
          'GET',
          cookie,
        )
      ).status,
    ).toBe(400);
  expect((await list('?from=2030-01-02&to=2030-01-02')).items.map((row) => row.id)).toEqual([
    'browse-r1',
  ]);
  expect((await list('?q=' + encodeURIComponent('IŞIK'))).items).toHaveLength(2);
  expect((await f.request('/api/renewals?limit=51', 'GET', member)).status).toBe(400);
  expect(
    (await f.request('/api/renewals?from=2030-02-01&to=2030-01-01', 'GET', member)).status,
  ).toBe(400);
});
it('keeps closed and archived history readable and excludes inaccessible agency and HEALTH records', async () => {
  expect((await list('?view=CLOSED')).items.map((row) => row.id)).toEqual(['browse-r2']);
  await f.db
    .prepare(
      "UPDATE policies SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),archived_by_membership_id='membership-browse-owner',archive_reason='TEST_HISTORY',version=version+1 WHERE id='browse-p2'",
    )
    .run();
  const read = await f.request('/api/renewals/browse-r2', 'GET', member);
  expect(read.status).toBe(200);
  expect(((await read.json()) as { data: RenewalBrowseDetail }).data).toMatchObject({
    isOpen: false,
    parentArchived: true,
    state: 'VOIDED',
  });
  expect((await list('?view=ALL')).items).toHaveLength(3);
  for (const cookie of [owner, member])
    expect((await f.request('/api/renewals/browse-r3', 'GET', cookie)).status).toBe(404);
  expect((await list('?view=ALL', foreign)).items).toEqual([]);
  expect((await f.request('/api/renewals/browse-r0', 'GET', foreign)).status).toBe(404);
});
it('rechecks ASSIGNED scopes in SQL instead of treating a shared policy or task hint as authority', async () => {
  await f.db
    .prepare(
      "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-browse-member' AND permission_code='customer.read'",
    )
    .run();
  member = (await f.session('browse-member')).cookie;
  expect((await list('?view=ALL')).items).toEqual([]);
  expect((await f.request('/api/renewals/browse-r0', 'GET', member)).status).toBe(404);
});
