import assert from 'node:assert/strict';
import { join } from 'node:path';
async function get(page, url) {
  return page.evaluate(async (url) => {
    const r = await globalThis.fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('QUOTE_READ_FAILED');
    return (await r.json()).data;
  }, url);
}
async function competingVersion(page, url, body, status = 201) {
  return page.evaluate(
    async ({ url, body, status }) => {
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
      if (r.status !== status) throw new Error('COMPETING_QUOTE_VERSION_FAILED');
      return (await r.json()).data;
    },
    { url, body, status },
  );
}
function version(v) {
  return {
    insurerId: v.insurer_id,
    productId: v.product_id,
    branchId: v.branch_id,
    paymentMethodId: v.payment_method_id,
    startDate: v.start_date,
    endDate: v.end_date,
    validUntil: v.valid_until,
    grossPremiumMinor: v.gross_premium_minor,
    currency: v.currency,
    installmentCount: v.installment_count,
    termsSummary: v.terms_summary,
  };
}
export async function quoteWalkthrough(page, index, mark, evidence) {
  mark('modern-quotes-' + index);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const reads = [],
    writes = [];
  let lostCreate = false,
    lostVersion = false,
    failRead = false,
    failedRead = false,
    denyRead = false,
    forbiddenRoutes = 0,
    renewalId;
  const observe = (request) => {
    const u = new globalThis.URL(request.url());
    if (u.pathname.endsWith('/quotes') && request.method() === 'GET') reads.push(u.pathname);
    if (/\/quotes\/[^/]+\/send$|\/close-won$|\/close-lost$|\/whatsapp/.test(u.pathname))
      forbiddenRoutes++;
  };
  page.on('request', observe);
  await page.goto('https://localhost:8443/today-work');
  await page.locator('.today-task-row').first().waitFor();
  if (!index) {
    // Create a real same-document Router history entry before testing POP protection.
    // A previous page.goto entry instead tests native beforeunload across documents.
    await page.getByRole('link', { name: 'Klasik çalışma alanı', exact: true }).click();
    await page.getByRole('link', { name: 'Modern iş kuyruğuna dön', exact: true }).click();
    await page.locator('.today-task-row').first().waitFor();
  }
  await page.locator('.today-task-row').first().click();
  await page.getByRole('button', { name: 'Teklif geçmişini aç', exact: true }).waitFor();
  assert.equal(reads.length, 0);
  const task = (await get(page, '/api/tasks/today?limit=20')).items[0];
  renewalId = task.renewalId;
  const endpoint = `/api/renewals/${renewalId}/quotes`,
    pattern = '**' + endpoint + '**';
  await page.route(pattern, async (route) => {
    const req = route.request(),
      url = new globalThis.URL(req.url());
    if (req.method() === 'POST') {
      const response = await route.fetch(),
        envelope = await response.json();
      writes.push({
        url: req.url(),
        method: req.method(),
        body: req.postData(),
        key: req.headers()['idempotency-key'],
        status: response.status(),
        result: envelope.data,
      });
      if (response.ok() && index === 0 && url.pathname === endpoint && !lostCreate) {
        lostCreate = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        });
      }
      if (response.ok() && index === 2 && url.pathname.endsWith('/versions') && !lostVersion) {
        lostVersion = true;
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        });
      }
      if (response.ok() && index === 1 && url.pathname === endpoint) failRead = true;
      return route.fulfill({ response });
    }
    if (denyRead)
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Denied' } }),
      });
    if (failRead && !failedRead) {
      failedRead = true;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false }),
      });
    }
    return route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Teklif geçmişini aç', exact: true }).click();
    await page.getByRole('button', { name: 'Yeni teklif taslağı aç', exact: true }).waitFor();
    const initial = await get(page, endpoint);
    // Opening a quote draft must not overwrite an existing communication draft.
    await page.getByRole('button', { name: 'İletişim kaydı ekle', exact: true }).click();
    await page.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
    await page.getByLabel('İç not', { exact: true }).fill('Korunan teklif öncesi iletişim');
    await page.getByRole('button', { name: 'Yeni teklif taslağı aç', exact: true }).click();
    await page.getByText(/İletişim\/görev taslağını açıkça kapatın/).waitFor();
    assert.equal(
      await page.getByLabel('İç not', { exact: true }).inputValue(),
      'Korunan teklif öncesi iletişim',
    );
    assert.equal(
      await page.getByRole('form', { name: 'Yeni teklif formu', exact: true }).count(),
      0,
    );
    await page.getByRole('button', { name: 'Formu kapat ve taslağı bırak', exact: true }).click();
    await page.getByRole('button', { name: 'Yeni teklif taslağı aç', exact: true }).click();
    await page.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).fill('0,50');
    const alternative =
      index === 1
        ? { insurerId: 'demo-insurer', productId: 'edge-sibling-product' }
        : { insurerId: 'edge-alternative-insurer', productId: 'edge-alternative-product' };
    await page
      .getByLabel('Teklif sigorta şirketi', { exact: true })
      .selectOption(alternative.insurerId);
    await page.getByLabel('Teklif ürünü', { exact: true }).selectOption(alternative.productId);
    const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    await page
      .getByLabel('Teklif geçerlilik sonu (İstanbul)', { exact: true })
      .fill(date + 'T13:45');
    await page
      .getByLabel('Teklif koşulları', { exact: true })
      .fill('Sentetik teklif koşulu ' + index);
    for (const width of [1440, 768, 360]) {
      mark('quote-create-form-' + index + '-' + width);
      await page.setViewportSize({ width, height: 950 });
      await page
        .getByLabel('Teklif brüt primi (ana birim)', { exact: true })
        .scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      assert.equal(
        await page.getByRole('form', { name: 'Yeni teklif formu', exact: true }).isVisible(),
        true,
      );
    }
    await page.getByLabel('Yeni teklif kaydını oluşturmayı onaylıyorum', { exact: true }).check();
    await page.getByRole('button', { name: 'Teklifi oluştur', exact: true }).click();
    if (!index) {
      await page
        .getByRole('button', { name: 'Aynı teklif isteğini yeniden dene', exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
      await page.getByText(/Teklif işleminin belirsiz sonucu/).waitFor();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
      await page.getByText(/başka sayfaya geçilemez/).waitFor();
      const pinnedIndex = await page.evaluate(() => globalThis.history.state.idx);
      await page.evaluate(() => globalThis.history.back());
      await page.getByText(/Tarayıcı geri\/ileri geçişi durduruldu/).waitFor();
      await page.waitForFunction((index) => globalThis.history.state.idx === index, pinnedIndex);
      assert.equal(new globalThis.URL(page.url()).pathname, '/today-work');
      await page.getByRole('link', { name: 'Klasik iş akışını aç', exact: true }).click();
      await page
        .getByRole('button', { name: 'Aynı teklif isteğini yeniden dene', exact: true })
        .click();
    }
    if (index === 1)
      await page
        .getByRole('button', { name: 'Yalnız teklif geçmişini yeniden oku', exact: true })
        .click();
    await page.getByText('Teklif yetkili geçmiş okumasıyla doğrulandı.', { exact: true }).waitFor();
    const createAttempts = writes.filter((w) => new globalThis.URL(w.url).pathname === endpoint);
    assert.equal(createAttempts.length, index === 0 ? 2 : 1);
    if (!index)
      for (const field of ['url', 'method', 'body', 'key'])
        assert.equal(createAttempts[0][field], createAttempts[1][field]);
    const created = createAttempts.at(-1).result;
    const h = await get(page, endpoint),
      q = h.quotes.find((q) => q.id === created.quoteId);
    assert.equal(h.quotes.length, initial.quotes.length + 1);
    assert.equal(q.status, 'DRAFT');
    assert.equal(q.current_version_id, created.quoteVersionId);
    assert.equal(q.versions[0].gross_premium_minor, 50);
    assert.equal(q.versions[0].insurer_id, alternative.insurerId);
    assert.equal(q.versions[0].product_id, alternative.productId);
    assert.equal(q.versions[0].valid_until, date + 'T10:45:00.000Z');
    const old = JSON.stringify(q.versions[0]),
      position = h.quotes.findIndex((row) => row.id === q.id) + 1;
    await page
      .getByRole('button', {
        name: `Teklif ${position} için yeni değişmez sürüm taslağı aç`,
        exact: true,
      })
      .click();
    await page.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).fill('0,51');
    assert.equal(
      await page.getByLabel('Teklif sigorta şirketi', { exact: true }).isDisabled(),
      true,
    );
    assert.equal(await page.getByLabel('Teklif ürünü', { exact: true }).isDisabled(), true);
    await page
      .getByLabel('Teklif koşulları', { exact: true })
      .fill('Sentetik yeni değişmez sürüm ' + index);
    for (const width of [1440, 768, 360]) {
      mark('quote-version-form-' + index + '-' + width);
      await page.setViewportSize({ width, height: 950 });
      await page
        .getByLabel('Teklif brüt primi (ana birim)', { exact: true })
        .scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
    }
    const versionEndpoint = endpoint + '/' + q.id + '/versions';
    mark('quote-identity-negative-' + index);
    await competingVersion(
      page,
      versionEndpoint,
      {
        expectedQuoteVersion: q.version,
        version: {
          ...version(q.versions[0]),
          insurerId: initial.defaultVersion.insurerId,
          productId: initial.defaultVersion.productId,
        },
      },
      409,
    );
    assert.equal(
      JSON.stringify((await get(page, endpoint)).quotes.find((row) => row.id === q.id)),
      JSON.stringify(q),
    );
    if (!index) {
      mark('quote-conflict-compare');
      await competingVersion(page, versionEndpoint, {
        expectedQuoteVersion: q.version,
        version: { ...version(q.versions[0]), termsSummary: 'Eşzamanlı kayıtlı sürüm' },
      });
      await page
        .getByLabel('Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum', {
          exact: true,
        })
        .check();
      await page.getByRole('button', { name: 'Yeni değişmez sürümü oluştur', exact: true }).click();
      await page
        .getByRole('button', { name: 'Güncel teklif durumunu karşılaştır', exact: true })
        .click();
      await page.getByText(/Güncel yenileme v/).waitFor();
      assert.equal(
        await page.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).inputValue(),
        '0,51',
      );
      assert.equal(
        await page.getByLabel('Teklif koşulları', { exact: true }).inputValue(),
        'Sentetik yeni değişmez sürüm ' + index,
      );
    }
    await page
      .getByLabel('Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum', { exact: true })
      .check();
    await page.getByRole('button', { name: 'Yeni değişmez sürümü oluştur', exact: true }).click();
    if (index === 2)
      await page
        .getByRole('button', { name: 'Aynı sürüm isteğini yeniden dene', exact: true })
        .click();
    await page.getByText('Teklif yetkili geçmiş okumasıyla doğrulandı.', { exact: true }).waitFor();
    const versions = writes.filter((w) => new globalThis.URL(w.url).pathname === versionEndpoint),
      last = versions.at(-1);
    if (index === 2)
      for (const field of ['url', 'method', 'body', 'key'])
        assert.equal(versions.at(-2)[field], last[field]);
    const after = (await get(page, endpoint)).quotes.find((row) => row.id === q.id);
    assert.equal(JSON.stringify(after.versions[0]), old);
    assert.equal(after.versions.length, index === 0 ? 3 : 2);
    assert.equal(last.result.versionNumber, index === 0 ? 3 : 2);
    assert.equal(after.current_version_id, last.result.quoteVersionId);
    assert.equal(after.versions.at(-1).gross_premium_minor, 51);
    assert.equal(after.versions.at(-1).insurer_id, alternative.insurerId);
    assert.equal(after.versions.at(-1).product_id, alternative.productId);
    for (const width of [1440, 768, 360]) {
      await page.setViewportSize({ width, height: 950 });
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      await page.getByRole('heading', { name: 'Teklifler', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `quotes-${index}-${width}.png`) });
    }
    for (const write of writes) {
      const body = JSON.parse(write.body);
      assert.deepEqual(
        Object.keys(body).sort(),
        new globalThis.URL(write.url).pathname === endpoint
          ? ['expectedRenewalVersion', 'version']
          : ['expectedQuoteVersion', 'version'],
      );
      assert.deepEqual(Object.keys(body.version).sort(), [
        'branchId',
        'currency',
        'endDate',
        'grossPremiumMinor',
        'installmentCount',
        'insurerId',
        'paymentMethodId',
        'productId',
        'startDate',
        'termsSummary',
        'validUntil',
      ]);
    }
    denyRead = true;
    await page
      .getByRole('button', { name: 'Teklif geçmişini ve katalogları yeniden oku', exact: true })
      .click();
    await page.getByText(/Teklif geçmişine erişilemiyor/).waitFor();
    assert.equal(await page.locator('.quote-record').count(), 0);
    assert.equal(
      await page.getByRole('button', { name: 'Yeni takip planını aç', exact: true }).count(),
      1,
    );
    assert.equal(
      await page
        .getByRole('region', { name: 'Yenileme iletişim geçmişi ve kaydı', exact: true })
        .count(),
      1,
    );
    denyRead = false;
    await page
      .getByRole('button', { name: 'Teklif geçmişini ve katalogları yeniden oku', exact: true })
      .click();
    await page.locator('.quote-record').first().waitFor();
    assert.equal(forbiddenRoutes, 0);
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...globalThis.localStorage, ...globalThis.sessionStorage }),
    );
    assert.ok(
      !storage.includes('Sentetik teklif koşulu') &&
        !storage.includes('Sentetik yeni değişmez sürüm'),
    );
    for (const write of writes) assert.ok(!storage.includes(write.key));
  } finally {
    await page.unroute(pattern);
    page.off('request', observe);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}
