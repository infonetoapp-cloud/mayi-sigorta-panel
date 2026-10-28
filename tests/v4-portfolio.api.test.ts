// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDemo, DEMO_ORIGIN, DEMO_USERS } from '../scripts/demo/application';
import { ensureRenewalForPolicy } from '../src/server/renewals/generation';
let demo: Awaited<ReturnType<typeof openDemo>>;
let cookies: string[];
async function get(path: string, actor = 0) {
  return demo.fetch(new Request(DEMO_ORIGIN + path, { headers: { cookie: cookies[actor]! } }));
}
beforeAll(async () => {
  const secrets = DEMO_USERS.map(() => randomUUID() + randomUUID());
  demo = await openDemo(secrets);
  cookies = [];
  for (const [i, u] of DEMO_USERS.entries()) {
    const r = await demo.fetch(
      new Request(DEMO_ORIGIN + '/api/auth/login', {
        method: 'POST',
        headers: { origin: DEMO_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email: u.email, password: secrets[i] }),
      }),
    );
    expect(r.status).toBe(200);
    cookies.push(r.headers.get('set-cookie')!.split(';')[0]!);
  }
  secrets.fill('');
}, 120000);
afterAll(async () => {
  await demo?.dispose();
});
it('projects exact policy identity only on explicit opt-in while preserving the approved customer contract', async () => {
  for (const actor of [0, 1, 2]) {
    const normal = await get('/api/customers/demo-customer-0/renewals', actor);
    expect(normal.status).toBe(200);
    const n = (await normal.json()) as { data: { items: Record<string, unknown>[] } };
    expect(n.data.items.length).toBeGreaterThan(0);
    expect(n.data.items.every((i) => !('policyId' in i))).toBe(true);
    const extended = await get(
      '/api/customers/demo-customer-0/renewals?includePolicyId=true',
      actor,
    );
    expect(extended.status).toBe(200);
    const e = (await extended.json()) as { data: { items: Record<string, unknown>[] } };
    expect(e.data.items.map((i) => i.policyId)).toContain('demo-policy-0');
    expect(JSON.stringify(e)).not.toMatch(/taskId|dueAt|assignee|taskVersion|workload/);
  }
});
it('rejects malformed projection flags rather than broadening the endpoint', async () => {
  for (const flag of ['false', '1', 'TRUE'])
    expect(
      (await get('/api/customers/demo-customer-0/renewals?includePolicyId=' + flag)).status,
    ).toBe(400);
});
it('does not disclose policy identity through cross-tenant or inaccessible customer lookups', async () => {
  for (const actor of [0, 1, 2]) {
    const r = await get('/api/customers/foreign-not-visible/renewals?includePolicyId=true', actor);
    const e = (await r.json()) as { data?: { items: unknown[] } };
    expect(
      r.status === 404 || r.status === 403 || (r.status === 200 && e.data?.items.length === 0),
    ).toBe(true);
  }
});
it('retains bounded server-side policy exact/prefix search and keyset pagination', async () => {
  const exact = await get(
    '/api/policies?search=DEMO&searchMode=exact&pageSize=1&includeLabels=true',
  );
  expect(exact.status).toBe(200);
  const e = (await exact.json()) as { data: { items: unknown[] } };
  expect(e.data.items).toHaveLength(0);
  const first = await get('/api/policies?pageSize=1&includeLabels=true');
  const p = (await first.json()) as { data: { items: { id: string }[]; nextCursor: string } };
  expect(p.data.items).toHaveLength(1);
  expect(p.data.nextCursor).toBeTruthy();
  const second = await get(
    '/api/policies?pageSize=1&includeLabels=true&cursor=' + encodeURIComponent(p.data.nextCursor),
  );
  const s = (await second.json()) as typeof p;
  expect(s.data.items[0]!.id).not.toBe(p.data.items[0]!.id);
});
it('does not turn customer profile authorization into another member private task context', async () => {
  const r = await get('/api/tasks/today?limit=50', 1);
  const e = (await r.json()) as { data: { items: { taskId: string; policyId: string }[] } };
  const t = e.data.items.find((t) => t.policyId === 'demo-policy-0');
  expect(t).toBeTruthy();
  expect((await get('/api/tasks/' + t!.taskId + '/context', 2)).status).toBe(404);
});
it('keeps HEALTH renewal policy IDs hidden even for OWNER without the explicit grant', async () => {
  // Acente İstanbul takvimindedir. UTC gününü kullanmak gece yarısından sonra
  // fixture'ı geçmişte bırakır; yarın seçimi seed/generation sınırını da korur.
  const endDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(
    new Date(Date.now() + 86400000),
  );
  await demo.db.batch([
    demo.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('pv4-health-branch','demo-agency','PV4HEALTH','Sentetik sağlık','HEALTH')",
    ),
    demo.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('pv4-health-product','demo-agency','demo-insurer','pv4-health-branch','PV4HP','Sentetik sağlık ürünü')",
    ),
    demo.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) VALUES('pv4-health-policy','demo-agency','demo-customer-0','demo-insurer','pv4-health-product','pv4-health-branch','demo-payment','demo-member-ahmet','PV4-HEALTH','PV4HEALTH','2026-01-01',?,10000,'TRY','ACTIVE')",
      )
      .bind(endDate),
  ]);
  await ensureRenewalForPolicy(demo.db, 'demo-agency', 'pv4-health-policy');
  expect(
    await demo.db
      .prepare(
        "SELECT count(*) n FROM renewal_opportunities WHERE expiring_policy_id='pv4-health-policy'",
      )
      .first('n'),
  ).toBe(1);
  for (const actor of [0, 1, 2]) {
    const r = await get('/api/customers/demo-customer-0/renewals?includePolicyId=true', actor);
    expect(r.status).toBe(200);
    const e = (await r.json()) as { data: { items: { policyId: string }[] } };
    expect(e.data.items.some((i) => i.policyId === 'pv4-health-policy')).toBe(false);
  }
});
it('rechecks renewal read grant on every opt-in request without changing stored histories', async () => {
  // The preceding cases run with the original grant graph; this mutation is last.
  await demo.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='demo-member-ayse' AND permission_code='renewal.read'",
    )
    .run();
  const r = await get('/api/customers/demo-customer-0/renewals?includePolicyId=true', 2);
  expect(r.status).toBe(403);
});
