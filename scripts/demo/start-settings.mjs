import process from 'node:process';
import console from 'node:console';
import { spawnSync } from 'node:child_process';
import { openAutomaticDemo } from './automatic.mjs';
const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);
const demo = await openAutomaticDemo();
try {
  for (const page of demo.pages) {
    await page.goto(demo.origin + '/agency-settings');
    await page.getByRole('heading', { name: 'Acente Ayarları', exact: true }).waitFor();
    await page.locator('.settings-v4[aria-busy=false] .settings-surface').waitFor();
  }
  await demo.pages[0].getByRole('button', { name: 'Ayarları kaydet', exact: true }).waitFor();
  for (const page of demo.pages.slice(1))
    await page.getByText('Salt okunur', { exact: true }).waitFor();
  await demo.pages[0].bringToFront();
  console.info(
    'V4 Acente Ayarları hazır. OWNER düzenleyebilir; iki MEMBER ayrı salt-okunur oturumdadır. Yalnız geçici yerel sentetik veri kullanılır.',
  );
  if (process.env.MAYI_SETTINGS_PREVIEW_VERIFY === 'true') {
    await demo.close();
    console.info('SETTINGS_PREVIEW_VERIFIED');
  } else {
    process.once('SIGINT', () => void demo.close());
    process.once('SIGTERM', () => void demo.close());
    await demo.closed;
  }
} finally {
  await demo.close();
}
