import assert from 'node:assert/strict';
export async function verifyPolicyAppend(page, id, index) {
  const original = await page.evaluate(
    async (id) => (await (await globalThis.fetch('/api/policies/' + id)).json()).data,
    id,
  );
  await page.getByRole('link', { name: 'Zeyiller', exact: true }).click();
  for (const [n, value] of ['12.34', '-0.50', '0', null].entries()) {
    await page.getByRole('button', { name: 'Zeyil ekle', exact: true }).click();
    await page.getByLabel('Dış zeyil referansı', { exact: true }).fill(`ZEYL-${index}-${n}`);
    await page.getByLabel('Geçerlilik tarihi', { exact: true }).fill('2027-05-01');
    await page.getByLabel('Açıklama', { exact: true }).fill('Sentetik tarihsel zeyil');
    if (value !== null) {
      await page.getByLabel('Prim farkı', { exact: true }).fill(value);
      await page.getByLabel('ISO para birimi', { exact: true }).fill('TRY');
    }
    for (const width of [1440, 768, 360]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
    }
    if (!index && n === 0)
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
    const attempts = [];
    let lost = false,
      writeDone = false,
      lostRead = false;
    await page.route('**/api/policies/' + id + '/amendments', async (route) => {
      if (route.request().method() === 'POST') {
        attempts.push({
          body: route.request().postData(),
          key: route.request().headers()['idempotency-key'],
        });
        const r = await route.fetch();
        if (r.status() === 201) writeDone = true;
        if (index === 1 && n === 0 && !lost && r.status() === 201) {
          lost = true;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ success: false }),
          });
        }
        return route.fulfill({ response: r });
      }
      if (index === 2 && n === 0 && writeDone && !lostRead) {
        lostRead = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        });
      }
      return route.continue();
    });
    await page.getByRole('button', { name: 'Zeyili kaydet', exact: true }).click();
    if (!index && n === 0) {
      await page.getByRole('button', { name: 'Güncel kayıtları karşılaştır', exact: true }).click();
      assert.equal(
        await page.getByLabel('Dış zeyil referansı', { exact: true }).inputValue(),
        `ZEYL-${index}-${n}`,
      );
      await page.getByRole('button', { name: 'Karşılaştırdım, kaydet', exact: true }).click();
    }
    if (index === 1 && n === 0)
      await page.getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true }).click();
    if (index === 2 && n === 0)
      await page
        .getByRole('button', { name: 'Kaydedilen listeyi yeniden oku', exact: true })
        .click();
    await page.getByText('Zeyil eklendi.', { exact: true }).waitFor();
    await page.getByText(`ZEYL-${index}-${n}`, { exact: true }).waitFor();
    if (index === 1 && n === 0) {
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0], attempts[1]);
    } else assert.equal(attempts.length, !index && n === 0 ? 2 : 1);
    await page.unroute('**/api/policies/' + id + '/amendments');
  }
  const amended = await page.evaluate(
    async (id) => ({
      policy: (await (await globalThis.fetch('/api/policies/' + id)).json()).data,
      rows: (await (await globalThis.fetch('/api/policies/' + id + '/amendments')).json()).data,
    }),
    id,
  );
  assert.equal(amended.policy.grossPremiumMinor, original.grossPremiumMinor);
  assert.equal(amended.policy.endDate, original.endDate);
  assert.equal(amended.policy.status, original.status);
  assert.deepEqual(
    amended.rows.map((r) => r.premiumDifferenceMinor),
    [1234, -50, 0, null],
  );
  await page.getByRole('link', { name: 'Dış referanslar', exact: true }).click();
  await page.getByRole('button', { name: 'Dış referans ekle', exact: true }).click();
  await page.getByLabel('Kaynak ad alanı', { exact: true }).fill('synthetic');
  await page.getByLabel('Dış anahtar', { exact: true }).fill('REF-' + index);
  const attempts = [];
  let lost = false;
  await page.route('**/api/policies/' + id + '/external-references', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
    });
    const r = await route.fetch();
    assert.equal(r.status(), 201);
    if (!index && !lost) {
      lost = true;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false }),
      });
    }
    return route.fulfill({ response: r });
  });
  for (const width of [1440, 768, 360]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
      ),
      true,
    );
  }
  await page.getByRole('button', { name: 'Referansı kaydet', exact: true }).click();
  if (!index)
    await page.getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true }).click();
  await page.getByText('Dış referans eklendi.', { exact: true }).waitFor();
  if (!index) {
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
  }
  await page.unroute('**/api/policies/' + id + '/external-references');
  await page.getByRole('button', { name: 'Dış referans ekle', exact: true }).click();
  await page.getByLabel('Kaynak ad alanı', { exact: true }).fill('synthetic');
  await page.getByLabel('Dış anahtar', { exact: true }).fill('REF-' + index);
  await page.getByRole('button', { name: 'Referansı kaydet', exact: true }).click();
  await page.getByRole('button', { name: 'Güncel kayıtları karşılaştır', exact: true }).click();
  await page.getByRole('button', { name: 'Karşılaştırdım, kaydet', exact: true }).click();
  await page
    .getByText(
      'Bu kaynak ve dış anahtar güncel listede zaten mevcut. İkinci kayıt gönderilmedi; taslağı düzeltin veya vazgeçin.',
      { exact: true },
    )
    .waitFor();
  await page.getByRole('button', { name: 'Vazgeç', exact: true }).click();
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await (await globalThis.fetch('/api/policies/' + id + '/external-references')).json()).data
          .length,
      id,
    ),
    1,
  );
  await page.reload();
  await page.getByText('REF-' + index, { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Zeyiller', exact: true }).click();
  await page.getByText('ZEYL-' + index + '-0', { exact: true }).waitFor();
  await page.goBack();
  await page.getByText('REF-' + index, { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
}
