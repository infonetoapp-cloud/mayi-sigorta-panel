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
  await demo.pages[0].goto(demo.origin + '/catalogs');
  await demo.pages[0].getByRole('heading', { name: 'Kataloglar', exact: true }).waitFor();
  await demo.pages[0].getByRole('button', { name: 'Yeni kayıt', exact: true }).waitFor();
  await demo.pages[0].bringToFront();
  console.info(
    'V4 katalog + Tam Yetki Ver sentetik önizlemesi hazır. OWNER kataloglarda; iki MEMBER ayrı oturumda. Personel → İzinleri düzenle → Tam Yetki Ver → Kaydet ile erişimi deneyin. Kritik güvenli onaylar kullanıcıdadır.',
  );
  if (process.env.MAYI_CATALOG_PREVIEW_VERIFY === 'true') {
    await demo.close();
    console.info('CATALOG_PREVIEW_VERIFIED');
  } else {
    process.once('SIGINT', () => void demo.close());
    process.once('SIGTERM', () => void demo.close());
    await demo.closed;
  }
} finally {
  await demo.close();
}
