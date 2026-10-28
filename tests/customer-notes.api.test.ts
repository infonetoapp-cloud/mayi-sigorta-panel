// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let a: string, b: string, ownerCookie: string;
const customerId = 'notes-customer';
const path = `/api/customers/${customerId}/notes`;
async function post(content: string, key: string = crypto.randomUUID(), cookie = a, extra = {}) {
  return f.request(path, 'POST', cookie, { content, ...extra }, await f.csrf(cookie), {
    'idempotency-key': key,
  });
}
beforeAll(async () => {
  f = await localAuthFixture();
  const owner = await f.seed('notes-owner', 'OWNER');
  for (const id of ['notes-a', 'notes-b']) {
    const employee = await f.seed(id);
    await f.db.batch(
      createOnboardingTemplateGrants('personel').map((grant) =>
        f.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(crypto.randomUUID(), employee.membershipId, grant.permission_code, grant.scope),
      ),
    );
  }
  ownerCookie = (await f.session(owner.id)).cookie;
  a = (await f.session('notes-a')).cookie;
  b = (await f.session('notes-b')).cookie;
  await f.db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES(?,'agency-auth-test','INDIVIDUAL','Ortak Müşteri','Ortak','Müşteri','membership-notes-owner')",
    )
    .bind(customerId)
    .run();
});
afterAll(async () => {
  await f?.mf.dispose();
});
describe('Shared customer notes on real local D1/API', () => {
  it('creates an independent note shared with another employee and attributes it from authenticated identity', async () => {
    const created = await post('  Müşteri öğleden sonra aranmayı tercih ediyor.  ', 'notes-first');
    expect(created.status).toBe(201);
    const data = ((await created.json()) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      content: 'Müşteri öğleden sonra aranmayı tercih ediyor.',
      authorName: 'Synthetic notes-a',
      createdAt: expect.any(String),
    });
    expect(Object.keys(data).sort()).toEqual(['authorName', 'content', 'createdAt', 'id']);
    const history = await f.request(path, 'GET', b);
    expect(history.status).toBe(200);
    expect((await f.request(path, 'GET', ownerCookie)).status).toBe(200);
    expect((await history.json()) as unknown).toMatchObject({
      data: { items: [data], nextCursor: null },
    });
    expect(await f.db.prepare('SELECT count(*) AS count FROM tasks').first()).toEqual({ count: 0 });
    expect(
      await f.db
        .prepare('SELECT assignee_membership_id FROM customers WHERE id=?')
        .bind(customerId)
        .first(),
    ).toEqual({ assignee_membership_id: 'membership-notes-owner' });
  });
  it('retries sequentially and concurrently without duplicate notes, receipts or audit', async () => {
    const first = await post('Tek kayıt.', 'notes-retry');
    expect(first.status).toBe(201);
    const data = ((await first.json()) as { data: unknown }).data;
    const retry = await post('Tek kayıt.', 'notes-retry');
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ data, replayed: true });
    expect((await post('Farklı içerik.', 'notes-retry')).status).toBe(409);
    let arrivals = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.env.DB = new Proxy(f.db, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (arrivals < 2) {
              if (++arrivals === 2) release();
              await barrier;
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let concurrent: Response[];
    try {
      concurrent = await Promise.all([
        post('Eşzamanlı not.', 'notes-race'),
        post('Eşzamanlı not.', 'notes-race'),
      ]);
    } finally {
      f.env.DB = f.db;
    }
    expect(arrivals).toBe(2);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 201]);
    for (const key of ['notes-retry', 'notes-race']) {
      expect(
        await f.db
          .prepare(
            'SELECT count(*) AS count FROM customer_notes n JOIN operation_receipts r ON r.id=n.operation_receipt_id WHERE r.idempotency_key=?',
          )
          .bind(key)
          .first(),
      ).toEqual({ count: 1 });
      expect(
        await f.db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE action='customer.note.created' AND idempotency_key=?",
          )
          .bind(key)
          .first(),
      ).toEqual({ count: 1 });
    }
  });
  it('rejects forged authors, invalid content, missing CSRF and non-JSON or oversized bodies', async () => {
    expect(
      (await post('Sahte yazar', crypto.randomUUID(), a, { authorName: 'Başka Çalışan' })).status,
    ).toBe(400);
    for (const content of ['', '   ', 'x'.repeat(2001), 'not\0içerik'])
      expect((await post(content)).status).toBe(400);
    expect(
      (
        await f.request(path, 'POST', a, { content: 'CSRF yok' }, undefined, {
          'idempotency-key': 'notes-no-csrf',
        })
      ).status,
    ).toBe(403);
    expect((await post('x'.repeat(20000))).status).toBe(413);
  });
  it('denies actual cross-agency readers and writers without revealing notes', async () => {
    const foreign = await f.seed('notes-foreign-owner', 'OWNER', false, 'notes-other-agency');
    const cookie = (await f.session(foreign.id)).cookie;
    expect((await f.request(path, 'GET', cookie)).status).toBe(404);
    expect((await post('Yabancı not', crypto.randomUUID(), cookie)).status).toBe(404);
  });
  it('keeps historical author names after suspension, inactivation and a later display-name change', async () => {
    const authored = await post('Kalıcı tarihsel yazar.', 'notes-historical', b);
    expect(authored.status).toBe(201);
    await f.db
      .prepare(
        "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=?,version=version+1,permission_version=permission_version+1 WHERE id='membership-notes-b'",
      )
      .bind(new Date().toISOString())
      .run();
    expect((await f.request(path, 'GET', b)).status).not.toBe(200);
    await f.db
      .prepare("UPDATE users SET display_name='Değişmiş Ad',version=version+1 WHERE id='notes-b'")
      .run();
    await f.db
      .prepare(
        "UPDATE agency_memberships SET status='INACTIVE',inactivated_at=?,version=version+1,permission_version=permission_version+1 WHERE id='membership-notes-b'",
      )
      .bind(new Date().toISOString())
      .run();
    const history = (
      (await (await f.request(path, 'GET', a)).json()) as {
        data: { items: Array<{ content: string; authorName: string }> };
      }
    ).data;
    expect(
      history.items.find((note) => note.content === 'Kalıcı tarihsel yazar.')?.authorName,
    ).toBe('Synthetic notes-b');
  });
  it('rolls back note and receipt if audit fails and permits a clean same-key retry', async () => {
    await f.db
      .prepare(
        "CREATE TRIGGER notes_fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='customer.note.created' AND NEW.idempotency_key='notes-rollback' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_AUDIT_FAILURE'); END",
      )
      .run();
    try {
      expect((await post('Atomik not.', 'notes-rollback')).status).toBe(500);
      expect(
        await f.db
          .prepare(
            "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='notes-rollback'",
          )
          .first(),
      ).toEqual({ count: 0 });
      expect(
        await f.db
          .prepare("SELECT count(*) AS count FROM customer_notes WHERE content='Atomik not.'")
          .first(),
      ).toEqual({ count: 0 });
    } finally {
      await f.db.prepare('DROP TRIGGER notes_fail_audit').run();
    }
    expect((await post('Atomik not.', 'notes-rollback')).status).toBe(201);
  });
  it('paginates by timestamp and ID with no duplicates and binds cursors to customer and reader', async () => {
    for (let index = 0; index < 3; index++)
      expect((await post(`Sayfalama ${index}`)).status).toBe(201);
    const ids: string[] = [];
    let cursor: string | null = null,
      firstCursor: string | null = null;
    do {
      const response = await f.request(
        `${path}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        a,
      );
      expect(response.status).toBe(200);
      const page = (
        (await response.json()) as {
          data: { items: Array<{ id: string }>; nextCursor: string | null };
        }
      ).data;
      expect(page.items.length).toBeLessThanOrEqual(2);
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      firstCursor ??= cursor;
    } while (cursor);
    const stored = await f.db
      .prepare('SELECT id FROM customer_notes WHERE customer_id=? ORDER BY created_at DESC,id DESC')
      .bind(customerId)
      .all<{ id: string }>();
    expect(ids).toEqual(stored.results.map((row) => row.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      (await f.request(`${path}?cursor=${encodeURIComponent(firstCursor!)}`, 'GET', ownerCookie))
        .status,
    ).toBe(400);
    expect((await f.request(`${path}?limit=51`, 'GET', a)).status).toBe(400);
    expect((await f.request(`${path}?cursor=bad`, 'GET', a)).status).toBe(400);
  });
  it('denies new writes and completed replay after write permission revocation, while read-only history remains accessible', async () => {
    expect((await post('İzni geri alınacak not.', 'notes-revoke')).status).toBe(201);
    const grant = await f.db
      .prepare(
        "SELECT id FROM membership_permissions WHERE membership_id='membership-notes-a' AND permission_code='customer.update'",
      )
      .first<{ id: string }>();
    await f.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(grant!.id).run();
    await f.db
      .prepare(
        "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-notes-a'",
      )
      .run();
    a = (await f.session('notes-a')).cookie;
    try {
      expect((await post('İzni geri alınacak not.', 'notes-revoke')).status).toBe(404);
      expect((await post('Yeni yetkisiz not.')).status).toBe(404);
      const read = await f.request(path, 'GET', a);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ data: { canCreate: false } });
    } finally {
      await f.db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'membership-notes-a','customer.update','AGENCY')",
        )
        .bind(grant!.id)
        .run();
      await f.db
        .prepare(
          "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-notes-a'",
        )
        .run();
      a = (await f.session('notes-a')).cookie;
    }
  });
  it('does not let a customized ASSIGNED customer reader access notes owned by another employee', async () => {
    await f.db
      .prepare(
        "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-notes-a' AND permission_code IN ('customer.read','customer.update')",
      )
      .run();
    await f.db
      .prepare(
        "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-notes-a'",
      )
      .run();
    a = (await f.session('notes-a')).cookie;
    try {
      expect((await f.request(path, 'GET', a)).status).toBe(404);
      expect((await post('Görünmez not.')).status).toBe(404);
    } finally {
      await f.db
        .prepare(
          "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='membership-notes-a' AND permission_code IN ('customer.read','customer.update')",
        )
        .run();
      await f.db
        .prepare(
          "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-notes-a'",
        )
        .run();
      a = (await f.session('notes-a')).cookie;
    }
  });
  it('fails closed on corrupted receipt output and preserves immutable note content', async () => {
    const result = await post('Kanıtlı not.', 'notes-corrupt');
    expect(result.status).toBe(201);
    const note = ((await result.json()) as { data: { id: string } }).data;
    const receipt = await f.db
      .prepare("SELECT response_body FROM operation_receipts WHERE idempotency_key='notes-corrupt'")
      .first<{ response_body: string }>();
    try {
      for (const body of [
        { id: 'not-a-uuid' },
        { id: note.id, authorName: 'Forged' },
        { id: crypto.randomUUID() },
      ]) {
        await f.db
          .prepare(
            "UPDATE operation_receipts SET response_body=? WHERE idempotency_key='notes-corrupt'",
          )
          .bind(JSON.stringify(body))
          .run();
        expect((await post('Kanıtlı not.', 'notes-corrupt')).status).toBe(404);
      }
    } finally {
      await f.db
        .prepare(
          "UPDATE operation_receipts SET response_body=? WHERE idempotency_key='notes-corrupt'",
        )
        .bind(receipt!.response_body)
        .run();
    }
    expect((await post('Kanıtlı not.', 'notes-corrupt')).status).toBe(200);
    await expect(
      f.db
        .prepare('UPDATE customer_notes SET content=? WHERE id=?')
        .bind('Değişiklik', note.id)
        .run(),
    ).rejects.toThrow('CUSTOMER_NOTE_IMMUTABLE');
    await expect(
      f.db.prepare('DELETE FROM customer_notes WHERE id=?').bind(note.id).run(),
    ).rejects.toThrow('CUSTOMER_NOTE_IMMUTABLE');
    await expect(
      f.db
        .prepare('INSERT OR REPLACE INTO customer_notes SELECT * FROM customer_notes WHERE id=?')
        .bind(note.id)
        .run(),
    ).rejects.toThrow('CUSTOMER_NOTE_IMMUTABLE');
  });
  it('rechecks permission loss inside the atomic batch and commits no note, receipt or audit', async () => {
    const grant = await f.db
      .prepare(
        "SELECT id FROM membership_permissions WHERE membership_id='membership-notes-a' AND permission_code='customer.update'",
      )
      .first<{ id: string }>();
    let intercepted = false;
    f.env.DB = new Proxy(f.db, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!intercepted) {
              intercepted = true;
              await target
                .prepare('DELETE FROM membership_permissions WHERE id=?')
                .bind(grant!.id)
                .run();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      expect((await post('Yarışta yetki kaybı.', 'notes-revocation-race')).status).toBe(404);
      expect(intercepted).toBe(true);
      expect(
        await f.db
          .prepare(
            "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='notes-revocation-race'",
          )
          .first(),
      ).toEqual({ count: 0 });
      expect(
        await f.db
          .prepare(
            "SELECT count(*) AS count FROM customer_notes WHERE content='Yarışta yetki kaybı.'",
          )
          .first(),
      ).toEqual({ count: 0 });
      expect(
        await f.db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE idempotency_key='notes-revocation-race'",
          )
          .first(),
      ).toEqual({ count: 0 });
    } finally {
      f.env.DB = f.db;
      await f.db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'membership-notes-a','customer.update','AGENCY')",
        )
        .bind(grant!.id)
        .run();
    }
  });

  it.each(['list', 'replay'])(
    'denies %s disclosure when the current session is revoked immediately before the final note read',
    async (mode) => {
      const session = await f.session('notes-a');
      expect((await post('Oturum korumalı.', 'notes-session-' + mode, session.cookie)).status).toBe(
        201,
      );
      const csrf = await f.csrf(session.cookie);
      let intercepted = false;
      f.env.DB = new Proxy(f.db, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes('SELECT n.id,n.content')) return statement;
              const wrap = (value: D1PreparedStatement): D1PreparedStatement =>
                new Proxy(value, {
                  get(stmt, operation) {
                    if (operation === 'bind')
                      return (...bindings: unknown[]) => wrap(stmt.bind(...bindings));
                    if (operation === 'all' || operation === 'first')
                      return async () => {
                        if (!intercepted) {
                          intercepted = true;
                          await target
                            .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
                            .bind(Date.now(), session.hash)
                            .run();
                        }
                        return operation === 'all' ? stmt.all() : stmt.first();
                      };
                    const member = Reflect.get(stmt, operation, stmt);
                    return typeof member === 'function' ? member.bind(stmt) : member;
                  },
                });
              return wrap(statement);
            };
          if (property === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (!intercepted) {
                intercepted = true;
                await target
                  .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
                  .bind(Date.now(), session.hash)
                  .run();
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      try {
        const result =
          mode === 'list'
            ? await f.request(path, 'GET', session.cookie)
            : await f.request(path, 'POST', session.cookie, { content: 'Oturum korumalı.' }, csrf, {
                'idempotency-key': 'notes-session-' + mode,
              });
        expect(intercepted).toBe(true);
        expect(result.status).not.toBe(200);
        expect(result.status).not.toBe(201);
        expect(await result.text()).not.toContain('Oturum korumalı.');
      } finally {
        f.env.DB = f.db;
      }
    },
  );

  it('allows archived history and exact completed retry but no new archived-customer writes', async () => {
    expect((await post('Arşiv öncesi.', 'notes-before-archive')).status).toBe(201);
    await f.db
      .prepare(
        "UPDATE customers SET archived_at=?,archived_by_membership_id='membership-notes-owner',archive_reason_code='DUPLICATE',version=version+1 WHERE id=?",
      )
      .bind(new Date().toISOString(), customerId)
      .run();
    expect((await f.request(path, 'GET', a)).status).toBe(200);
    expect((await post('Arşiv öncesi.', 'notes-before-archive')).status).toBe(200);
    expect((await post('Arşiv sonrası.', 'notes-after-archive')).status).toBe(404);
    expect(
      await f.db
        .prepare("SELECT count(*) AS count FROM customer_notes WHERE content='Arşiv sonrası.'")
        .first(),
    ).toEqual({ count: 0 });
  });
});
