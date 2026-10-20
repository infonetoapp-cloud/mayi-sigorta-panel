import assert from 'node:assert/strict';
import { openWorkspaceSections } from './workspace-disclosures.mjs';
import { join } from 'node:path';
async function read(page, url) {
  return page.evaluate(async (url) => {
    const r = await globalThis.fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('TERMINAL_READ_DENIED');
    return (await r.json()).data;
  }, url);
}
async function selectTask(page, later = false) {
  await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
  await page.locator('.today-task-row').first().waitFor();
  const first = await read(page, '/api/tasks/today?limit=20');
  let task = first.items[0],
    original = '/api/tasks/today?limit=20';
  if (later) {
    assert.ok(first.nextCursor);
    original += '&cursor=' + encodeURIComponent(first.nextCursor);
    const next = await read(page, original);
    task = next.items[0];
    assert.ok(task);
    await page.getByRole('button', { name: 'Daha fazla iş yükle', exact: true }).click();
  }
  const rows = page.locator('.today-task-row');
  const wanted = rows.filter({ has: page.locator('small', { hasText: task.policyNumber }) });
  await wanted.first().click();
  await openWorkspaceSections(page);
  await page.getByRole('region', { name: 'Yenileme sonuçlandırma', exact: true }).waitFor();
  return { task, original };
}
async function selectExactTask(page, taskId) {
  await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
  let url = '/api/tasks/today?limit=20';
  for (let n = 0; n < 10; n++) {
    const data = await read(page, url),
      task = data.items.find((t) => t.taskId === taskId);
    if (task) {
      await page
        .locator('.today-task-row')
        .filter({ has: page.getByText(task.policyNumber, { exact: true }) })
        .click();
      await openWorkspaceSections(page);
      return task;
    }
    assert.ok(data.nextCursor, 'EXPLICIT_TARGET_NOT_IN_AUTHORIZED_QUEUE');
    url = '/api/tasks/today?limit=20&cursor=' + encodeURIComponent(data.nextCursor);
    await page.getByRole('button', { name: 'Daha fazla iş yükle', exact: true }).click();
  }
  throw new Error('EXPLICIT_TARGET_PAGE_BOUND');
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
      if (!r.ok) throw new Error('TERMINAL_COMPETING_OPERATION_FAILED');
      return (await r.json()).data;
    },
    { url, body },
  );
}
async function terminalSnapshot(db, task) {
  return JSON.stringify({
    effects: await effects(db, task),
    history: (
      await db
        .prepare('SELECT * FROM renewal_state_history WHERE renewal_id=? ORDER BY id')
        .bind(task.renewalId)
        .all()
    ).results,
    receipts: (await db.prepare('SELECT count(*) n FROM operation_receipts').first()).n,
    audits: (
      await db.prepare("SELECT count(*) n FROM audit_events WHERE outcome='SUCCESS'").first()
    ).n,
  });
}
async function openLost(page, other = false) {
  await page.getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır', exact: true }).click();
  const choice = page.getByRole('combobox', { name: 'Kayıp nedeni', exact: true });
  await choice.locator('option[value="demo-loss-price"]').waitFor({ state: 'attached' });
  assert.equal(await choice.inputValue(), '');
  await choice.selectOption(other ? 'demo-loss-other' : 'demo-loss-price');
  if (other)
    await page
      .getByLabel('Diğer kayıp açıklaması', { exact: true })
      .fill('  Sentetik diğer kayıp nedeni  ');
}
async function submit(page, kind = 'LOST') {
  await page.getByLabel(`${kind} sonucunu ve seçili nedeni onaylıyorum`, { exact: true }).check();
  await page.getByRole('button', { name: `${kind} kaydını onayla`, exact: true }).click();
}
const success = (page) =>
  page.getByText(/POST yanıtı ve yetkili yenileme state\/sürüm okuması doğrulandı/);
async function effects(db, task) {
  return {
    renewal: await db
      .prepare(
        'SELECT state,version,closed_at,loss_reason_id,loss_reason_notes,void_reason_code FROM renewal_opportunities WHERE id=?',
      )
      .bind(task.renewalId)
      .first(),
    tasks: (
      await db
        .prepare('SELECT id,status,version FROM tasks WHERE renewal_id=? ORDER BY id')
        .bind(task.renewalId)
        .all()
    ).results,
  };
}
async function evidence(db, task, result, key) {
  assert.equal(result.renewalId, task.renewalId);
  assert.equal(result.primaryTaskId, task.taskId);
  assert.equal(result.renewalVersion, task.renewalVersion + 1);
  assert.equal(result.taskVersion, task.taskVersion + 1);
  assert.equal(new Date(result.closedAt).toISOString(), result.closedAt);
  const state = await effects(db, task);
  assert.equal(state.renewal.state, result.state);
  assert.equal(state.renewal.version, result.renewalVersion);
  assert.equal(state.tasks.length, task.expectedTaskCount ?? 1);
  const completed = state.tasks.find((t) => t.id === task.taskId);
  assert.ok(completed);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.version, result.taskVersion);
  assert.ok(state.tasks.every((t) => t.status === 'COMPLETED'));
  for (const table of ['operation_receipts', 'audit_events'])
    assert.equal(
      (
        await db
          .prepare(`SELECT count(*) n FROM ${table} WHERE idempotency_key=?`)
          .bind(key)
          .first()
      ).n,
      1,
    );
  assert.equal(
    (
      await db
        .prepare('SELECT count(*) n FROM renewal_state_history WHERE renewal_id=?')
        .bind(task.renewalId)
        .first()
    ).n,
    2,
  );
}
export async function terminalOutcomeWalkthrough(page, index, mark, demo, directory) {
  const actor = ['owner', 'ahmet', 'ayse'][index],
    permissions = {
      ownLost: 'ALLOW',
      ownVoid: index ? 'DENY' : 'ALLOW',
      otherPrivateTask: index ? 'DENY' : 'ALLOW',
    };
  await page.goto('https://localhost:8443/today-work');
  await page.locator('.today-task-row').first().waitFor();
  await page.getByRole('link', { name: 'Klasik çalışma alanı', exact: true }).click();
  await page.getByRole('link', { name: 'Modern iş kuyruğuna dön', exact: true }).click();
  let prohibited = 0;
  const observe = (req) => {
    if (
      req.method() === 'POST' &&
      /\/close-won|\/accept|\/reject|\/whatsapp|\/email|\/deliver|\/archive/.test(
        new globalThis.URL(req.url()).pathname,
      )
    )
      prohibited++;
  };
  page.on('request', observe);
  try {
    for (const width of [1440, 768, 360]) {
      mark(`outcomes-${index}-${width}-lost`);
      await page.setViewportSize({ width, height: 1000 });
      const chosen = await selectTask(page, width === 360),
        task = chosen.task,
        endpoint = `/api/renewals/${task.renewalId}/close-lost`,
        attempts = [];
      mark(`outcomes-${index}-${width}-selected`);
      const before = await effects(demo.db, task);
      let replacement,
        postReplacementSnapshot,
        finalTask = task;
      let suppress = true,
        readFail = true;
      const customerRoot = `**/api/customers/${task.customerId}/renewals?*`;
      let deleted = null;
      if (width === 768)
        await page.route(customerRoot, async (route) => {
          if (!readFail) {
            await route.continue();
            return;
          }
          readFail = false;
          if (index) {
            deleted = await demo.db
              .prepare(
                "SELECT * FROM membership_permissions WHERE membership_id=? AND permission_code='policy.read'",
              )
              .bind('demo-member-' + actor)
              .first();
            assert.ok(deleted);
            await demo.db
              .prepare('DELETE FROM membership_permissions WHERE id=?')
              .bind(deleted.id)
              .run();
            const r = await route.fetch();
            assert.equal(r.status(), 403);
            await route.fulfill({ response: r });
          } else {
            const r = await route.fetch();
            assert.equal(r.status(), 200);
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false }),
            });
          }
        });
      await page.route('**' + endpoint, async (route) => {
        const req = route.request(),
          r = await route.fetch(),
          body = await r.json();
        attempts.push({
          url: req.url(),
          method: req.method(),
          body: req.postData(),
          key: req.headers()['idempotency-key'],
          status: r.status(),
          result: body.data,
        });
        if (width === 1440 && suppress && r.ok()) {
          suppress = false;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ success: false }),
          });
        } else await route.fulfill({ response: r });
      });
      await openLost(page, width === 768);
      mark(`outcomes-${index}-${width}-opened`);
      assert.equal(attempts.length, 0);
      const form = page.getByRole('form', { name: 'LOST sonuçlandırma', exact: true });
      assert.ok((await form.innerText()).includes(task.policyNumber));
      assert.ok((await form.innerText()).includes(`Görev sürümü: ${task.taskVersion}`));
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      await form.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(directory, `outcomes-${index}-${width}.png`) });
      if (width === 360) {
        assert.equal(task.taskVersion, 1);
        replacement = await post(
          page,
          `/api/renewals/${task.renewalId}/tasks/${task.taskId}/complete`,
          {
            expectedRenewalVersion: task.renewalVersion,
            expectedTaskVersion: task.taskVersion,
            replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
          },
        );
        assert.equal(replacement.renewalVersion, task.renewalVersion);
        assert.equal(replacement.replacementTaskVersion, task.taskVersion);
        assert.notEqual(replacement.replacementTaskId, task.taskId);
        postReplacementSnapshot = await terminalSnapshot(demo.db, task);
      }
      await submit(page);
      if (width === 1440) {
        mark(`outcomes-${index}-${width}-await-retry`);
        await page
          .getByRole('button', { name: 'Aynı LOST isteğini yeniden dene', exact: true })
          .waitFor();
        await page.getByText(/Sonuç belirsiz\. Özgün hedef/).waitFor();
        assert.equal(attempts.length, 1);
        await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
        await page.getByText(/Sonuçlandırma\/iletişim işleminin sonucu doğrulanmadan/).waitFor();
        await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
        assert.equal(new globalThis.URL(page.url()).pathname, '/today-work');
        const idx = await page.evaluate(() => globalThis.history.state.idx);
        await page.evaluate(() => globalThis.history.back());
        await page.waitForFunction((idx) => globalThis.history.state.idx === idx, idx);
        assert.equal(new globalThis.URL(page.url()).pathname, '/today-work');
        await page
          .getByRole('button', { name: 'Aynı LOST isteğini yeniden dene', exact: true })
          .click();
        await success(page).waitFor();
        assert.equal(attempts.length, 2);
        for (const k of ['url', 'method', 'body', 'key'])
          assert.equal(attempts[0][k], attempts[1][k]);
        assert.equal(attempts[1].status, 200);
      } else if (width === 768) {
        await page
          .getByRole('button', { name: 'Yalnız yenileme okumasını yeniden dene', exact: true })
          .waitFor();
        await page
          .getByText(/POST kabul edildi; bağımsız yetkili yenileme okuması doğrulanamadı/)
          .waitFor();
        assert.equal(attempts.length, 1);
        if (deleted)
          await demo.db
            .prepare(
              'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
            )
            .bind(deleted.id, deleted.membership_id, deleted.permission_code, deleted.scope)
            .run();
        await page
          .getByRole('button', { name: 'Yalnız yenileme okumasını yeniden dene', exact: true })
          .click();
        await success(page).waitFor();
        assert.equal(attempts.length, 1);
      } else {
        await page.getByText(/Sonuçlandırma çakıştı/).waitFor();
        assert.equal(attempts[0].status, 409);
        assert.equal(JSON.parse(attempts[0].body).expectedPrimaryTaskId, task.taskId);
        assert.equal(await terminalSnapshot(demo.db, task), postReplacementSnapshot);
        const pages = [];
        const onRequest = (req) => {
          if (
            req.method() === 'GET' &&
            new globalThis.URL(req.url()).pathname === '/api/tasks/today'
          )
            pages.push(
              new globalThis.URL(req.url()).pathname + new globalThis.URL(req.url()).search,
            );
        };
        page.on('request', onRequest);
        await page
          .getByRole('button', { name: 'Güncel aynı hedefi karşılaştır', exact: true })
          .click();
        await page.getByText(/Başka birincil göreve geçilmedi/).waitFor();
        page.off('request', onRequest);
        assert.deepEqual(pages, [chosen.original]);
        assert.equal(attempts.length, 1);
        assert.equal(
          await page
            .getByRole('button', { name: 'Güncel aynı hedefi benimse', exact: true })
            .count(),
          0,
        );
        await page
          .getByRole('button', { name: 'Bu sonuç taslağını açıkça kapat', exact: true })
          .click();
        const selectedB = await selectExactTask(page, replacement.replacementTaskId);
        assert.equal(selectedB.taskVersion, task.taskVersion);
        assert.equal(selectedB.renewalVersion, task.renewalVersion);
        finalTask = { ...selectedB, expectedTaskCount: 2 };
        await openLost(page);
        await submit(page);
        await success(page).waitFor();
        assert.equal(attempts.length, 2);
        assert.notEqual(attempts[0].key, attempts[1].key);
        assert.equal(
          JSON.parse(attempts[1].body).expectedPrimaryTaskId,
          replacement.replacementTaskId,
        );
        assert.equal(JSON.parse(attempts[1].body).expectedTaskVersion, task.taskVersion);
      }
      const final = attempts.at(-1);
      assert.equal(final.result.state, 'LOST');
      assert.equal(
        final.result.lossReasonId,
        width === 768 ? 'demo-loss-other' : 'demo-loss-price',
      );
      assert.equal(JSON.parse(final.body).expectedPrimaryTaskId, finalTask.taskId);
      await evidence(demo.db, finalTask, final.result, final.key);
      const written = await effects(demo.db, task);
      assert.equal(
        written.renewal.loss_reason_notes,
        width === 768 ? 'Sentetik diğer kayıp nedeni' : null,
      );
      assert.equal(written.renewal.void_reason_code, null);
      assert.equal(before.tasks.length, 1);
      const stored = await page.evaluate(() =>
        JSON.stringify({
          local: { ...globalThis.localStorage },
          session: { ...globalThis.sessionStorage },
          history: globalThis.history.state,
        }),
      );
      for (const a of attempts) {
        assert.ok(!stored.includes(a.key));
        assert.ok(!stored.includes(a.body));
      }
      await page.unroute('**' + endpoint);
      if (width === 768) await page.unroute(customerRoot);
      mark(`outcomes-${index}-${width}-void`);
      const v = (await selectTask(page)).task,
        vurl = `/api/renewals/${v.renewalId}/void`,
        vs = JSON.stringify(await effects(demo.db, v)),
        code = ['TECHNICAL_ERROR', 'DUPLICATE', 'NOT_ELIGIBLE_AFTER_CANCELLATION_OR_RESTRUCTURE'][
          [1440, 768, 360].indexOf(width)
        ];
      await page.getByRole('button', { name: 'Geçersiz olarak işaretle', exact: true }).click();
      await page
        .getByRole('combobox', { name: 'Geçersizlik nedeni', exact: true })
        .selectOption(code);
      const vr = page.waitForResponse(
        (r) => new globalThis.URL(r.url()).pathname === vurl && r.request().method() === 'POST',
      );
      await submit(page, 'VOIDED');
      const response = await vr;
      if (!index) {
        assert.equal(response.status(), 200);
        const r = (await response.json()).data;
        assert.equal(r.voidReasonCode, code);
        await success(page).waitFor();
        await evidence(demo.db, v, r, response.request().headers()['idempotency-key']);
        assert.equal((await effects(demo.db, v)).renewal.loss_reason_id, null);
      } else {
        assert.ok([403, 404].includes(response.status()));
        await page.getByText(/korunan hedef ayrıntıları gizlendi/).waitFor();
        assert.equal(JSON.stringify(await effects(demo.db, v)), vs);
        await page
          .getByRole('button', { name: 'Bu sonuç taslağını açıkça kapat', exact: true })
          .click();
      }
    }
    if (!index) {
      mark('outcomes-owner-void-primary-task-ABA');
      const { task: a } = await selectTask(page, true),
        url = `/api/renewals/${a.renewalId}/void`,
        attempts = [];
      assert.equal(a.taskVersion, 1);
      await page.getByRole('button', { name: 'Geçersiz olarak işaretle', exact: true }).click();
      await page
        .getByRole('combobox', { name: 'Geçersizlik nedeni', exact: true })
        .selectOption('DUPLICATE');
      const replacement = await post(
        page,
        `/api/renewals/${a.renewalId}/tasks/${a.taskId}/complete`,
        {
          expectedRenewalVersion: a.renewalVersion,
          expectedTaskVersion: a.taskVersion,
          replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
        },
      );
      assert.equal(replacement.replacementTaskVersion, a.taskVersion);
      assert.equal(replacement.renewalVersion, a.renewalVersion);
      const before = await terminalSnapshot(demo.db, a);
      await page.route('**' + url, async (route) => {
        const request = route.request(),
          response = await route.fetch();
        attempts.push({
          body: JSON.parse(request.postData()),
          key: request.headers()['idempotency-key'],
          status: response.status(),
          result: (await response.json()).data,
        });
        await route.fulfill({ response });
      });
      await submit(page, 'VOIDED');
      await page.getByText(/Sonuçlandırma çakıştı/).waitFor();
      assert.equal(attempts[0].status, 409);
      assert.equal(attempts[0].body.expectedPrimaryTaskId, a.taskId);
      assert.equal(await terminalSnapshot(demo.db, a), before);
      await page
        .getByRole('button', { name: 'Güncel aynı hedefi karşılaştır', exact: true })
        .click();
      await page.getByText(/Başka birincil göreve geçilmedi/).waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Güncel aynı hedefi benimse', exact: true }).count(),
        0,
      );
      assert.equal(attempts.length, 1);
      await page
        .getByRole('button', { name: 'Bu sonuç taslağını açıkça kapat', exact: true })
        .click();
      const b = await selectExactTask(page, replacement.replacementTaskId);
      await page.getByRole('button', { name: 'Geçersiz olarak işaretle', exact: true }).click();
      await page
        .getByRole('combobox', { name: 'Geçersizlik nedeni', exact: true })
        .selectOption('DUPLICATE');
      await submit(page, 'VOIDED');
      await success(page).waitFor();
      assert.equal(attempts[1].status, 200);
      assert.equal(attempts[1].body.expectedPrimaryTaskId, b.taskId);
      assert.notEqual(attempts[1].key, attempts[0].key);
      await evidence(demo.db, { ...b, expectedTaskCount: 2 }, attempts[1].result, attempts[1].key);
      await page.unroute('**' + url);
    }
    if (index) {
      mark(`outcomes-${index}-private-task-deny`);
      const foreign = await demo.db
        .prepare(
          "SELECT r.id renewalId,r.version renewalVersion,t.id taskId,t.version taskVersion FROM renewal_opportunities r JOIN tasks t ON t.renewal_id=r.id WHERE r.state NOT IN('WON','LOST','VOIDED') AND t.status='OPEN' AND t.assignee_membership_id<>? LIMIT 1",
        )
        .bind('demo-member-' + actor)
        .first();
      assert.ok(foreign);
      const denied = await page.evaluate(async (t) => {
        const csrf = (await (await globalThis.fetch('/api/csrf-token')).json()).data.token;
        return (
          await globalThis.fetch(`/api/renewals/${t.renewalId}/close-lost`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': csrf,
              'idempotency-key': globalThis.crypto.randomUUID(),
            },
            body: JSON.stringify({
              expectedRenewalVersion: t.renewalVersion,
              expectedPrimaryTaskId: t.taskId,
              expectedTaskVersion: t.taskVersion,
              lossReasonId: 'demo-loss-price',
              lossReasonNotes: null,
            }),
          })
        ).status;
      }, foreign);
      assert.ok([403, 404].includes(denied));
      mark(`outcomes-${index}-live-permission-deny`);
      const t = (await selectTask(page)).task;
      await openLost(page);
      const grant = await demo.db
        .prepare(
          "SELECT * FROM membership_permissions WHERE membership_id=? AND permission_code='renewal.close_lost'",
        )
        .bind('demo-member-' + actor)
        .first();
      assert.ok(grant);
      await demo.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(grant.id).run();
      try {
        const state = JSON.stringify(await effects(demo.db, t));
        await submit(page);
        await page.getByText(/korunan hedef ayrıntıları gizlendi/).waitFor();
        assert.equal(JSON.stringify(await effects(demo.db, t)), state);
      } finally {
        await demo.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(grant.id, grant.membership_id, grant.permission_code, grant.scope)
          .run();
      }
      await page
        .getByRole('button', { name: 'Bu sonuç taslağını açıkça kapat', exact: true })
        .click();
    }
    mark(`outcomes-${index}-session-revocation`);
    await selectTask(page);
    await openLost(page);
    await demo.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=?')
      .bind(Date.now(), 'demo-user-' + actor)
      .run();
    await submit(page);
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).waitFor();
    assert.equal(await page.locator('.today-outcome-form').count(), 0);
    assert.equal(await page.locator('.today-task-row').count(), 0);
    assert.equal(prohibited, 0);
    return permissions;
  } finally {
    page.off('request', observe);
  }
}
