#!/usr/bin/env node
import process from 'node:process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { demoCertificate, serveDemo } from './https-server.mjs';

function masked(prompt) {
  process.stdout.write(prompt);
  return new Promise((yes, no) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = () => {
      process.stdin.off('keypress', keypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    function keypress(text, key) {
      if (key?.ctrl && key.name === 'c') {
        finish();
        no(new Error('Demo kurulumu iptal edildi.'));
        return;
      }
      if (key?.name === 'return') {
        finish();
        yes(value);
        return;
      }
      if (key?.name === 'backspace') {
        value = Array.from(value).slice(0, -1).join('');
        return;
      }
      if (
        text &&
        !key?.ctrl &&
        !key?.meta &&
        Array.from(text).every(
          (character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127,
        ) &&
        value.length + text.length <= 256
      )
        value += text;
    }
    process.stdin.on('keypress', keypress);
  });
}
async function main() {
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Yalnız etkileşimli yerel terminal: npm run demo');
  process.chdir(resolve(import.meta.dirname, '../..'));
  const buildResult = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    stdio: 'inherit',
  });
  if (buildResult.status !== 0) throw new Error('Ön yüz derlemesi başarısız.');
  const cache = resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'mayi-demo-'));
  let demo, tls, server;
  try {
    const bundle = join(directory, 'application.mjs');
    await build({
      entryPoints: ['scripts/demo/application.ts'],
      outfile: bundle,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node24',
      logLevel: 'silent',
    });
    const application = await import(pathToFileURL(bundle).href);
    emitKeypressEvents(process.stdin);
    const passwords = [];
    process.stdout.write(
      '\nYalnız sentetik, geçici yerel demo. Gerçek hesap parolanızı KULLANMAYIN.\nHer hesap için en az 15 karakterlik ayrı bir demo parolası girin. Girdi görünmez.\n',
    );
    for (const user of application.DEMO_USERS) {
      const value = await masked(`${user.name} (${user.email}) parolası: `);
      const confirmation = await masked('Tekrar: ');
      if (value !== confirmation) throw new Error('Parolalar eşleşmedi; baştan başlatın.');
      passwords.push(value);
    }
    if (new Set(passwords).size !== 3) throw new Error('Üç farklı demo parolası kullanın.');
    tls = await demoCertificate();
    process.stdout.write('Yerel D1 ve kurgusal kayıtlar hazırlanıyor…\n');
    demo = await application.openDemo(passwords);
    passwords.fill('');
    server = await serveDemo(demo, tls);
    process.stdout.write(
      '\nDemo hazır: https://localhost:8443\nYalnız bu demo için yerel self-signed sertifika uyarısını onaylayın.\nHesaplar: sahip@demo.invalid | ahmet@demo.invalid | ayse@demo.invalid\nKapatmak ve geçici veriyi silmek için Ctrl+C. Yeniden başlatma yeni veri/parolalar oluşturur.\n',
    );
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    await server?.close();
    await demo?.dispose();
    await tls?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  // Never print a raw dependency/SQL/request error or credential-bearing stack.
  const safe = new Set([
    'Yalnız etkileşimli yerel terminal: npm run demo',
    'Ön yüz derlemesi başarısız.',
    'Demo kurulumu iptal edildi.',
    'Parolalar eşleşmedi; baştan başlatın.',
    'Üç farklı demo parolası kullanın.',
    'OpenSSL bulunamadı. Git for Windows kurun; demo TLS sertifikası oluşturulamadı.',
  ]);
  process.stderr.write(
    (safe.has(error?.message)
      ? error.message
      : 'Demo başlatılamadı. Node 24, bağımlılıklar, OpenSSL, boş 8443 portu ve 15–128 karakter güçlü parolaları kontrol edin.') +
      '\n',
  );
  process.exitCode = 1;
});
