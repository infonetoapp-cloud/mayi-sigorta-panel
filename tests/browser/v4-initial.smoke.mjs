/* global document, innerWidth, getComputedStyle */
import console from 'node:console';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { openAutomaticDemo } from '../../scripts/demo/automatic.mjs';
let demo;
const result = { mode: 'REAL_LOCAL_APP_SYNTHETIC_D1', screens: [], errors: [] };
try {
  await mkdir('v4-evidence/initial', { recursive: true });
  demo = await openAutomaticDemo();
  const page = demo.pages[0];
  page.on('pageerror', () => result.errors.push('pageerror'));
  for (const width of [1440, 1200, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 });
    for (const scene of ['dashboard', 'work', 'selected']) {
      if (scene === 'dashboard') await page.goto(demo.origin + '/');
      if (scene === 'work') await page.goto(demo.origin + '/today-work');
      if (scene === 'selected') await page.locator('.today-task-row').first().click();
      await page
        .locator(scene === 'dashboard' ? '.dashboard-metrics a' : '.today-task-row')
        .first()
        .waitFor({ state: scene === 'selected' && width <= 1100 ? 'attached' : 'visible' });
      if (scene === 'selected')
        await page
          .getByRole('region', { name: 'Yenileme iletişim geçmişi ve kaydı', exact: true })
          .waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `v4-evidence/initial/${scene}-${width}.png`, fullPage: true });
      result.screens.push(
        await page.evaluate(
          ({ scene, width }) => ({
            scene,
            width,
            pageWidth: document.documentElement.scrollWidth,
            header: document.querySelector('header').getBoundingClientRect().height,
            sidebar: getComputedStyle(document.querySelector('.app-sidebar')).backgroundColor,
            inspector: document.querySelector('.today-overview')?.getBoundingClientRect().toJSON(),
            rows: [...document.querySelectorAll('.today-task-row')]
              .map((e) => e.getBoundingClientRect().height)
              .filter(Boolean),
            outside: [...document.querySelectorAll('main button,main a,main input,main select')]
              .filter((e) => {
                const r = e.getBoundingClientRect();
                return r.width && (r.right > innerWidth + 1 || r.left < -1);
              })
              .map((e) => e.textContent.slice(0, 60)),
          }),
          { scene, width },
        ),
      );
    }
  }
  await writeFile('v4-evidence/initial/inspection.json', JSON.stringify(result, null, 2));
  console.info(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('V4_INITIAL_INSPECTION_FAILED', e.name, e.message);
  process.exitCode = 1;
} finally {
  await demo?.close();
}
