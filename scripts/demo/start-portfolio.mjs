#!/usr/bin/env node
/* global fetch, crypto */
// Explicit local synthetic CLI composition. Real login, real authenticated API writes, disposable D1.
import process from 'node:process';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openAutomaticDemo } from './automatic.mjs';
async function main() {
  if (process.argv.length !== 2) throw new Error('DEMO_ARGUMENTS_INVALID');
  process.chdir(resolve(import.meta.dirname, '../..'));
  const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('BUILD_FAILED');
  let demo;
  const stop = () => {
    void demo?.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    demo = await openAutomaticDemo();
    const created = await demo.pages[0].evaluate(async () => {
      const csrf = await (await fetch('/api/csrf-token')).json();
      const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      let count = 0;
      for (let i = 0; i < 23; i++) {
        const body = {
          customerId: 'demo-customer-' + (i % 4),
          insurerId: 'demo-insurer',
          productId: 'demo-product',
          branchId: 'demo-branch',
          paymentMethodId: 'demo-payment',
          assigneeMembershipId: 'demo-member-ahmet',
          policyNumber: 'V4-PORTFOY-' + String(i + 1).padStart(3, '0'),
          startDate: day(-200),
          endDate: day(i - 3),
          grossPremium: '12500.50',
          currency: 'TRY',
          installmentCount: null,
          status: 'ACTIVE',
        };
        const response = await fetch('/api/policies', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf.data.token,
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error('SYNTHETIC_FIXTURE_FAILED');
        const result = await response.json();
        if (typeof result.data?.id !== 'string') throw new Error('SYNTHETIC_FIXTURE_FAILED');
        const verify = await fetch('/api/policies/' + encodeURIComponent(result.data.id), {
          cache: 'no-store',
        });
        const current = await verify.json();
        if (
          !verify.ok ||
          current.data?.id !== result.data.id ||
          current.data?.customerId !== body.customerId ||
          current.data?.policyNumber !== body.policyNumber ||
          current.data?.grossPremiumMinor !== 1250050
        )
          throw new Error('SYNTHETIC_READBACK_FAILED');
        count++;
      }
      return count;
    });
    if (created !== 23) throw new Error('SYNTHETIC_FIXTURE_FAILED');
    for (const page of demo.pages) {
      await page.goto(demo.origin + '/policies');
      await page.locator('.pv4-table .pv4-customer').first().waitFor();
    }
    await demo.pages[0].bringToFront();
    process.stdout.write(
      'V4 Portföy hazır: OWNER, Ahmet ve Ayşe ayrı Edge oturumlarında. Gerçek API ile yalnız geçici sentetik D1 üzerinde 23 ek dönem oluşturuldu; sayfalama ve yenileme akışları incelenebilir. İşlem doğrulamaları ve son onaylar sizdedir. Üç demo penceresini kapatarak bitirin.\n',
    );
    if (process.env.MAYI_PORTFOLIO_PREVIEW_VERIFY === 'true') await demo.close();
    else await demo.closed;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await demo?.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Yerel V4 portföy önizlemesi açılamadı. Node, Edge, OpenSSL ve bağımlılıkları kontrol edin. Production bağlantısı açılmadı.\n',
  );
  process.exitCode = 1;
});
