import assert from 'node:assert/strict';
async function read(page, id) {
  return page.evaluate(async (id) => {
    const r = await globalThis.fetch('/api/policies/' + id);
    if (!r.ok) throw new Error('READ_FAILED');
    return (await r.json()).data;
  }, id);
}
async function post(page, url, body) {
  return page.evaluate(
    async ({ url, body }) => {
      const csrf = (await (await globalThis.fetch('/api/csrf-token')).json()).data.token;
      const r = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': globalThis.crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    },
    { url, body },
  );
}
async function raceVersion(page, id) {
  assert.equal(
    await page.evaluate(async (id) => {
      const p = (await (await globalThis.fetch('/api/policies/' + id)).json()).data,
        csrf = (await (await globalThis.fetch('/api/csrf-token')).json()).data.token;
      return (
        await globalThis.fetch('/api/policies/' + id, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': globalThis.crypto.randomUUID(),
          },
          body: JSON.stringify({ expectedVersion: p.version, policyNumber: p.policyNumber }),
        })
      ).status;
    }, id),
    200,
  );
}
async function responsive(page) {
  for (const width of [1440, 768, 360]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
      ),
      true,
    );
  }
}
async function chooseAssignee(page, id, target) {
  await page.getByRole('button', { name: 'Sorumluyu değiştir', exact: true }).click();
  await page.getByLabel('Yeni poliçe sorumlusu', { exact: true }).selectOption(target);
  await page.getByLabel('Sorumlu değişikliğini onaylıyorum', { exact: true }).check();
}
async function confirmArchive(page) {
  await page.getByRole('button', { name: 'Poliçeyi arşivle', exact: true }).click();
  await page.getByLabel('Arşiv gerekçe kodu', { exact: true }).fill('HISTORICAL_RECORD');
  await page.getByLabel('Bu poliçeyi arşivlemek istediğimi onaylıyorum', { exact: true }).check();
}
export async function verifyPolicyLifecycle(page, id, index, db, mark) {
  await page.getByRole('link', { name: 'Sorumlu ve arşiv', exact: true }).click();
  const original = await read(page, id);
  if (index) {
    mark('directory-denied');
    await page
      .getByText(
        'Atama dizini için etkin AGENCY atama yetkisi gerekir. Mevcut sorumlu değiştirilmedi.',
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Sorumluyu değiştir', exact: true }).count(),
      0,
    );
    await confirmArchive(page);
    await responsive(page);
    await page.getByRole('button', { name: 'Arşivlemeyi onayla', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal((await read(page, id)).archivedAt, null);
    assert.equal(await page.getByLabel('Arşiv gerekçe kodu', { exact: true }).count(), 0);
  } else {
    mark('assign-conflict-readback');
    const options = await page.evaluate(
      async (id) =>
        (await (await globalThis.fetch('/api/policies/' + id + '/assignment-options')).json()).data,
      id,
    );
    const target = options.find((o) => o.membershipId !== original.assigneeMembershipId);
    assert.ok(target);
    await chooseAssignee(page, id, target.membershipId);
    await responsive(page);
    await raceVersion(page, id);
    const attempts = [];
    let committed = false,
      lostRead = false;
    await page.route('**/api/policies/' + id + '/assign', async (route) => {
      attempts.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key'],
      });
      const r = await route.fetch();
      if (r.ok()) committed = true;
      return route.fulfill({ response: r });
    });
    await page.route('**/api/policies/' + id, async (route) => {
      if (route.request().method() === 'GET' && committed && !lostRead) {
        lostRead = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        });
      }
      return route.continue();
    });
    await page.getByRole('button', { name: 'Atamayı kaydet', exact: true }).click();
    await page.getByRole('button', { name: 'Güncel poliçeyi karşılaştır', exact: true }).click();
    await page.getByText(/Karşılaştırılan poliçe sürümü:/).waitFor();
    assert.equal(
      await page.getByLabel('Yeni poliçe sorumlusu', { exact: true }).inputValue(),
      target.membershipId,
    );
    assert.equal(
      await page.getByLabel('Sorumlu değişikliğini onaylıyorum', { exact: true }).isChecked(),
      false,
    );
    await page.getByLabel('Sorumlu değişikliğini onaylıyorum', { exact: true }).check();
    await page.getByRole('button', { name: 'Karşılaştırdım, atamayı kaydet', exact: true }).click();
    await page
      .getByRole('button', { name: 'Kaydedilen poliçeyi yeniden oku', exact: true })
      .click();
    await page.getByText('Poliçe sorumlusu güncellendi.', { exact: true }).waitFor();
    assert.equal(attempts.length, 2);
    assert.equal((await read(page, id)).assigneeMembershipId, target.membershipId);
    await page.unroute('**/api/policies/' + id + '/assign');
    await page.unroute('**/api/policies/' + id);
    mark('assign-exact-retry');
    const target2 = options.find((o) => o.membershipId !== target.membershipId);
    await chooseAssignee(page, id, target2.membershipId);
    const replay = [];
    let lost = false;
    await page.route('**/api/policies/' + id + '/assign', async (route) => {
      replay.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key'],
      });
      const r = await route.fetch();
      assert.equal(r.status(), 200);
      if (!lost) {
        lost = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        });
      }
      return route.fulfill({ response: r });
    });
    await page.getByRole('button', { name: 'Atamayı kaydet', exact: true }).click();
    await page.getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true }).click();
    await page.getByText('Poliçe sorumlusu güncellendi.', { exact: true }).waitFor();
    assert.equal(replay.length, 2);
    assert.deepEqual(replay[0], replay[1]);
    await page.unroute('**/api/policies/' + id + '/assign');
    async function create(number, end) {
      const r = await post(page, '/api/policies', {
        customerId: original.customerId,
        insurerId: original.insurerId,
        branchId: original.branchId,
        productId: original.productId,
        paymentMethodId: original.paymentMethodId,
        policyNumber: number,
        startDate: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
        endDate: end,
        grossPremium: '1234.56',
        currency: original.currency,
        installmentCount: original.installmentCount,
        status: 'ACTIVE',
      });
      assert.equal(r.status, 201);
      return r.body.data;
    }
    mark('archive-dependencies');
    const blocked = await create(
      'LIFECYCLE-OPEN',
      new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT count(*) n FROM tasks t JOIN renewal_opportunities r ON r.id=t.renewal_id WHERE r.expiring_policy_id=? AND t.status='OPEN'",
          )
          .bind(blocked.id)
          .first()
      ).n,
      1,
    );
    await page.goto('https://localhost:8443/policies/' + blocked.id + '?section=management');
    await confirmArchive(page);
    await page.getByRole('button', { name: 'Arşivlemeyi onayla', exact: true }).click();
    await page.getByText(/Açık yenileme veya takip görevi bulundu/).waitFor();
    assert.equal((await read(page, blocked.id)).archivedAt, null);
    assert.equal(
      (
        await db
          .prepare(
            "SELECT count(*) n FROM tasks t JOIN renewal_opportunities r ON r.id=t.renewal_id WHERE r.expiring_policy_id=? AND t.status='OPEN'",
          )
          .bind(blocked.id)
          .first()
      ).n,
      1,
    );
    mark('archive-confirm-conflict');
    const p = await create(
      'LIFECYCLE-ARCHIVE',
      new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10),
    );
    mark('archive-empty-dependency-proof');
    assert.equal(
      (
        await db
          .prepare('SELECT count(*) n FROM renewal_opportunities WHERE expiring_policy_id=?')
          .bind(p.id)
          .first()
      ).n,
      0,
    );
    for (const [suffix, fields] of [
      ['parties', { customerId: p.customerId, role: 'INSURED' }],
      [
        'amendments',
        {
          externalReference: 'ARCHIVE-HISTORY',
          effectiveDate: new Date().toISOString().slice(0, 10),
          description: 'Sentetik geçmiş zeyil',
        },
      ],
      ['external-references', { sourceNamespace: 'lifecycle', externalKey: 'ARCHIVE-HISTORY-REF' }],
    ]) {
      const fresh = await read(page, p.id);
      mark('archive-history-' + suffix);
      assert.equal(
        (
          await post(page, '/api/policies/' + p.id + '/' + suffix, {
            ...fields,
            expectedVersion: fresh.version,
          })
        ).status,
        201,
      );
    }
    mark('archive-open-confirmation');
    await page.goto('https://localhost:8443/policies/' + p.id + '?section=management');
    await confirmArchive(page);
    await page.getByText(p.policyNumber, { exact: true }).last().waitFor();
    mark('archive-responsive');
    await responsive(page);
    mark('archive-external-cas-update');
    await raceVersion(page, p.id);
    const archiveAttempts = [];
    let dropped = false,
      archiveCommitted = false,
      droppedRead = false;
    await page.route('**/api/policies/' + p.id + '/archive', async (route) => {
      archiveAttempts.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key'],
      });
      const r = await route.fetch();
      if (r.ok()) {
        archiveCommitted = true;
        if (!dropped) {
          dropped = true;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ success: false }),
          });
        }
      }
      return route.fulfill({ response: r });
    });
    await page.route('**/api/policies/' + p.id, async (route) => {
      if (route.request().method() === 'GET' && archiveCommitted && !droppedRead) {
        droppedRead = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        });
      }
      return route.continue();
    });
    mark('archive-first-conflict');
    await page.getByRole('button', { name: 'Arşivlemeyi onayla', exact: true }).click();
    mark('archive-comparison');
    await page.getByRole('button', { name: 'Güncel poliçeyi karşılaştır', exact: true }).click();
    await page.getByText(/Karşılaştırılan poliçe sürümü:/).waitFor();
    assert.equal(
      await page
        .getByLabel('Bu poliçeyi arşivlemek istediğimi onaylıyorum', { exact: true })
        .isChecked(),
      false,
    );
    await page.getByLabel('Bu poliçeyi arşivlemek istediğimi onaylıyorum', { exact: true }).check();
    await page
      .getByRole('button', { name: 'Karşılaştırdım, arşivlemeyi onayla', exact: true })
      .click();
    mark('archive-exact-retry');
    await page.getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true }).click();
    mark('archive-get-only-retry');
    await page
      .getByRole('button', { name: 'Kaydedilen poliçeyi yeniden oku', exact: true })
      .click();
    await page.getByText('Poliçe arşivlendi.', { exact: true }).waitFor();
    assert.equal(archiveAttempts.length, 3);
    assert.deepEqual(archiveAttempts[1], archiveAttempts[2]);
    await page.unroute('**/api/policies/' + p.id + '/archive');
    await page.unroute('**/api/policies/' + p.id);
    mark('archive-read-only-history');
    const archived = await read(page, p.id);
    assert.ok(archived.archivedAt);
    for (const field of [
      'policyNumber',
      'status',
      'startDate',
      'endDate',
      'grossPremiumMinor',
      'currency',
    ])
      assert.equal(archived[field], p[field]);
    assert.equal(
      await page.getByRole('link', { name: 'Poliçeyi düzenle', exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Poliçeyi arşivle', exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Sorumluyu değiştir', exact: true }).count(),
      0,
    );
    for (const [link, button, history] of [
      ['Sigortalılar ve lehtarlar', 'Taraf ekle', 'Sigortalı · Aktif'],
      ['Zeyiller', 'Zeyil ekle', 'ARCHIVE-HISTORY'],
      ['Dış referanslar', 'Dış referans ekle', 'ARCHIVE-HISTORY-REF'],
    ]) {
      mark('archive-visible-history-' + button);
      await page.getByRole('link', { name: link, exact: true }).click();
      if (history) await page.getByText(history, { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: button, exact: true }).count(), 0);
      assert.equal(
        await page.getByRole('button', { name: 'Tarafı pasifleştir', exact: true }).count(),
        0,
      );
    }
    await page.reload();
    await page.getByText('ARCHIVE-HISTORY-REF', { exact: true }).waitFor();
    await page.goBack();
    await page.getByText('ARCHIVE-HISTORY', { exact: true }).waitFor();
  }
  mark('legacy-backstop');
  await page.goto('https://localhost:8443/policies/legacy');
  await page
    .getByRole('heading', { name: 'Poliçe işlemleri — klasik çalışma alanı', exact: true })
    .waitFor();
  await page.getByRole('heading', { name: 'Poliçeler', exact: true }).waitFor();
  await page.goto('https://localhost:8443/policies/' + id);
  await page.getByRole('link', { name: 'Poliçeyi düzenle', exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
}
