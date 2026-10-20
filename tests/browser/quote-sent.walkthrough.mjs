import assert from 'node:assert/strict';
import { openWorkspaceSections } from './workspace-disclosures.mjs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers';
async function read(page, url) {
  return page.evaluate(async (url) => {
    const r = await globalThis.fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('SENT_READ_DENIED');
    return (await r.json()).data;
  }, url);
}
async function post(page, url, body, expected = 201, key) {
  return page.evaluate(
    async ({ url, body, expected, key }) => {
      const csrf = await globalThis.fetch('/api/csrf-token').then((r) => r.json());
      const r = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf.data.token,
          'Idempotency-Key': key ?? globalThis.crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      if (r.status !== expected) throw new Error('SENT_FIXTURE_STATUS');
      return (await r.json()).data;
    },
    { url, body, expected, key },
  );
}
const confirmLabel = 'Seçili sürümü dış kanaldan ilettiğimi ve gönderildi kaydını onaylıyorum';
async function select(page, quoteId) {
  await page.getByRole('button', { name: 'Teklifi gönderildi olarak kaydet', exact: true }).click();
  const choice = page.getByLabel('Gönderildi olarak kaydedilecek teklif ve güncel sürüm', {
    exact: true,
  });
  assert.equal(await choice.inputValue(), '');
  await choice.selectOption(quoteId);
}
async function submit(page) {
  await page.getByLabel(confirmLabel, { exact: true }).check();
  await page.getByRole('button', { name: 'Gönderildi kaydını onayla', exact: true }).click();
}
const success = (page) => page.getByText(/Gönderildi beyanı yetkili SENT olayıyla doğrulandı/);
async function refresh(page) {
  const button = page.getByRole('button', {
    name: 'Teklif geçmişini ve katalogları yeniden oku',
    exact: true,
  });
  await button.click();
  await button.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => !globalThis.document.querySelector('.quote-section > button')?.disabled,
  );
}
export async function quoteSentWalkthrough(page, index, mark, demo, evidence) {
  mark('sent-start-' + index);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('https://localhost:8443/today-work');
  await page.locator('.today-task-row').first().waitFor();
  // Establish same-document history for the existing early POP guard.
  await page.getByRole('link', { name: 'Klasik çalışma alanı', exact: true }).click();
  await page.getByRole('link', { name: 'Modern iş kuyruğuna dön', exact: true }).click();
  await page.locator('.today-task-row').first().click();
  await openWorkspaceSections(page);
  const task = (await read(page, '/api/tasks/today?limit=20')).items[0];
  const root = `/api/renewals/${task.renewalId}/quotes`;
  const initial = await read(page, root);
  await page.getByRole('button', { name: 'Teklif geçmişini aç', exact: true }).click();
  await page.getByRole('button', { name: 'Yeni teklif taslağı aç', exact: true }).waitFor();
  let forbidden = 0;
  const observe = (req) => {
    if (
      /\/whatsapp|\/close-won|\/close-lost|\/void|\/email|\/deliver/.test(
        new globalThis.URL(req.url()).pathname,
      )
    )
      forbidden++;
  };
  page.on('request', observe);
  try {
    for (const width of [1440, 768, 360]) {
      mark(`sent-${index}-${width}`);
      await page.setViewportSize({ width, height: 1000 });
      const version = {
        ...initial.defaultVersion,
        grossPremiumMinor: width + 1,
        termsSummary: `Sentetik SENT ${index}-${width}`,
      };
      const created = await post(page, root, {
        expectedRenewalVersion: task.renewalVersion,
        version,
      });
      if (index === 1 && width === 1440)
        await demo.db
          .prepare("UPDATE renewal_quotes SET status='READY',version=7 WHERE id=?")
          .bind(created.quoteId)
          .run();
      await refresh(page);
      const before = (await read(page, root)).quotes.find((q) => q.id === created.quoteId);
      const immutable = JSON.stringify(before.versions);
      await select(page, created.quoteId);
      const form = page.getByRole('form', { name: 'Gönderildi durum kaydı', exact: true });
      assert.ok(
        (await form.innerText()).includes(
          'Bu işlem müşteriye otomatik mesaj göndermez. Teklifi başka bir kanaldan ilettiyseniz gönderildi olarak kaydedin.',
        ),
      );
      assert.ok((await form.innerText()).includes('Anadolu Sigorta'));
      assert.ok((await form.innerText()).includes('TRY'));
      await form.scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      await page.screenshot({ path: join(evidence, `sent-${index}-${width}.png`) });
      const endpoint = `${root}/${created.quoteId}/send`,
        attempts = [];
      let lost = false,
        badRead = false,
        alterCurrent = false;
      const sentRoute = async (route) => {
        const req = route.request(),
          response = await route.fetch(),
          result = await response.json();
        attempts.push({
          url: req.url(),
          method: req.method(),
          body: req.postData(),
          key: req.headers()['idempotency-key'],
          status: response.status(),
          result: result.data,
        });
        if (width === 1440 && response.ok() && !lost) {
          lost = true;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ success: false }),
          });
        }
        if (width === 768 && response.ok()) badRead = true;
        return route.fulfill({ response });
      };
      const historyRoute = async (route) => {
        if (!badRead) return route.continue();
        badRead = false;
        const response = await route.fetch(),
          envelope = await response.json();
        const q = envelope.data.quotes.find((q) => q.id === created.quoteId);
        if (index === 0)
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ success: false }),
          });
        q.events.find((e) => e.event === 'SENT').operation_receipt_id =
          'incorrect-operation-receipt';
        return route.fulfill({ response, json: envelope });
      };
      await page.route('**' + endpoint, sentRoute);
      await page.route('**' + root, historyRoute);
      try {
        // Opening/selection are not a mutation and never infer final confirmation.
        assert.equal(attempts.length, 0);
        await page.getByRole('button', { name: 'Gönderildi kaydını onayla', exact: true }).click();
        await page
          .getByText('Gönderildi beyanı için son açık onay gerekir.', { exact: true })
          .waitFor();
        assert.equal(attempts.length, 0);
        if (width === 360) {
          mark('sent-version-conflict-' + index);
          await post(page, `${root}/${created.quoteId}/versions`, {
            expectedQuoteVersion: before.version,
            version: { ...version, termsSummary: 'Rakip immutable revizyon' },
          });
        }
        await submit(page);
        if (width === 1440) {
          await page
            .getByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene', exact: true })
            .waitFor();
          await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
          await page.getByText(/Teklif işleminin belirsiz sonucu/).waitFor();
          await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
          await page.getByText(/başka sayfaya geçilemez/).waitFor();
          const pinned = await page.evaluate(() => globalThis.history.state.idx);
          await page.evaluate(() => globalThis.history.back());
          await page.getByText(/Tarayıcı geri\/ileri geçişi durduruldu/).waitFor();
          await page.waitForFunction((idx) => globalThis.history.state.idx === idx, pinned);
          assert.equal(new globalThis.URL(page.url()).pathname, '/today-work');
          await page
            .getByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene', exact: true })
            .click();
        }
        if (width === 768) {
          await page
            .getByRole('button', { name: 'Yalnız gönderildi kanıtını yeniden oku', exact: true })
            .waitFor();
          assert.equal(await success(page).count(), 0);
          assert.equal(attempts.length, 1);
          await page.getByRole('button', { name: 'Görev listesine dön', exact: true }).click();
          await page.getByText(/Teklif işleminin belirsiz sonucu/).waitFor();
          if (index === 2) {
            const q = (await read(page, root)).quotes.find((q) => q.id === created.quoteId);
            await post(page, `${root}/${created.quoteId}/versions`, {
              expectedQuoteVersion: q.version,
              version: { ...version, grossPremiumMinor: 9901 },
            });
            alterCurrent = true;
          }
          await page
            .getByRole('button', { name: 'Yalnız gönderildi kanıtını yeniden oku', exact: true })
            .click();
        }
        if (width === 360) {
          await page
            .getByRole('button', {
              name: 'Gönderildi kaydı için güncel teklifi karşılaştır',
              exact: true,
            })
            .click();
          await page.getByText(/Seçili sürüm artık güncel\/gönderilebilir değil/).waitFor();
          assert.equal(
            await page
              .getByRole('button', { name: 'Gönderildi kaydını onayla', exact: true })
              .isDisabled(),
            true,
          );
          assert.equal(attempts.length, 1);
          await page
            .getByRole('button', { name: 'Gönderildi seçimini açıkça kapat', exact: true })
            .click();
          await select(page, created.quoteId);
          assert.equal(await page.getByLabel(confirmLabel, { exact: true }).isChecked(), false);
          await submit(page);
        }
        await success(page).waitFor();
        if (alterCurrent) {
          assert.ok((await success(page).innerText()).includes('güncel teklif durumu: Taslak'));
          assert.ok(
            (await success(page).innerText()).includes(
              'tarihsel beyan güncel sürümün gönderildiği anlamına gelmez',
            ),
          );
        }
        const last = attempts.at(-1),
          q = (await read(page, root)).quotes.find((q) => q.id === created.quoteId);
        assert.equal(q.events.filter((e) => e.event === 'SENT').length, 1);
        const event = q.events.find((e) => e.event === 'SENT');
        assert.equal(event.operation_receipt_id, last.result.operationId);
        assert.equal(event.quote_version_id, last.result.quoteVersionId);
        assert.equal(last.result.quoteId, created.quoteId);
        assert.equal(last.result.versionNumber, width === 360 ? 2 : 1);
        assert.deepEqual(Object.keys(JSON.parse(last.body)).sort(), [
          'expectedQuoteVersion',
          'quoteVersionId',
        ]);
        assert.equal(JSON.parse(last.body).quoteVersionId, last.result.quoteVersionId);
        assert.equal(
          JSON.parse(last.body).expectedQuoteVersion,
          width === 360 ? before.version + 1 : before.version,
        );
        if (width === 1440) {
          assert.deepEqual(
            attempts.map((a) => a.status),
            [201, 200],
          );
          for (const k of ['url', 'method', 'body', 'key'])
            assert.equal(attempts[0][k], attempts[1][k]);
          assert.equal(JSON.stringify(q.versions), immutable);
        } else assert.equal(attempts.length, width === 360 ? 2 : 1);
        if (width === 360) assert.notEqual(attempts[0].key, attempts[1].key);
        const storage = await page.evaluate(() =>
          JSON.stringify({
            ...globalThis.localStorage,
            ...globalThis.sessionStorage,
            history: globalThis.history.state,
          }),
        );
        for (const a of attempts) assert.ok(!storage.includes(a.key) && !storage.includes(a.body));
        assert.ok(!storage.includes(version.termsSummary));
      } finally {
        await page.unroute('**' + endpoint, sentRoute);
        await page.unroute('**' + root, historyRoute);
      }
    }
    // Real expiry: the selected version may expire while confirmation is on screen.
    mark('sent-expiry-before-submit-' + index);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const until = new Date(Date.now() + 10000).toISOString();
    const expired = await post(page, root, {
      expectedRenewalVersion: task.renewalVersion,
      version: { ...initial.defaultVersion, validUntil: until },
    });
    await refresh(page);
    await select(page, expired.quoteId);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(until) - Date.now() + 100)),
    );
    let expiryPosts = 0;
    const expiryObserve = (req) => {
      if (req.method() === 'POST' && req.url().endsWith(`/${expired.quoteId}/send`)) expiryPosts++;
    };
    page.on('request', expiryObserve);
    try {
      await submit(page);
      await page.getByText(/Seçili teklif sürümünün geçerlilik süresi doldu/).waitFor();
      assert.equal(expiryPosts, 0);
      await page
        .getByRole('button', { name: 'Gönderildi seçimini açıkça kapat', exact: true })
        .click();
    } finally {
      page.off('request', expiryObserve);
    }
    const before = JSON.stringify(
      (await read(page, root)).quotes.find((q) => q.id === expired.quoteId),
    );
    const evidenceCounts = async () => {
      const result = {};
      for (const table of ['renewal_quote_events', 'operation_receipts', 'audit_events'])
        result[table] = (await demo.db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;
      return result;
    };
    const expiryBefore = await evidenceCounts();
    await post(
      page,
      `${root}/${expired.quoteId}/send`,
      { expectedQuoteVersion: 1, quoteVersionId: expired.quoteVersionId },
      409,
    );
    assert.equal(
      JSON.stringify((await read(page, root)).quotes.find((q) => q.id === expired.quoteId)),
      before,
    );
    assert.deepEqual(await evidenceCounts(), expiryBefore);
    if (index > 0) {
      mark('sent-manage-revocation-' + index);
      const member = 'demo-member-' + ['owner', 'ahmet', 'ayse'][index];
      const grant = await demo.db
        .prepare(
          "SELECT id,scope FROM membership_permissions WHERE membership_id=? AND permission_code='quote.manage'",
        )
        .bind(member)
        .first();
      assert.ok(grant);
      const remaining = (await read(page, root)).quotes.find(
        (q) =>
          ['DRAFT', 'READY'].includes(q.status) &&
          Date.parse(q.versions.find((v) => v.id === q.current_version_id)?.valid_until) >
            Date.now(),
      );
      assert.ok(remaining);
      await refresh(page);
      await select(page, remaining.id);
      await demo.db
        .prepare(
          "DELETE FROM membership_permissions WHERE membership_id=? AND permission_code='quote.manage'",
        )
        .bind(member)
        .run();
      const beforeDenied = await evidenceCounts();
      try {
        await submit(page);
        await page
          .getByText(/Yetkili kayıt yeniden doğrulanana kadar seçimin ayrıntıları gizlidir/)
          .waitFor();
        assert.equal(await page.locator('.quote-record').count(), 0);
        assert.deepEqual(await evidenceCounts(), beforeDenied);
        assert.equal(
          (await read(page, root)).quotes.some((q) => q.id === remaining.id),
          true,
        );
      } finally {
        await demo.db
          .prepare(
            "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'quote.manage',?)",
          )
          .bind(grant.id, member, grant.scope)
          .run();
      }
      await page
        .getByRole('button', {
          name: 'Gönderildi kaydı için güncel teklifi karşılaştır',
          exact: true,
        })
        .click();
      await page
        .getByRole('complementary', {
          name: 'Önceki ve güncel teklif karşılaştırması',
          exact: true,
        })
        .waitFor();
      assert.equal(await page.getByLabel(confirmLabel, { exact: true }).isChecked(), false);
      await page
        .getByRole('button', { name: 'Gönderildi seçimini açıkça kapat', exact: true })
        .click();
    }
    assert.equal(forbidden, 0);
    // End the real session with a live send form/pinned target and verify protected cleanup.
    mark('sent-session-revocation-' + index);
    await refresh(page);
    const remaining = (await read(page, root)).quotes.find(
      (q) =>
        ['DRAFT', 'READY'].includes(q.status) &&
        Date.parse(q.versions.find((v) => v.id === q.current_version_id)?.valid_until) > Date.now(),
    );
    assert.ok(remaining);
    await select(page, remaining.id);
    await demo.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
      .bind(Date.now(), 'demo-user-' + ['owner', 'ahmet', 'ayse'][index])
      .run();
    await submit(page);
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).waitFor();
    assert.equal(await page.locator('.quote-record').count(), 0);
    assert.equal(await page.locator('.quote-send-form').count(), 0);
    assert.equal(await page.locator('.today-task-row').count(), 0);
  } finally {
    page.off('request', observe);
  }
}
