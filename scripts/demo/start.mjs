#!/usr/bin/env node
// Zero-input, explicit local synthetic demo. No credential arguments, env secrets or auth bypass.
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
    process.stdout.write(
      'Demo hazır: OWNER önde; Ahmet ve Ayşe ayrı Edge pencerelerinde. Şifre doğrulama alanı otomatik dolar; Doğrula ve işlem onayları sizdedir. Bitirmek için üç demo penceresini kapatın.\n',
    );
    await demo.closed;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await demo?.close();
  }
}
main().catch(() => {
  // Never emit raw Playwright exceptions, call arguments, credentials or dependency stacks.
  process.stderr.write(
    'Yerel demo başlatılamadı. Node, bağımlılıklar, Microsoft Edge ve OpenSSL kurulumunu kontrol edin. Hiçbir production bağlantısı açılmadı.\n',
  );
  process.exitCode = 1;
});
