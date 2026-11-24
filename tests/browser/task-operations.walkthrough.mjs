import assert from 'node:assert/strict';
import { openWorkspaceSections } from './workspace-disclosures.mjs';
async function read(page, url) {
  return page.evaluate(async (url) => {
    const r = await globalThis.fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('TASK_READ_FAILED');
    return (await r.json()).data;
  }, url);
}
export async function taskOperationsWalkthrough(page, index, mark, demo) {
  mark('task-operations-' + index);
  await page.goto('https://localhost:8443/today-work');
  await page.locator('.today-task-row').first().waitFor();
  let pageData = await read(page, '/api/tasks/today?limit=20'),
    original = '/api/tasks/today?limit=20',
    task;
  if (!index && pageData.hasMore) {
    mark('task-later-page-' + index);
    original += '&cursor=' + encodeURIComponent(pageData.nextCursor);
    await page.getByRole('button', { name: 'Daha fazla iş yükle', exact: true }).click();
    await page.waitForFunction(
      () => globalThis.document.querySelectorAll('.today-task-row').length > 20,
    );
    pageData = await read(page, original);
    task = pageData.items[0];
    await page.locator('.today-task-row').nth(20).click();
  } else {
    task = pageData.items[0];
    await page.locator('.today-task-row').first().click();
  }
  await openWorkspaceSections(page);
  const before = await demo.db
      .prepare('SELECT COUNT(*) count FROM tasks WHERE renewal_id=?')
      .bind(task.renewalId)
      .first(),
    writes = [],
    reads = [];
  let lost = false,
    failRead = false,
    readFailed = false;
  await page.route('**/api/tasks/today?*', async (route) => {
    const url = new globalThis.URL(route.request().url());
    reads.push(url.pathname + url.search);
    if (failRead && !readFailed) {
      readFailed = true;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false }),
      });
    }
    return route.continue();
  });
  const endpoint = `/api/renewals/${task.renewalId}/tasks/${task.taskId}/complete`,
    pattern = '**' + endpoint;
  await page.route(pattern, async (route) => {
    const request = route.request();
    writes.push({
      url: request.url(),
      method: request.method(),
      body: request.postData(),
      key: request.headers()['idempotency-key'],
    });
    const r = await route.fetch();
    if (!index && r.ok() && !lost) {
      lost = true;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false }),
      });
    }
    if (index === 1 && r.ok()) failRead = true;
    return route.fulfill({ response: r });
  });
  try {
    await page.getByRole('button', { name: 'Yeni takip planını aç', exact: true }).click();
    mark('task-opened-plan-' + index);
    const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
      local = date + 'T11:15';
    assert.equal(
      await page.getByLabel('Yeni takip zamanı (İstanbul)', { exact: true }).inputValue(),
      '',
    );
    await page.getByLabel('Yeni takip zamanı (İstanbul)', { exact: true }).fill(local);
    for (const width of [1440, 768, 360]) {
      mark('task-form-' + index + '-' + width);
      await page.setViewportSize({ width, height: 950 });
      await page
        .getByLabel('Yeni takip zamanı (İstanbul)', { exact: true })
        .scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      assert.equal(
        await page.getByRole('form', { name: 'Takip tamamlama formu', exact: true }).isVisible(),
        true,
      );
    }
    await page.getByRole('button', { name: 'İletişim kaydı ekle', exact: true }).click();
    await page.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
    await page.getByLabel('İç not', { exact: true }).fill('Korunan görev öncesi iletişim taslağı');
    await page
      .getByLabel('Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum', { exact: true })
      .check();
    await page.getByRole('button', { name: 'Takibi tamamla ve planla', exact: true }).click();
    await page.getByText(/İletişim taslağını açıkça kapatın/).waitFor();
    assert.equal(writes.length, 0);
    assert.equal(
      await page.getByLabel('İç not', { exact: true }).inputValue(),
      'Korunan görev öncesi iletişim taslağı',
    );
    await page.getByRole('button', { name: 'Formu kapat ve taslağı bırak', exact: true }).click();
    if (!index) {
      await demo.db
        .prepare('UPDATE tasks SET version=version+1 WHERE id=?')
        .bind(task.taskId)
        .run();
      await page.getByRole('button', { name: 'Takibi tamamla ve planla', exact: true }).click();
      await page
        .getByRole('button', { name: 'Güncel tamamlama durumunu karşılaştır', exact: true })
        .click();
      await page.getByText(/Karşılaştırılan: yenileme/).waitFor();
      assert.equal(reads.at(-1), original);
      await page
        .getByLabel('Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum', { exact: true })
        .check();
    }
    await page.getByRole('button', { name: 'Takibi tamamla ve planla', exact: true }).click();
    if (!index) {
      await page
        .getByRole('button', { name: 'Aynı tamamlama isteğini yeniden dene', exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
      await page.getByText(/Görev işleminin sonucu çözülmeden/).waitFor();
      await page
        .getByRole('button', { name: 'Aynı tamamlama isteğini yeniden dene', exact: true })
        .click();
      assert.deepEqual(writes.at(-1), writes.at(-2));
    }
    if (index === 1)
      await page
        .getByRole('button', { name: 'Yalnız tamamlama kuyruğunu yeniden oku', exact: true })
        .click();
    await page.getByText(/Takip tamamlandı ve yeni takip atomik sunucu sonucu/).waitFor();
    assert.equal(reads.at(-1), original);
    const rows = (
      await demo.db
        .prepare(
          'SELECT id,status,due_at,assignee_membership_id FROM tasks WHERE renewal_id=? ORDER BY id',
        )
        .bind(task.renewalId)
        .all()
    ).results;
    assert.equal(rows.length, before.count + 1);
    assert.equal(rows.find((r) => r.id === task.taskId).status, 'COMPLETED');
    const replacement = rows.find((r) => r.status === 'OPEN');
    assert.ok(replacement);
    assert.equal(replacement.due_at, date + 'T08:15:00.000Z');
    assert.equal(replacement.assignee_membership_id, task.renewalAssigneeMembershipId);
    const payload = JSON.parse(writes.at(-1).body);
    assert.deepEqual(Object.keys(payload).sort(), [
      'expectedRenewalVersion',
      'expectedTaskVersion',
      'replacementDueAt',
    ]);
    assert.equal(writes.length, !index ? 3 : 1);
  } finally {
    await page.unroute(pattern);
    await page.unroute('**/api/tasks/today?*');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('https://localhost:8443/today-work');
  await page.locator('.today-task-row').first().click();
  await openWorkspaceSections(page);
  await page.getByRole('button', { name: 'Yeni takip planını aç', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Görev atama seçeneklerini aç', exact: true }).count(),
    0,
  );
  assert.equal(await page.getByRole('button', { name: 'Atanmamış işler', exact: true }).count(), 0);
}
