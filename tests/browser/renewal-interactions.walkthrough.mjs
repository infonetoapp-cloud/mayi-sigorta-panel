// Real local API operations through the selected queue DTO; no credentials or keys logged.
import assert from 'node:assert/strict';
async function read(page, url) {
  return page.evaluate(async (url) => {
    const r = await globalThis.fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('INTERACTION_READ_FAILED');
    return (await r.json()).data;
  }, url);
}
async function post(page, url, body) {
  return page.evaluate(
    async ({ url, body }) => {
      const token = await globalThis.fetch('/api/csrf-token').then((r) => r.json());
      const r = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token.data.token,
          'Idempotency-Key': globalThis.crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('INTERACTION_FIXTURE_WRITE_FAILED');
      return (await r.json()).data;
    },
    { url, body },
  );
}
async function open(page, outcome, channel = 'OTHER') {
  await page.getByRole('button', { name: 'İletişim kaydı ekle', exact: true }).click();
  await page.getByLabel('Görüşme sonucu', { exact: true }).selectOption(outcome);
  if (outcome !== 'NOTE')
    await page.getByLabel('İletişim kanalı', { exact: true }).selectOption(channel);
  if (outcome === 'CONTACT_CONFIRMED')
    await page
      .getByLabel('Gerçek müşteri temasının gerçekleştiğini doğruluyorum', { exact: true })
      .check();
}
async function saved(page) {
  await page.getByText('İletişim kaydı yetkili okumayla doğrulandı.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'İletişim kaydı ekle', exact: true }).waitFor();
}
export async function interactionWalkthrough(page, index, mark) {
  mark('interactions-' + index);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.today-task-row').first().click();
  await page.getByRole('button', { name: 'İletişim kaydı ekle', exact: true }).waitFor();
  const task = (await read(page, '/api/tasks/today?limit=20')).items[0],
    path = `/api/renewals/${task.renewalId}/interactions`,
    before = await read(page, path),
    attempts = [];
  let lostWrite = false,
    failNextRead = false,
    lostRead = false,
    denyRead = false,
    quoteRequests = 0;
  const observer = (request) => {
    if (/\/quotes(?:[/?]|$)/.test(request.url())) quoteRequests++;
  };
  page.on('request', observer);
  const pattern = '**' + path;
  await page.route(pattern, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      attempts.push({
        url: request.url(),
        method: request.method(),
        body: request.postData(),
        key: request.headers()['idempotency-key'],
      });
      const response = await route.fetch();
      if (!index && !lostWrite) {
        lostWrite = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        });
      }
      if (index === 1 && JSON.parse(request.postData()).outcome === 'ATTEMPT_NO_RESPONSE')
        failNextRead = true;
      return route.fulfill({ response });
    }
    if (denyRead)
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Denied' } }),
      });
    if (failNextRead && !lostRead) {
      lostRead = true;
      failNextRead = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false }),
      });
    }
    return route.continue();
  });
  try {
    await open(page, 'CONTACT_CONFIRMED', 'PHONE');
    await page.getByRole('button', { name: 'İletişim kaydını kaydet', exact: true }).click();
    if (!index) {
      await page
        .getByRole('button', { name: 'Aynı iletişim isteğini yeniden dene', exact: true })
        .click();
    }
    await saved(page);
    const confirmed = JSON.parse(attempts[0].body),
      confirmedHistory = await read(page, path);
    assert.equal(
      confirmedHistory.lastContactAt,
      [before.lastContactAt, confirmed.occurredAt].filter(Boolean).sort().at(-1),
    );
    assert.equal(confirmedHistory.lastAttemptAt, before.lastAttemptAt);
    if (!index) {
      assert.equal(attempts.length, 2);
      assert.ok(
        attempts[0].url === attempts[1].url &&
          attempts[0].method === attempts[1].method &&
          attempts[0].body === attempts[1].body &&
          attempts[0].key === attempts[1].key,
      );
      assert.equal(confirmedHistory.interactions.length, before.interactions.length + 1);
    }
    const attemptCount = attempts.length;
    await open(page, 'ATTEMPT_NO_RESPONSE', 'WHATSAPP');
    await page.getByRole('button', { name: 'İletişim kaydını kaydet', exact: true }).click();
    if (index === 1) {
      await page
        .getByRole('button', { name: 'Kaydedilen iletişim geçmişini yeniden oku', exact: true })
        .click();
    }
    await saved(page);
    assert.equal(attempts.length, attemptCount + 1);
    const attempt = JSON.parse(attempts.at(-1).body),
      attemptHistory = await read(page, path);
    assert.equal(attemptHistory.lastContactAt, confirmedHistory.lastContactAt);
    assert.equal(
      attemptHistory.lastAttemptAt,
      [before.lastAttemptAt, attempt.occurredAt].filter(Boolean).sort().at(-1),
    );
    const text = 'Sentetik modern görüşme notu ' + index;
    await open(page, 'NOTE');
    await page.getByLabel('İç not', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'İletişim kaydını kaydet', exact: true }).click();
    await saved(page);
    const history = await read(page, path);
    assert.equal(history.lastContactAt, attemptHistory.lastContactAt);
    assert.equal(history.lastAttemptAt, attemptHistory.lastAttemptAt);
    assert.equal(history.interactions.length, before.interactions.length + 3);
    await page.getByText(text, { exact: true }).waitFor();
    for (const request of attempts) {
      const body = JSON.parse(request.body);
      assert.deepEqual(Object.keys(body).sort(), [
        'channel',
        'companyContactId',
        'note',
        'occurredAt',
        'outcome',
      ]);
      assert.equal(body.companyContactId, null);
      assert.notEqual(body.outcome, 'WHATSAPP_OPENED');
    }
    denyRead = true;
    await page.getByRole('button', { name: 'İletişim geçmişini yenile', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByText(text, { exact: true }).count(), 0);
    assert.equal(
      await page.getByRole('button', { name: 'İletişim kaydı ekle', exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole('region', { name: 'Seçili görev özeti', exact: true }).count(),
      1,
    );
    denyRead = false;
    await page
      .getByRole('button', { name: 'Güncel iletişim bilgilerini karşılaştır', exact: true })
      .click();
    await page.getByText(text, { exact: true }).waitFor();
    await open(page, 'NOTE');
    await page.getByLabel('İç not', { exact: true }).fill('Yalnız bellekte kalan mobil taslak');
    for (const width of [1440, 768, 360]) {
      mark('interaction-form-' + index + '-' + width);
      await page.setViewportSize({ width, height: 950 });
      await page.getByLabel('İç not', { exact: true }).scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      assert.equal(
        await page.getByRole('form', { name: 'Yeni iletişim kaydı', exact: true }).isVisible(),
        true,
      );
      if (width !== 1440) {
        await page.getByRole('button', { name: 'Görev listesine dön', exact: true }).click();
        await page.getByText('Hedefi değiştirmeden önce', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Bu ekranda kal', exact: true }).click();
        assert.equal(
          await page.getByLabel('İç not', { exact: true }).inputValue(),
          'Yalnız bellekte kalan mobil taslak',
        );
      }
    }
    await page.getByRole('button', { name: 'Formu kapat ve taslağı bırak', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(quoteRequests, 0);
    const browserStorage = await page.evaluate(() =>
      JSON.stringify({ ...globalThis.localStorage, ...globalThis.sessionStorage }),
    );
    assert.ok(
      !browserStorage.includes(text) &&
        !browserStorage.includes('Yalnız bellekte kalan mobil taslak'),
    );
    for (const a of attempts) assert.ok(!browserStorage.includes(a.key));
  } finally {
    await page.unroute(pattern);
    page.off('request', observer);
  }
  if (!index) await companyWalkthrough(page, mark);
}
async function companyWalkthrough(page, mark) {
  mark('interaction-company');
  const customer = await post(page, '/api/customers', {
      type: 'COMPANY',
      companyTitle: 'Sentetik İletişim Şirketi',
    }),
    contacts = [];
  for (const firstName of ['Birinci', 'İkinci'])
    contacts.push(
      await post(page, `/api/customers/${customer.id}/contacts`, {
        firstName,
        lastName: 'Yetkili',
        role: 'Finans',
        isPrimary: false,
      }),
    );
  const catalogs = await read(page, '/api/catalogs/selectable');
  const branch = catalogs.branches.find((b) => b.dataClassification === 'GENERAL'),
    product = catalogs.products.find((p) => p.branchId === branch.id),
    insurer = catalogs.insurers.find((i) => i.id === product.insurerId),
    payment = catalogs.paymentMethods.find((p) => !p.supportsInstallments);
  assert.ok(branch && product && insurer && payment);
  await post(page, '/api/policies', {
    customerId: customer.id,
    policyNumber: 'SMOKE-COMPANY-INTERACTION',
    insurerId: insurer.id,
    branchId: branch.id,
    productId: product.id,
    status: 'ACTIVE',
    startDate: '2026-01-01',
    endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    grossPremium: '100',
    currency: 'TRY',
    paymentMethodId: payment.id,
    installmentCount: null,
    assigneeMembershipId: 'demo-member-owner',
  });
  await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
  await page.locator('.today-task-row').first().waitFor();
  let row = page.getByRole('button', { name: /Sentetik İletişim Şirketi/ });
  if (!(await row.count())) {
    await page.getByRole('button', { name: 'Daha fazla iş yükle', exact: true }).click();
    await row.waitFor();
  }
  await row.click();
  await open(page, 'NOTE');
  assert.equal(await page.getByLabel('Şirket yetkilisi', { exact: true }).inputValue(), '');
  await page.getByLabel('Şirket yetkilisi', { exact: true }).selectOption(contacts[1].id);
  await page.getByLabel('İç not', { exact: true }).fill('Sentetik şirket notu');
  await page.getByRole('button', { name: 'İletişim kaydını kaydet', exact: true }).click();
  await saved(page);
  await open(page, 'NOTE');
  await page.getByLabel('Şirket yetkilisi', { exact: true }).selectOption(contacts[1].id);
  await page.getByLabel('İç not', { exact: true }).fill('Korunan şirket taslağı');
  const occurrence = await page
    .getByLabel('Gerçekleşme zamanı (İstanbul)', { exact: true })
    .inputValue();
  await post(page, `/api/customers/${customer.id}/contacts/${contacts[1].id}/deactivate`, {
    expectedVersion: contacts[1].version,
  });
  await page.getByRole('button', { name: 'İletişim kaydını kaydet', exact: true }).click();
  await page
    .getByRole('button', { name: 'Güncel iletişim bilgilerini karşılaştır', exact: true })
    .click();
  await page
    .getByLabel('Güncel bilgileri inceledim, taslağı yeniden göndermek istiyorum', { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel('Şirket yetkilisi', { exact: true }).inputValue(),
    contacts[1].id,
  );
  assert.equal(
    await page.getByLabel('İç not', { exact: true }).inputValue(),
    'Korunan şirket taslağı',
  );
  assert.equal(
    await page.getByLabel('Gerçekleşme zamanı (İstanbul)', { exact: true }).inputValue(),
    occurrence,
  );
  await page.getByLabel('Şirket yetkilisi', { exact: true }).selectOption(contacts[0].id);
  await page
    .getByLabel('Güncel bilgileri inceledim, taslağı yeniden göndermek istiyorum', { exact: true })
    .check();
  await page.getByRole('button', { name: 'İletişim kaydını kaydet', exact: true }).click();
  await saved(page);
  await page.getByText('Korunan şirket taslağı', { exact: true }).waitFor();
}
