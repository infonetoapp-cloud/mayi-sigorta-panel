import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
import { seedPerformanceDataset } from './performance-dataset.mjs';
import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import process from 'node:process';
const label = process.argv[2] ?? 'after-diagnostics';
const preview = await openOperationalPreview({ nativeRuntime: !label.startsWith('before') });
let browser;
try {
  const counts = await seedPerformanceDataset(preview.demo.db, 15000);
  const plans = {};
  for (const [name, sql, values] of [
    [
      'policy-page',
      'SELECT id FROM policies WHERE agency_id=? ORDER BY end_date,id LIMIT 21',
      ['demo-agency'],
    ],
    [
      'customer-page',
      'SELECT id FROM customers WHERE agency_id=? ORDER BY created_at DESC,id DESC LIMIT 21',
      ['demo-agency'],
    ],
    [
      'customer-search',
      'SELECT id FROM customers WHERE agency_id=? AND display_name LIKE ? ORDER BY created_at DESC,id DESC LIMIT 21',
      ['demo-agency', '%Performans%'],
    ],
    [
      'customer-policy-page',
      'SELECT id FROM policies WHERE agency_id=? AND customer_id=? ORDER BY end_date,id LIMIT 21',
      ['demo-agency', 'demo-customer-0'],
    ],
  ])
    plans[name] = (
      await preview.demo.db
        .prepare('EXPLAIN QUERY PLAN ' + sql)
        .bind(...values)
        .all()
    ).results;
  await writeFile(
    `performance-evidence/${label}-plans.json`,
    JSON.stringify(
      {
        counts,
        plans,
        note: 'Representative index plans, not a replacement for the complete authorized SELECT.',
      },
      null,
      2,
    ),
  );
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  await context.request.post(preview.origin + '/api/auth/login', {
    headers: { origin: preview.origin },
    data: { email: preview.users[0].email, password: preview.passwords[0] },
  });
  const page = await context.newPage();
  await page.goto(preview.origin);
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,v8,blink.user_timing',
    transferMode: 'ReturnAsStream',
  });
  for (const path of ['/customers', '/policies', '/today-work', '/catalogs']) {
    await page.locator(`a[href="${path}"]`).first().click();
    await page.waitForTimeout(label.startsWith('before') ? 16000 : 1500);
  }
  const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  const { stream } = await done;
  const chunks = [];
  let eof = false;
  while (!eof) {
    const r = await cdp.send('IO.read', { handle: stream });
    chunks.push(r.base64Encoded ? Buffer.from(r.data, 'base64').toString() : r.data);
    eof = r.eof;
  }
  await cdp.send('IO.close', { handle: stream });
  await writeFile(`performance-evidence/${label}-browser-trace.json`, chunks.join(''));
} finally {
  await browser?.close();
  await preview.close();
}
