// Local synthetic preview only. No confirmation or credential output is automated.
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
  await demo.pages[0].goto(demo.origin + '/personnel');
  await demo.pages[0].getByRole('heading', { name: 'Personel ve İzinler', exact: true }).waitFor();
  await demo.pages[0].getByRole('button', { name: 'Listeyi yenile', exact: true }).waitFor();
  await demo.pages[0].bringToFront();
  console.info(
    'Sentetik personel önizlemesi hazır. OWNER personel ekranında; iki MEMBER ayrı oturumda. Kritik onaylar kullanıcıda kalır.',
  );
  if (process.env.MAYI_PERSONNEL_PREVIEW_VERIFY === 'true') {
    await demo.close();
    console.info('PERSONNEL_PREVIEW_VERIFIED');
  } else {
    process.once('SIGINT', () => void demo.close());
    process.once('SIGTERM', () => void demo.close());
    await demo.closed;
  }
} finally {
  await demo.close();
}
