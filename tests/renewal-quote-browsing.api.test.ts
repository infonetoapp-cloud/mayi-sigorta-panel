import {
  createRenewalQuote,
  createRenewalQuoteVersion,
  sendRenewalQuote,
} from '../src/server/renewals/engagement';
import { resolveAuthenticatedUserContext } from '../src/server/auth/identity';
// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {},
  root = '/api/renewals/qb-r/quotes';
type Result = {
  operationId: string;
  quoteId: string;
  quoteVersionId: string;
  versionNumber: number;
};
type Row = {
  id: string;
  current_version_id: string;
  versionCount: number;
  versions: { id: string; version_number: number }[];
  events: { id: string; quote_version_id: string; operation_receipt_id: string }[];
};
type Page = {
  quotes: Row[];
  hasMore: boolean;
  nextCursor: string | null;
  historyMode: string;
  defaultVersion: Record<string, unknown>;
};
const results: Result[] = [];
let selected: Result;
let writeContext: Awaited<ReturnType<typeof resolveAuthenticatedUserContext>>;
async function get(path: string, who = 'qb-owner') {
  return f.request(path, 'GET', cookies[who]);
}
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status, await r.clone().text()).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
// Fixture generation uses actual atomic domain commands once the fixture identity is resolved.
// All measured browse/history/permission requests below still pass through the real HTTP routes.
async function seedWrite(path: string, body: unknown): Promise<Result> {
  const key = crypto.randomUUID();
  return (
    path.endsWith('/send')
      ? await sendRenewalQuote(writeContext, f.db, 'qb-r', selected.quoteId, body, key)
      : path.endsWith('/versions')
        ? await createRenewalQuoteVersion(writeContext, f.db, 'qb-r', selected.quoteId, body, key)
        : await createRenewalQuote(writeContext, f.db, 'qb-r', body, key)
  ).data;
}
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('qb-owner', 'OWNER');
  await f.seed('qb-reader');
  await f.seed('qb-foreign', 'OWNER', false, 'qb-other');
  for (const code of ['customer.read', 'policy.read', 'renewal.read', 'quote.read'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-qb-reader', code, 'AGENCY')
      .run();
  for (const who of ['qb-owner', 'qb-reader', 'qb-foreign'])
    cookies[who] = (await f.session(who)).cookie;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('qb-c','agency-auth-test','INDIVIDUAL','Örnek Müşteri','Örnek','Müşteri','membership-qb-owner')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('qb-i','agency-auth-test','QB','Anadolu Sigorta')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('qb-b','agency-auth-test','QB','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('qb-p','agency-auth-test','qb-i','qb-b','QB','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('qb-m','agency-auth-test','QB','Nakit')",
    ),
    f.db.prepare(
      "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('qb-policy','agency-auth-test','qb-c','qb-i','qb-p','qb-b','qb-m','membership-qb-owner','QB-001','QB001','2026-01-01','2027-01-10',1250050,'TRY')",
    ),
    f.db.prepare(
      "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id) VALUES('qb-r','agency-auth-test','qb-policy','membership-qb-owner')",
    ),
  ]);
  writeContext = await resolveAuthenticatedUserContext(f.db, {
    issuer: 'urn:mayisigorta:local-auth:v1',
    subject: 'subject-qb-owner',
    assurance: 'NORMAL',
    expiresAt: Date.now() + 600000,
  });
  const defaults = (await data<Page>(await get(root))).defaultVersion;
  for (let i = 0; i < 51; i++) {
    const r = await seedWrite(root, {
      expectedRenewalVersion: 1,
      version: { ...defaults, grossPremiumMinor: 1250000 + i },
    });
    results.push(r);
  }
  selected = results[0]!;
  let current = selected,
    cas = 1;
  for (let i = 0; i < 23; i++) {
    if (i) {
      current = await seedWrite(`${root}/${selected.quoteId}/versions`, {
        expectedQuoteVersion: cas,
        version: { ...defaults, grossPremiumMinor: 1300000 + i },
      });
      results.push(current);
      cas++;
    }
    await seedWrite(`${root}/${selected.quoteId}/send`, {
      expectedQuoteVersion: cas,
      quoteVersionId: current.quoteVersionId,
    });
    cas++;
  }
}, 360000);
afterAll(async () => {
  await f?.mf.dispose();
});
it('reads fifty bounded current summaries in at most six domain queries without private Task access or per-row history reads', async () => {
  const original = f.env.DB,
    reads: string[] = [];
  f.env.DB = {
    prepare(sql: string) {
      if (
        /^\s*SELECT/i.test(sql) &&
        /FROM\s+(?:renewal_quotes|renewal_quote_versions|renewal_quote_events|renewal_opportunities)\b/i.test(
          sql,
        )
      )
        reads.push(sql);
      return original.prepare(sql);
    },
    batch: original.batch.bind(original),
  } as D1Database;
  let response: Response;
  try {
    response = await get(root + '?limit=50', 'qb-reader');
  } finally {
    f.env.DB = original;
  }
  const p = await data<Page>(response!);
  expect(p.quotes).toHaveLength(50);
  expect(p.hasMore).toBe(true);
  expect(p.historyMode).toBe('SUMMARY');
  expect(reads.length).toBeLessThanOrEqual(6);
  expect(p.quotes.every((q) => q.versions.length <= 3 && q.events.length <= 2)).toBe(true);
  expect(JSON.stringify(p)).not.toMatch(/taskId|assignee_membership_id|actor_user_id/);
  const next = await data<Page>(
    await get(root + '?limit=50&cursor=' + encodeURIComponent(p.nextCursor!), 'qb-reader'),
  );
  expect(next.quotes).toHaveLength(1);
  expect(next.hasMore).toBe(false);
  expect(new Set([...p.quotes, ...next.quotes].map((q) => q.id)).size).toBe(51);
  expect(await f.db.prepare('SELECT count(*) n FROM tasks').first()).toEqual({ n: 0 });
});
it('pages immutable versions and events independently without treating a partial page as complete history', async () => {
  for (const kind of ['versions', 'events']) {
    const url = `${root}/${selected.quoteId}/history?kind=${kind}`;
    const first = await data<{ items: { id: string }[]; hasMore: boolean; nextCursor: string }>(
      await get(url),
    );
    expect(first.items).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    const next = await data<{ items: { id: string }[]; hasMore: boolean }>(
      await get(url + '&cursor=' + encodeURIComponent(first.nextCursor)),
    );
    expect(next.items).toHaveLength(3);
    expect(next.hasMore).toBe(false);
    expect(new Set([...first.items, ...next.items].map((r) => r.id)).size).toBe(23);
  }
});
it('resolves exact old revision and receipt proof independently of list and history cursors', async () => {
  const r = results[52]!; // Revision 3 is neither the first nor current revision.
  const summary = await data<Page>(await get(root + '?quoteId=' + r.quoteId));
  expect(summary.quotes[0]!.versions.some((v) => v.id === r.quoteVersionId)).toBe(false);
  const exact = `${root}?quoteId=${r.quoteId}&versionId=${r.quoteVersionId}&operationId=${r.operationId}`;
  const read = await data<Page>(await get(exact));
  expect(read.quotes).toHaveLength(1);
  expect(read.quotes[0]!.versions.some((v) => v.id === r.quoteVersionId)).toBe(true);
  expect((await get(exact.replace(r.operationId, results[1]!.operationId))).status).toBe(404);
  expect((await get(exact.replace(r.quoteVersionId, results[1]!.quoteVersionId))).status).toBe(404);
});
it('binds cursors to actor, parent, kind and page size and keeps cross-agency data inaccessible', async () => {
  const page = await data<Page>(await get(root + '?limit=1'));
  expect(
    (await get(root + '?limit=1&cursor=' + encodeURIComponent(page.nextCursor!), 'qb-reader'))
      .status,
  ).toBe(400);
  expect((await get(root + '?limit=2&cursor=' + encodeURIComponent(page.nextCursor!))).status).toBe(
    400,
  );
  const versions = await data<{ nextCursor: string }>(
    await get(`${root}/${selected.quoteId}/history?kind=versions&limit=1`),
  );
  expect(
    (
      await get(
        `${root}/${selected.quoteId}/history?kind=events&limit=1&cursor=${encodeURIComponent(versions.nextCursor)}`,
      )
    ).status,
  ).toBe(400);
  for (const suffix of ['?limit=51', '?limit=0', '?cursor=broken', '?versionId=missing'])
    expect((await get(root + suffix)).status).toBe(400);
  expect([403, 404]).toContain((await get(root, 'qb-foreign')).status);
  expect([403, 404]).toContain(
    (await get(`${root}/${selected.quoteId}/history`, 'qb-foreign')).status,
  );
  expect((await get(`${root}/missing/history`)).status).toBe(404);
  expect(
    (
      await get(
        `${root}?quoteId=${selected.quoteId}&versionId=${selected.quoteVersionId}&operationId=legacy-opaque-receipt`,
      )
    ).status,
  ).toBe(404);
});
