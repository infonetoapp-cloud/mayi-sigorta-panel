import assert from 'node:assert/strict';
import { openWorkspaceSections } from './workspace-disclosures.mjs';
import { join } from 'node:path';
async function read(page, url) {
  return page.evaluate(async (url) => {
    const r = await globalThis.fetch(url, { cache: 'no-store' });
    if (!r.ok) throw Error('WON_AUTHORIZED_READ_FAILED');
    return (await r.json()).data;
  }, url);
}
async function post(page, url, body) {
  return page.evaluate(
    async ({ url, body }) => {
      const csrf = (await (await globalThis.fetch('/api/csrf-token')).json()).data.token;
      const r = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          'idempotency-key': globalThis.crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, data: (await r.json()).data };
    },
    { url, body },
  );
}
async function selectTask(page) {
  await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
  await page.locator('.today-task-row').first().waitFor();
  const task = (await read(page, '/api/tasks/today?limit=20')).items.find(
    (t) => t.taskVersion === 1,
  );
  assert.ok(task);
  await page
    .locator('.today-task-row')
    .filter({ has: page.getByText(task.policyNumber, { exact: true }) })
    .first()
    .click();
  await openWorkspaceSections(page);
  await page
    .getByRole('button', { name: 'Kazanıldı — mevcut poliçeyi bağla', exact: true })
    .waitFor();
  return task;
}
async function policyFor(page, t, label) {
  const old = await read(page, '/api/policies/' + t.policyId),
    h = await read(page, `/api/renewals/${t.renewalId}/quotes`);
  const p = await post(page, '/api/policies', {
    customerId: t.customerId,
    insurerId: old.insurerId,
    productId: old.productId,
    branchId: old.branchId,
    paymentMethodId: old.paymentMethodId,
    assigneeMembershipId: old.assigneeMembershipId,
    policyNumber: 'WON-' + label,
    startDate: h.defaultVersion.startDate,
    endDate: h.defaultVersion.endDate,
    grossPremium:
      BigInt(old.grossPremiumMinor) / 100n +
      '.' +
      String(BigInt(old.grossPremiumMinor) % 100n).padStart(2, '0'),
    currency: old.currency,
    installmentCount: old.installmentCount,
  });
  assert.equal(p.status, 201);
  return { policy: await read(page, '/api/policies/' + p.data.id), defaults: h.defaultVersion };
}
async function choose(page, p) {
  await page
    .getByRole('button', { name: 'Kazanıldı — mevcut poliçeyi bağla', exact: true })
    .click();
  const search = page.getByLabel('Poliçe numarasıyla ara', { exact: true });
  await search.fill(p.policyNumber);
  await page.getByRole('button', { name: 'Poliçeleri ara', exact: true }).click();
  const option = page.getByRole('option', { name: new RegExp(p.policyNumber) });
  await option.waitFor({ state: 'attached' });
  await page
    .getByRole('combobox', { name: 'Bağlanacak mevcut poliçe', exact: true })
    .selectOption(p.id);
  await page.getByText(new RegExp('Poliçe sürümü: ' + p.version)).waitFor();
}
async function submit(page) {
  await page
    .getByLabel('Seçilen poliçenin priminin tamamını bu yenilemeye tahsis ediyorum', {
      exact: true,
    })
    .check();
  await page.getByLabel('WON sonucunu ve sabit hedefleri onaylıyorum', { exact: true }).check();
  await page.getByRole('button', { name: 'WON kaydını onayla', exact: true }).click();
}
const success = (page) => page.getByText(/WON: POST hedef\/link\/tutar kanıtı/);
async function snapshot(db, t) {
  const out = {};
  for (const name of [
    'renewal_opportunities',
    'tasks',
    'renewal_policy_links',
    'renewal_state_history',
  ])
    out[name] = (
      await db
        .prepare(
          `SELECT * FROM ${name} WHERE ${name === 'renewal_opportunities' ? 'id' : 'renewal_id'}=? ORDER BY id`,
        )
        .bind(t.renewalId)
        .all()
    ).results;
  for (const name of ['operation_receipts', 'audit_events', 'renewal_quote_events'])
    out[name] = (await db.prepare(`SELECT count(*) n FROM ${name}`).first()).n;
  return JSON.stringify(out);
}
async function effects(db, t, p, result, key) {
  assert.equal(result.createdPolicyId, null);
  assert.equal(result.primaryTaskId, t.taskId);
  assert.equal(result.state, 'WON');
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].newPolicyId, p.id);
  assert.equal(result.links[0].allocatedNewPremiumMinor, p.grossPremiumMinor);
  assert.equal(result.links[0].currency, p.currency);
  assert.deepEqual(
    await db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(t.taskId).first(),
    { status: 'COMPLETED', version: t.taskVersion + 1 },
  );
  assert.deepEqual(
    await db
      .prepare('SELECT state,version FROM renewal_opportunities WHERE id=?')
      .bind(t.renewalId)
      .first(),
    { state: 'WON', version: t.renewalVersion + 1 },
  );
  assert.equal(
    (
      await db
        .prepare('SELECT count(*) n FROM renewal_policy_links WHERE renewal_id=?')
        .bind(t.renewalId)
        .first()
    ).n,
    1,
  );
  assert.equal(
    (
      await db
        .prepare('SELECT count(*) n FROM operation_receipts WHERE idempotency_key=?')
        .bind(key)
        .first()
    ).n,
    1,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE idempotency_key=? AND action='renewal.closed_won' AND outcome='SUCCESS'",
        )
        .bind(key)
        .first()
    ).n,
    1,
  );
}
export async function wonPolicyWalkthrough(page, index, mark, demo, evidence) {
  const actor = ['owner', 'ahmet', 'ayse'][index],
    permissions = {
      ownWon: [],
      privateTaskDenied: false,
      livePermissionDenied: false,
      sessionDenied: false,
    };
  await page.goto('https://localhost:8443/today-work');
  await page.locator('.today-task-row').first().waitFor();
  for (const width of [1440, 768, 360]) {
    mark(`won-${actor}-${width}`);
    await page.setViewportSize({ width, height: 1000 });
    const t = await selectTask(page),
      { policy: p, defaults } = await policyFor(page, t, actor + '-' + width);
    let q = null;
    if (width === 1440) {
      q = await post(page, `/api/renewals/${t.renewalId}/quotes`, {
        expectedRenewalVersion: t.renewalVersion,
        version: {
          ...defaults,
          grossPremiumMinor: p.grossPremiumMinor,
          currency: p.currency,
          validUntil: '2099-01-01T00:00:00.000Z',
        },
      });
      assert.equal(q.status, 201);
      assert.equal(
        (
          await post(page, `/api/renewals/${t.renewalId}/quotes/${q.data.quoteId}/send`, {
            expectedQuoteVersion: 1,
            quoteVersionId: q.data.quoteVersionId,
          })
        ).status,
        201,
      );
    }
    await choose(page, p);
    // Dirty terminal draft must not be overwritten by LOST or sidebar navigation.
    assert.equal(
      await page
        .getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır', exact: true })
        .isDisabled(),
      true,
    );
    if (width === 1440) {
      await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
      await page.getByRole('button', { name: 'Bu ekranda kal', exact: true }).click();
      assert.ok(page.url().endsWith('/today-work'));
      await page
        .getByRole('button', { name: 'İsteğe bağlı SENT teklifleri oku', exact: true })
        .click();
      const select = page.getByRole('combobox', {
        name: 'İsteğe bağlı kabul edilecek teklif',
        exact: true,
      });
      await select
        .locator(`option[value="${q.data.quoteVersionId}"]`)
        .waitFor({ state: 'attached' });
      assert.equal(await select.inputValue(), '');
      await select.selectOption(q.data.quoteVersionId);
    }
    assert.equal(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: join(evidence, `won-${actor}-${width}.png`), fullPage: true });
    const url = `/api/renewals/${t.renewalId}/close-won`,
      attempts = [];
    let failed = false,
      blockRead = width === 360;
    await page.route('**' + url, async (route) => {
      const request = route.request(),
        response = await route.fetch();
      attempts.push({
        body: request.postData(),
        key: request.headers()['idempotency-key'],
        status: response.status(),
        result: (await response.json()).data,
      });
      if (width === 768 && !failed) {
        failed = true;
        return route.abort('failed');
      }
      return route.fulfill({ response });
    });
    if (width === 360)
      await page.route('**/api/policies/' + p.id, (route) =>
        blockRead
          ? route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false }),
            })
          : route.continue(),
      );
    await submit(page);
    if (width === 768) {
      await page.getByText(/Sonuç belirsiz/).waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: 'WON taslağını açıkça kapat', exact: true })
          .isDisabled(),
        true,
      );
      await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
      await page.getByText(/Sonuçlandırma\/iletişim işleminin sonucu doğrulanmadan/).waitFor();
      // Sidebar is intentionally collapsed at tablet widths; probe its desktop guard,
      // then restore the cell's viewport before the exact retry.
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
      assert.equal(new globalThis.URL(page.url()).pathname, '/today-work');
      const idx = await page.evaluate(() => globalThis.history.state.idx);
      await page.evaluate(() => globalThis.history.back());
      await page.waitForFunction((idx) => globalThis.history.state.idx === idx, idx);
      assert.equal(new globalThis.URL(page.url()).pathname, '/today-work');
      await page.setViewportSize({ width, height: 1000 });
      await page
        .getByRole('button', { name: 'Aynı WON isteğini yeniden dene', exact: true })
        .click();
    }
    if (width === 360) {
      await page.getByText(/Başarı doğrulanmadı/).waitFor();
      blockRead = false;
      await page
        .getByRole('button', { name: 'Yalnız WON okumalarını yeniden dene', exact: true })
        .click();
    }
    await success(page).waitFor();
    assert.equal(attempts.length, width === 768 ? 2 : 1);
    if (width === 768) {
      assert.equal(attempts[0].body, attempts[1].body);
      assert.equal(attempts[0].key, attempts[1].key);
    }
    const b = JSON.parse(attempts[0].body);
    assert.equal(b.expectedPrimaryTaskId, t.taskId);
    assert.equal(b.result.expectedPolicyVersion, p.version);
    assert.equal(b.result.kind, 'LINK_POLICY');
    await effects(demo.db, t, p, attempts.at(-1).result, attempts[0].key);
    if (q) {
      const h = await read(page, `/api/renewals/${t.renewalId}/quotes`),
        quote = h.quotes.find((v) => v.id === q.data.quoteId);
      assert.equal(quote.accepted_version_id, q.data.quoteVersionId);
      assert.equal(quote.accepted_policy_id, p.id);
      assert.equal(quote.events.filter((e) => e.event === 'ACCEPTED').length, 1);
    }
    assert.equal(
      await page.evaluate(() => globalThis.sessionStorage.length + globalThis.localStorage.length),
      0,
    );
    await page.unroute('**' + url);
    if (width === 360) await page.unroute('**/api/policies/' + p.id);
    permissions.ownWon.push(width);
  }
  mark(`won-${actor}-stale-primary-task`);
  const a = await selectTask(page),
    { policy: p } = await policyFor(page, a, actor + '-ABA');
  await choose(page, p);
  const replacement = await post(page, `/api/renewals/${a.renewalId}/tasks/${a.taskId}/complete`, {
    expectedRenewalVersion: a.renewalVersion,
    expectedTaskVersion: a.taskVersion,
    replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(replacement.status, 200);
  assert.equal(replacement.data.replacementTaskVersion, a.taskVersion);
  const before = await snapshot(demo.db, a);
  await submit(page);
  await page.getByText(/WON çakıştı/).waitFor();
  assert.equal(await snapshot(demo.db, a), before);
  await page
    .getByRole('button', { name: 'WON hedeflerini yetkili karşılaştır', exact: true })
    .click();
  await page.getByText(/Başka primary Task benimsenmedi/).waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: 'Aynı Task ile poliçeyi yeniden seç', exact: true })
      .count(),
    0,
  );
  await page.getByRole('button', { name: 'WON taslağını açıkça kapat', exact: true }).click();
  mark(`won-${actor}-cycle409`);
  const t = await selectTask(page),
    pair = await policyFor(page, t, actor + '-cycle'),
    rid = globalThis.crypto.randomUUID(),
    tid = globalThis.crypto.randomUUID(),
    now = new Date().toISOString();
  await demo.db.batch([
    demo.db
      .prepare(
        "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at) VALUES(?,'demo-agency',?,?,'CONTACT_PENDING',1,?,?)",
      )
      .bind(rid, pair.policy.id, 'demo-member-' + actor, now, now),
    demo.db
      .prepare(
        "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,status,actor_kind,version,created_at,updated_at) VALUES(?,'demo-agency',?,?,'RENEWAL_FOLLOWUP','Sentetik cycle',?,?,'OPEN','SYSTEM',1,?,?)",
      )
      .bind(tid, t.customerId, rid, now, 'demo-member-' + actor, now, now),
    demo.db
      .prepare(
        "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at) VALUES(?,'demo-agency',?,NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?)",
      )
      .bind(globalThis.crypto.randomUUID(), rid, now),
  ]);
  const old = await read(page, '/api/policies/' + t.policyId);
  assert.equal(
    (
      await post(page, `/api/renewals/${rid}/close-won`, {
        expectedPrimaryTaskId: tid,
        expectedRenewalVersion: 1,
        expectedTaskVersion: 1,
        result: {
          kind: 'LINK_POLICY',
          newPolicyId: old.id,
          expectedPolicyVersion: old.version,
          allocatedNewPremiumMinor: old.grossPremiumMinor,
          currency: old.currency,
        },
      })
    ).status,
    200,
  );
  await choose(page, pair.policy);
  const cycleBefore = await snapshot(demo.db, t),
    cycle = page.waitForResponse(
      (r) =>
        new globalThis.URL(r.url()).pathname === `/api/renewals/${t.renewalId}/close-won` &&
        r.request().method() === 'POST',
    );
  await submit(page);
  assert.equal((await cycle).status(), 409);
  await page.getByText(/WON çakıştı/).waitFor();
  assert.equal(await snapshot(demo.db, t), cycleBefore);
  await page.getByRole('button', { name: 'WON taslağını açıkça kapat', exact: true }).click();
  if (index) {
    mark(`won-${actor}-private-deny`);
    const other = await demo.db
      .prepare(
        "SELECT r.id renewalId,r.version renewalVersion,t.id taskId,t.version taskVersion FROM renewal_opportunities r JOIN tasks t ON t.renewal_id=r.id WHERE t.status='OPEN' AND t.assignee_membership_id<>? LIMIT 1",
      )
      .bind('demo-member-' + actor)
      .first();
    const denied = await post(page, `/api/renewals/${other.renewalId}/close-won`, {
      expectedPrimaryTaskId: other.taskId,
      expectedRenewalVersion: other.renewalVersion,
      expectedTaskVersion: other.taskVersion,
      result: {
        kind: 'LINK_POLICY',
        newPolicyId: pair.policy.id,
        expectedPolicyVersion: pair.policy.version,
        allocatedNewPremiumMinor: pair.policy.grossPremiumMinor,
        currency: pair.policy.currency,
      },
    });
    assert.ok([403, 404].includes(denied.status));
    permissions.privateTaskDenied = true;
    const target = await selectTask(page),
      next = await policyFor(page, target, actor + '-permission');
    await choose(page, next.policy);
    const grant = await demo.db
      .prepare(
        "SELECT * FROM membership_permissions WHERE membership_id=? AND permission_code='renewal.close_won'",
      )
      .bind('demo-member-' + actor)
      .first();
    assert.ok(grant);
    await demo.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(grant.id).run();
    try {
      await submit(page);
      await page.getByText(/korunan hedef ve poliçe\/teklif ayrıntıları gizlendi/).waitFor();
      permissions.livePermissionDenied = true;
    } finally {
      await demo.db
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(grant.id, grant.membership_id, grant.permission_code, grant.scope)
        .run();
    }
    await page.getByRole('button', { name: 'WON taslağını açıkça kapat', exact: true }).click();
  }
  mark(`won-${actor}-session`);
  const last = await selectTask(page),
    next = await policyFor(page, last, actor + '-session');
  await choose(page, next.policy);
  await demo.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=?')
    .bind(Date.now(), 'demo-user-' + actor)
    .run();
  await submit(page);
  await page.getByRole('button', { name: 'Giriş Yap', exact: true }).waitFor();
  assert.equal(await page.locator('.today-outcome-form').count(), 0);
  permissions.sessionDenied = true;
  return permissions;
}
