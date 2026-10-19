import assert from 'node:assert/strict';
import { join } from 'node:path';
async function read(page, url) {
  return page.evaluate(async (url) => {
    const r = await globalThis.fetch(url, { cache: 'no-store' });
    if (!r.ok) throw Error('CREATE_READ_DENIED');
    return (await r.json()).data;
  }, url);
}
async function select(page) {
  await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
  await page.locator('.today-task-row').first().waitFor();
  const t = (await read(page, '/api/tasks/today?limit=20')).items.find((t) => t.taskVersion === 1);
  assert.ok(t);
  await page
    .locator('.today-task-row')
    .filter({ has: page.getByText(t.policyNumber, { exact: true }) })
    .first()
    .click();
  return t;
}
async function fill(page, t, number) {
  const p = await read(page, '/api/policies/' + t.policyId),
    h = await read(page, `/api/renewals/${t.renewalId}/quotes`);
  await page.getByRole('button', { name: 'Kazanıldı — yeni poliçe oluştur', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Sigorta şirketi', exact: true })
    .locator(`option[value="${p.insurerId}"]`)
    .waitFor({ state: 'attached' });
  for (const [label, value] of [
    ['Sigorta şirketi', p.insurerId],
    ['Branş', p.branchId],
    ['Ürün', p.productId],
    ['Ödeme yöntemi', p.paymentMethodId],
    ['Poliçe sorumlusu', t.assigneeMembershipId],
  ])
    await page.getByRole('combobox', { name: label, exact: true }).selectOption(value);
  for (const [label, value] of [
    ['Yeni poliçe numarası', number],
    ['Başlangıç tarihi', h.defaultVersion.startDate],
    ['Bitiş tarihi', h.defaultVersion.endDate],
    ['Brüt prim', '1250.50'],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
  const cats = await read(page, '/api/catalogs/selectable'),
    method = cats.paymentMethods.find((x) => x.id === p.paymentMethodId);
  if (method.supportsInstallments)
    await page.getByLabel('Taksit sayısı', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Yeni poliçeyi gözden geçir', exact: true }).click();
  await page.getByText(/İncelenen yeni poliçe/).waitFor();
  return p;
}
async function submit(page) {
  await page
    .getByLabel('Yeni poliçe oluşturulmasını ve WON sonucunu onaylıyorum', { exact: true })
    .check();
  await page
    .getByRole('button', { name: 'Yeni poliçe oluştur ve WON kaydet', exact: true })
    .click();
}
export async function wonCreateWalkthrough(page, index, mark, demo, evidence) {
  const actor = ['owner', 'ahmet', 'ayse'][index],
    permissions = { created: [], missingCreateDenied: false, sessionDenied: false };
  let standalonePosts = 0;
  const observe = (r) => {
    if (new globalThis.URL(r.url()).pathname === '/api/policies' && r.method() === 'POST')
      standalonePosts++;
  };
  page.on('request', observe);
  await page.goto('https://localhost:8443/today-work');
  await page.locator('.today-task-row').first().waitFor();
  try {
    for (const width of [1440, 768, 360]) {
      mark(`create-${actor}-${width}`);
      await page.setViewportSize({ width, height: 1000 });
      const t = await select(page),
        policiesBefore = (await demo.db.prepare('SELECT count(*) n FROM policies').first()).n;
      await fill(page, t, `CREATE-${actor}-${width}`);
      assert.equal(
        await page
          .getByRole('button', { name: 'Kazanıldı — mevcut poliçeyi bağla', exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır', exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: join(evidence, `create-${actor}-${width}.png`),
        fullPage: true,
      });
      const url = `/api/renewals/${t.renewalId}/close-won`,
        attempts = [];
      let lost = false,
        blockRead = width === 360;
      await page.route('**' + url, async (route) => {
        const req = route.request(),
          r = await route.fetch();
        attempts.push({
          url: req.url(),
          body: req.postData(),
          key: req.headers()['idempotency-key'],
          status: r.status(),
          data: (await r.json()).data,
        });
        if (width === 768 && !lost) {
          lost = true;
          return route.abort('failed');
        }
        return route.fulfill({ response: r });
      });
      if (width === 360)
        await page.route('**/api/policies/*', async (route) => {
          if (
            route.request().method() === 'GET' &&
            !new globalThis.URL(route.request().url()).pathname.endsWith('assignment-options') &&
            blockRead
          )
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false }),
            });
          return route.continue();
        });
      await submit(page);
      if (width === 768) {
        await page.getByText(/Sonuç belirsiz/).waitFor();
        await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
        await page.getByText(/Sonuçlandırma\/iletişim işleminin sonucu doğrulanmadan/).waitFor();
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
        assert.equal(new globalThis.URL(page.url()).pathname, '/today-work');
        const idx = await page.evaluate(() => globalThis.history.state.idx);
        await page.evaluate(() => globalThis.history.back());
        await page.waitForFunction((idx) => globalThis.history.state.idx === idx, idx);
        assert.equal(new globalThis.URL(page.url()).pathname, '/today-work');
        await page.setViewportSize({ width, height: 1000 });
        await page
          .getByRole('button', { name: 'Aynı CREATE_POLICY isteğini yeniden dene', exact: true })
          .click();
      }
      if (width === 360) {
        await page.getByText(/Başarı doğrulanmadı/).waitFor();
        blockRead = false;
        await page
          .getByRole('button', {
            name: 'Yalnız oluşturulan poliçe okumalarını yeniden dene',
            exact: true,
          })
          .click();
      }
      await page.getByText(/Yeni ACTIVE poliçe tek atomik komutla oluşturuldu/).waitFor();
      assert.equal(attempts.length, width === 768 ? 2 : 1);
      assert.equal(attempts[0].status, 201);
      if (width === 768) {
        assert.equal(attempts[1].status, 200);
        assert.equal(attempts[0].body, attempts[1].body);
        assert.equal(attempts[0].key, attempts[1].key);
      }
      const a = attempts.at(-1),
        b = JSON.parse(a.body);
      assert.equal(b.result.kind, 'CREATE_POLICY');
      assert.equal(b.result.policy.grossPremium, '1250.50');
      assert.equal(b.expectedPrimaryTaskId, t.taskId);
      assert.equal(b.result.policy.customerId, t.customerId);
      assert.equal(b.acceptedQuoteVersionId, undefined);
      assert.equal(
        (await demo.db.prepare('SELECT count(*) n FROM policies').first()).n,
        policiesBefore + 1,
      );
      assert.deepEqual(
        await demo.db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(t.taskId).first(),
        { status: 'COMPLETED', version: t.taskVersion + 1 },
      );
      assert.equal(
        (
          await demo.db
            .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
            .bind(t.renewalId)
            .first()
        ).state,
        'WON',
      );
      assert.equal(
        (
          await demo.db
            .prepare(
              'SELECT count(*) n FROM renewal_policy_links WHERE renewal_id=? AND new_policy_id=? AND allocated_new_premium_minor=125050',
            )
            .bind(t.renewalId, a.data.createdPolicyId)
            .first()
        ).n,
        1,
      );
      assert.equal(
        (
          await demo.db
            .prepare(
              "SELECT count(*) n FROM audit_events WHERE idempotency_key=? AND outcome='SUCCESS'",
            )
            .bind(a.key)
            .first()
        ).n,
        2,
      );
      assert.equal(
        (
          await demo.db
            .prepare('SELECT count(*) n FROM operation_receipts WHERE idempotency_key=?')
            .bind(a.key)
            .first()
        ).n,
        1,
      );
      await page.unroute('**' + url);
      if (width === 360) await page.unroute('**/api/policies/*');
      permissions.created.push(width);
      assert.equal(
        await page.evaluate(
          () => globalThis.sessionStorage.length + globalThis.localStorage.length,
        ),
        0,
      );
    }
    if (index) {
      mark(`create-${actor}-missing-create`);
      const t = await select(page);
      await fill(page, t, `CREATE-${actor}-DENIED`);
      const g = await demo.db
        .prepare(
          "SELECT * FROM membership_permissions WHERE membership_id=? AND permission_code='policy.create'",
        )
        .bind('demo-member-' + actor)
        .first();
      assert.ok(g);
      await demo.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(g.id).run();
      const before = (await demo.db.prepare('SELECT count(*) n FROM policies').first()).n;
      try {
        await submit(page);
        await page.getByText(/korunan oluşturma taslağı gizlendi/).waitFor();
        assert.equal((await demo.db.prepare('SELECT count(*) n FROM policies').first()).n, before);
        permissions.missingCreateDenied = true;
      } finally {
        await demo.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(g.id, g.membership_id, g.permission_code, g.scope)
          .run();
      }
      await page
        .getByRole('button', { name: 'Yeni poliçe WON taslağını açıkça kapat', exact: true })
        .click();
    }
    mark(`create-${actor}-session`);
    const t = await select(page);
    await fill(page, t, `CREATE-${actor}-SESSION`);
    await demo.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=?')
      .bind(Date.now(), 'demo-user-' + actor)
      .run();
    await submit(page);
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).waitFor();
    assert.equal(await page.locator('.today-outcome-form').count(), 0);
    permissions.sessionDenied = true;
    assert.equal(standalonePosts, 0);
    return permissions;
  } finally {
    page.off('request', observe);
  }
}
