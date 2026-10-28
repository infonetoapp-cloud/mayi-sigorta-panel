#!/usr/bin/env node
// Explicit disposable synthetic preview. Uses real login forms and unchanged authenticated APIs.
import process from 'node:process';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openAutomaticDemo } from './automatic.mjs';
async function main() {
  if (process.argv.length !== 2) throw new Error('DEMO_ARGUMENTS_INVALID');
  process.chdir(resolve(import.meta.dirname, '../..'));
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    stdio: 'inherit',
  });
  if (build.status !== 0) throw new Error('BUILD_FAILED');
  let demo;
  const stop = () => {
    void demo?.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    demo = await openAutomaticDemo();
    for (const page of demo.pages) {
      await page.goto(demo.origin + '/customers/demo-customer-0');
      await page.locator('.customer360 .c360-title h1').waitFor();
    }
    await demo.pages[0].bringToFront();
    process.stdout.write(
      'Customer 360° hazır: OWNER, Ahmet ve Ayşe ayrı Edge oturumlarında. Yalnız geçici sentetik yerel D1 kullanılır. Yeni müşteri ve kurumsal kayıtlar Müşteriler bölümünden oluşturulabilir. Doğrulama ve işlem onayları sizdedir. Üç demo penceresini kapatarak bitirin.\n',
    );
    if (process.env.MAYI_CUSTOMER_PREVIEW_VERIFY === 'true') await demo.close();
    else await demo.closed;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await demo?.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Customer 360° yerel demo açılamadı. Node, Microsoft Edge, bağımlılıklar ve OpenSSL kurulumunu kontrol edin. Production bağlantısı açılmadı.\n',
  );
  process.exitCode = 1;
});
