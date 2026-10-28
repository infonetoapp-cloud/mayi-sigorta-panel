import assert from 'node:assert/strict';
export async function verifyPolicyParties(page, id, index) {
  await page.getByRole('link', { name: 'Sigortalılar ve lehtarlar', exact: true }).click();
  for (const role of ['INSURED', 'BENEFICIARY']) {
    await page.getByRole('button', { name: 'Taraf ekle', exact: true }).click();
    await page.getByLabel('Müşteri ara', { exact: true }).fill('Deniz');
    await page.getByRole('button', { name: 'Müşterileri ara', exact: true }).click();
    await page
      .getByRole('option', { name: 'Deniz Yılmaz', exact: true })
      .waitFor({ state: 'attached' });
    await page.getByLabel('Müşteri seçimi', { exact: true }).selectOption('demo-customer-0');
    await page.getByText('Doğrulanan müşteri: Deniz Yılmaz', { exact: true }).waitFor();
    await page.getByLabel('Taraf rolü', { exact: true }).selectOption(role);
    for (const width of [1440, 768, 360]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
    }
    if (!index && role === 'INSURED')
      assert.equal(
        await page.evaluate(async (id) => {
          const p = (await (await globalThis.fetch('/api/policies/' + id)).json()).data;
          const csrf = (await (await globalThis.fetch('/api/csrf-token')).json()).data.token;
          return (
            await globalThis.fetch('/api/policies/' + id, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrf,
                'Idempotency-Key': globalThis.crypto.randomUUID(),
              },
              body: JSON.stringify({ expectedVersion: p.version, grossPremium: '2345.68' }),
            })
          ).status;
        }, id),
        200,
      );
    const attempts = [];
    let lost = false;
    if (index === 1 && role === 'INSURED')
      await page.route('**/api/policies/' + id + '/parties', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        attempts.push({
          body: route.request().postData(),
          key: route.request().headers()['idempotency-key'],
        });
        const r = await route.fetch();
        assert.equal(r.status(), 201);
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
    await page.getByRole('button', { name: 'Tarafı kaydet', exact: true }).click();
    if (!index && role === 'INSURED') {
      await page.getByRole('button', { name: 'Güncel tarafları karşılaştır', exact: true }).click();
      await page
        .getByRole('button', { name: 'Karşılaştırdım, işlemi onayla', exact: true })
        .click();
    }
    if (index === 1 && role === 'INSURED')
      await page.getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true }).click();
    await page.getByText('Poliçe tarafı eklendi.', { exact: true }).waitFor();
    if (index === 1 && role === 'INSURED') {
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0], attempts[1]);
      await page.unroute('**/api/policies/' + id + '/parties');
    }
    await page
      .getByRole('region', {
        name: 'Deniz Yılmaz ' + (role === 'INSURED' ? 'Sigortalı' : 'Lehtar'),
        exact: true,
      })
      .waitFor();
  }
  assert.equal(await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).count(), 0);
  const insuredRow = page.getByRole('region', { name: 'Deniz Yılmaz Sigortalı', exact: true });
  const before = await page.evaluate(
    async (id) =>
      (await (await globalThis.fetch('/api/policies/' + id + '/parties')).json()).data.find(
        (p) => p.role === 'INSURED',
      ),
    id,
  );
  const deactivations = [];
  let lost = false,
    writeDone = false,
    lostRead = false;
  await page.route('**/api/policies/' + id + '/**', async (route) => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/deactivate')) {
      deactivations.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key'],
      });
      const r = await route.fetch();
      assert.equal(r.status(), 200);
      writeDone = true;
      if (index === 2 && !lost) {
        lost = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        });
      }
      return route.fulfill({ response: r });
    }
    if (index === 0 && writeDone && !lostRead && route.request().url().endsWith('/parties')) {
      lostRead = true;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false }),
      });
    }
    return route.continue();
  });
  await insuredRow.getByRole('button', { name: 'Tarafı pasifleştir', exact: true }).click();
  assert.equal(deactivations.length, 0);
  await page.getByRole('button', { name: 'Pasifleştirmeyi onayla', exact: true }).click();
  if (index === 2)
    await page.getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true }).click();
  if (index === 0)
    await page
      .getByRole('button', { name: 'Kaydedilen tarafları yeniden oku', exact: true })
      .click();
  await page.getByText('Poliçe tarafı pasifleştirildi.', { exact: true }).waitFor();
  await insuredRow.getByText('Sigortalı · Pasif', { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(deactivations[0].body), { expectedVersion: before.version });
  if (index === 2) {
    assert.equal(deactivations.length, 2);
    assert.deepEqual(deactivations[0], deactivations[1]);
  } else assert.equal(deactivations.length, 1);
  await page.unroute('**/api/policies/' + id + '/**');
  await page.reload();
  await page
    .getByRole('region', { name: 'Deniz Yılmaz Sigortalı', exact: true })
    .getByText('Sigortalı · Pasif', { exact: true })
    .waitFor();
  const parties = await page.evaluate(
    async (id) => (await (await globalThis.fetch('/api/policies/' + id + '/parties')).json()).data,
    id,
  );
  assert.deepEqual(
    parties.map((p) => [p.customerId, p.role, p.status]),
    [
      ['demo-customer-0', 'INSURED', 'INACTIVE'],
      ['demo-customer-0', 'BENEFICIARY', 'ACTIVE'],
    ],
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
}
