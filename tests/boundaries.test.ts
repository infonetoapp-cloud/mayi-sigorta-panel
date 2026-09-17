import prettier from 'prettier';
import { describe, it, expect } from 'vitest';
import {
  checkSourceBoundaries,
  checkClientBundleForSecrets,
  loadProjectEnvSecrets,
  SYNTHETIC_SECRET_MARKER,
} from '../scripts/verify-boundaries';
import { parseServerConfig, SYNTHETIC_SERVER_SECRET_MARKER } from '../src/server/config';
import {
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';

function getAllSourceFiles(dir: string, fileList: string[] = []): string[] {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      getAllSourceFiles(fullPath, fileList);
    } else {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/**
 * Geçici test fikstür dizini oluşturan ve test bitiminde temizleyen yardımcı işlev.
 */
function runWithTempFixture(
  files: Record<string, string>,
  testFn: (tempDir: string) => void,
): void {
  const tempDir = mkdtempSync(join(resolve(__dirname), '.fixture-tmp-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(tempDir, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }
    testFn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('Mimari Sınır ve Güvenlik İzolasyon Testleri (Boundary & Security Tests)', () => {
  const rootDir = resolve(__dirname, '..');

  it('kod formatı Prettier kurallarına uygun olmalıdır', async () => {
    const prettierRc = JSON.parse(
      readFileSync(resolve(rootDir, '.prettierrc'), 'utf-8'),
    ) as prettier.Options;
    const filesToVerify = [
      resolve(rootDir, 'scripts/verify-boundaries.ts'),
      resolve(rootDir, 'vite.config.ts'),
      resolve(rootDir, 'tests/boundaries.test.ts'),
    ];
    for (const file of filesToVerify) {
      const content = readFileSync(file, 'utf-8');
      const isFormatted = await prettier.check(content, {
        ...prettierRc,
        filepath: file,
      });
      expect(isFormatted).toBe(true);
    }
  });

  it('src/app ve src/shared içinde sunucu modülü ithalatı kesinlikle olmamalıdır', () => {
    const violations = checkSourceBoundaries();
    expect(violations).toEqual([]);
  });

  it('Sentetik gizli anahtar işaretçisi src/app veya src/shared kaynak kodlarında bulunmamalıdır', () => {
    const clientFiles = getAllSourceFiles(join(rootDir, 'src', 'app'));
    const sharedFiles = getAllSourceFiles(join(rootDir, 'src', 'shared'));
    const allClientAndShared = [...clientFiles, ...sharedFiles];

    for (const file of allClientAndShared) {
      const content = readFileSync(file, 'utf-8');
      expect(content.includes(SYNTHETIC_SECRET_MARKER)).toBe(false);
      expect(content.includes(SYNTHETIC_SERVER_SECRET_MARKER)).toBe(false);
    }
  });

  it('Sunucu yapılandırma şeması varsayılan sentetik değerleri doğrulamalıdır', () => {
    const config = parseServerConfig({});
    expect(config.APP_ENV).toBe('development');
    expect(config.SYNTHETIC_SECRET_KEY).toBe(SYNTHETIC_SERVER_SECRET_MARKER);
    expect((config as Record<string, unknown>).CF_ACCESS_TEAM_DOMAIN).toBeUndefined();
  });
});

describe('Bulgu 1 ve 5: Modül Grafiği Çözümleme ve Negatif Fikstür Testleri', () => {
  const rootDir = resolve(__dirname, '..');

  it('1. Doğrudan istemciden sunucuya statik ithalat (direct app to server) reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const appFilePath = join(tempDir, 'src', 'app', 'direct-app.ts');
      const relToServer = relative(
        dirname(appFilePath),
        resolve(rootDir, 'src/server/config'),
      ).replace(/\\/g, '/');
      mkdirSync(dirname(appFilePath), { recursive: true });
      writeFileSync(
        appFilePath,
        `import { parseServerConfig } from '${relToServer}';\nexport const dummy = parseServerConfig;\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir,
        entryFiles: [appFilePath],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.resolvedPath?.includes('src/server/config'))).toBe(true);
    });
  });

  it('2. Doğrudan paylaşılandan sunucuya statik ithalat (direct shared to server) reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const sharedFilePath = join(tempDir, 'src', 'shared', 'direct-shared.ts');
      const relToServer = relative(
        dirname(sharedFilePath),
        resolve(rootDir, 'src/server/config'),
      ).replace(/\\/g, '/');
      mkdirSync(dirname(sharedFilePath), { recursive: true });
      writeFileSync(
        sharedFilePath,
        `import { parseServerConfig } from '${relToServer}';\nexport const dummy = parseServerConfig;\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir,
        entryFiles: [sharedFilePath],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.resolvedPath?.includes('src/server/config'))).toBe(true);
    });
  });

  it('3. Geçişli bağımlılık (transitive app to shared to server) reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const appFilePath = join(tempDir, 'src', 'app', 'transitive-entry.ts');
      const sharedBridgePath = join(tempDir, 'src', 'shared', 'bridge.ts');
      const relToServer = relative(
        dirname(sharedBridgePath),
        resolve(rootDir, 'src/server/config'),
      ).replace(/\\/g, '/');
      const relToBridge = relative(
        dirname(appFilePath),
        sharedBridgePath.replace(/\.ts$/, ''),
      ).replace(/\\/g, '/');

      mkdirSync(dirname(sharedBridgePath), { recursive: true });
      writeFileSync(
        sharedBridgePath,
        `import { parseServerConfig } from '${relToServer}';\nexport const bridgeVal = parseServerConfig;\n`,
        'utf-8',
      );

      mkdirSync(dirname(appFilePath), { recursive: true });
      const bridgeSpec = relToBridge.startsWith('.') ? relToBridge : `./${relToBridge}`;
      writeFileSync(
        appFilePath,
        `import { bridgeVal } from '${bridgeSpec}';\nexport const appEntry = bridgeVal;\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir,
        entryFiles: [appFilePath],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.resolvedPath?.includes('src/server/config'))).toBe(true);
    });
  });

  it('4. Sunucu modülünü export { ... } from ve export * from ile dışa aktarım reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const reexportFilePath = join(tempDir, 'src', 'app', 'reexport.ts');
      const relToServer = relative(
        dirname(reexportFilePath),
        resolve(rootDir, 'src/server/config'),
      ).replace(/\\/g, '/');
      mkdirSync(dirname(reexportFilePath), { recursive: true });
      writeFileSync(
        reexportFilePath,
        `export { parseServerConfig } from '${relToServer}';\nexport * from '${relToServer}';\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir,
        entryFiles: [reexportFilePath],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.resolvedPath?.includes('src/server/config'))).toBe(true);
    });
  });

  it('5. Dinamik import() ile sunucuya erişim reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const dynamicFilePath = join(tempDir, 'src', 'app', 'dynamic.ts');
      const relToServer = relative(
        dirname(dynamicFilePath),
        resolve(rootDir, 'src/server/config'),
      ).replace(/\\/g, '/');
      mkdirSync(dirname(dynamicFilePath), { recursive: true });
      writeFileSync(
        dynamicFilePath,
        `export async function loadServer() {\n  return await import('${relToServer}');\n}\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir,
        entryFiles: [dynamicFilePath],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.resolvedPath?.includes('src/server/config'))).toBe(true);
    });
  });

  it('6. Gerçek production tsconfig @server yolunu kanonik sunucu dosyasına çözmeli ve reddetmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const appFilePath = join(tempDir, 'src', 'app', 'aliased-test.ts');
      mkdirSync(dirname(appFilePath), { recursive: true });
      writeFileSync(
        appFilePath,
        `import { parseServerConfig } from '@server/config';\nexport const val = parseServerConfig;\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir,
        entryFiles: [appFilePath],
      });

      expect(violations.length).toBeGreaterThan(0);
      const violation = violations.find((v) => v.importPath === '@server/config');
      expect(violation).toBeDefined();
      expect(violation?.resolvedPath).toBeDefined();

      const canonicalFixture = realpathSync(resolve(rootDir, 'src/server/config.ts'));
      const canonicalResolved = realpathSync(resolve(rootDir, violation!.resolvedPath!));
      expect(canonicalResolved).toBe(canonicalFixture);
    });
  });

  it('6b. Gerçek production tsconfig içindeki çözümlenemeyen @server alias yolu fail-closed olmalıdır', () => {
    runWithTempFixture({}, (tempDir) => {
      const appFilePath = join(tempDir, 'src', 'app', 'unresolved-production-alias.ts');
      mkdirSync(dirname(appFilePath), { recursive: true });
      writeFileSync(appFilePath, `import '@server/does-not-exist';\n`, 'utf-8');

      const violations = checkSourceBoundaries({ rootDir, entryFiles: [appFilePath] });

      expect(violations.some((v) => v.importPath === '@server/does-not-exist')).toBe(true);
      expect(
        violations.some((v) => v.reason?.includes('Çözümlenemeyen yerel/proje veya takma ad')),
      ).toBe(true);
    });
  });

  it('11b. Varsayılan kaynak keşfi altında junction ile görünen canonical server girişini reddetmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const serverDir = join(tempDir, 'src', 'server');
      const appDir = join(tempDir, 'src', 'app');
      mkdirSync(serverDir, { recursive: true });
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(serverDir, 'secret-module.ts'), 'export const secret = true;\n', 'utf-8');

      const linkDir = join(appDir, 'server-junction');
      symlinkSync(serverDir, linkDir, 'junction');
      expect(realpathSync(linkDir)).toBe(realpathSync(serverDir));

      const violations = checkSourceBoundaries({ rootDir: tempDir });
      expect(violations.some((v) => v.importPath === '<canonical-entry>')).toBe(true);
      expect(violations.some((v) => v.reason?.includes('Kanonik giriş yolu'))).toBe(true);
    });
  });

  it('7. import equals (import x = require) ile sunucuya erişim reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const equalsFilePath = join(tempDir, 'src', 'app', 'import-equals.ts');
      const relToServer = relative(
        dirname(equalsFilePath),
        resolve(rootDir, 'src/server/config'),
      ).replace(/\\/g, '/');
      mkdirSync(dirname(equalsFilePath), { recursive: true });
      writeFileSync(
        equalsFilePath,
        `import serverConfig = require('${relToServer}');\nexport const x = serverConfig;\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir,
        entryFiles: [equalsFilePath],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.resolvedPath?.includes('src/server/config'))).toBe(true);
    });
  });

  it('8. require() çağrısı ile sunucuya erişim reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const requireFilePath = join(tempDir, 'src', 'app', 'direct-require.ts');
      const relToServer = relative(
        dirname(requireFilePath),
        resolve(rootDir, 'src/server/config'),
      ).replace(/\\/g, '/');
      mkdirSync(dirname(requireFilePath), { recursive: true });
      writeFileSync(
        requireFilePath,
        `const serverModule = require('${relToServer}');\nexport const x = serverModule;\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir,
        entryFiles: [requireFilePath],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.resolvedPath?.includes('src/server/config'))).toBe(true);
    });
  });

  it('9. Dinamik import() veya require() içinde hesaplanmış (computed) ifadeler fail-closed olarak reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const computedFilePath = join(tempDir, 'src', 'app', 'computed-import.ts');
      mkdirSync(dirname(computedFilePath), { recursive: true });
      writeFileSync(
        computedFilePath,
        `const target = './module';\nexport const p = import(target);\nexport const r = require(target);\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir: tempDir,
        entryFiles: [computedFilePath],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.importPath === '<computed-dynamic-import>')).toBe(true);
      expect(violations.some((v) => v.importPath === '<computed-require>')).toBe(true);
    });
  });

  it('10. Çözümlenemeyen yerel/proje ve takma ad ithalatları fail-closed olarak reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const unresolvedFilePath = join(tempDir, 'src', 'app', 'unresolved.ts');
      mkdirSync(dirname(unresolvedFilePath), { recursive: true });
      writeFileSync(
        unresolvedFilePath,
        `import { nonexistent } from './nonexistent-local-file';\nimport { fake } from '@app/missing-alias';\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir: tempDir,
        entryFiles: [unresolvedFilePath],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.importPath === './nonexistent-local-file')).toBe(true);
      expect(violations.some((v) => v.importPath === '@app/missing-alias')).toBe(true);
    });
  });
});

describe('Bulgu 2: Kanonikleştirme, Sembolik Bağ ve Dizin Kaçış Testleri', () => {
  it('11. Sembolik bağ / junction üzerinden sunucu dizinine erişim tespit edilip reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const serverDir = join(tempDir, 'src', 'server');
      mkdirSync(serverDir, { recursive: true });
      const serverSecretFile = join(serverDir, 'secret-module.ts');
      writeFileSync(serverSecretFile, `export const secret = 'server-secret';\n`, 'utf-8');

      const appDir = join(tempDir, 'src', 'app');
      mkdirSync(appDir, { recursive: true });

      const linkDir = join(appDir, 'server-junction');
      symlinkSync(serverDir, linkDir, 'junction');
      expect(realpathSync(linkDir)).toBe(realpathSync(serverDir));

      const appFile = join(appDir, 'junction-entry.ts');
      writeFileSync(
        appFile,
        `import { secret } from './server-junction/secret-module';\nexport const x = secret;\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir: tempDir,
        entryFiles: [appFile],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.resolvedPath?.includes('src/server/secret-module'))).toBe(
        true,
      );
    });
  });

  it('12. Proje kök dizini dışına kaçışlar (outside-root escape) reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const projectDir = join(tempDir, 'project-root');
      const outsideDir = join(tempDir, 'outside-secret');
      mkdirSync(outsideDir, { recursive: true });
      mkdirSync(join(projectDir, 'src', 'app'), { recursive: true });

      const outsideFile = join(outsideDir, 'external.ts');
      writeFileSync(outsideFile, `export const outsideSecret = 'leaked-data';\n`, 'utf-8');

      const appFile = join(projectDir, 'src', 'app', 'leak-attempt.ts');
      const relToOutside = relative(dirname(appFile), outsideFile).replace(/\\/g, '/');
      writeFileSync(
        appFile,
        `import { outsideSecret } from '${relToOutside}';\nexport const x = outsideSecret;\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir: projectDir,
        entryFiles: [appFile],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.reason?.includes('outside-root escape'))).toBe(true);
    });
  });
});

describe('Bulgu 3: Ortam Değişkeni Kapsamı (process.env ve import.meta.env Yasakları)', () => {
  it('13. src/app içindeki global process nesnesinin tüm çalıştırılabilir kullanım biçimleri reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const testCases = [
        { file: 'dot.ts', code: `export const val = process.env.VITE_SOME;\n` },
        { file: 'bracket.ts', code: `export const val = process.env['VITE_SOME'];\n` },
        { file: 'computed.ts', code: `const k = 'KEY';\nexport const val = process.env[k];\n` },
        { file: 'alias.ts', code: `const envRef = process.env;\nexport const val = envRef;\n` },
        {
          file: 'destructure.ts',
          code: `const { VITE_SOME } = process.env;\nexport const val = VITE_SOME;\n`,
        },
        { file: 'process-alias.ts', code: `export const p = process;\n` },
        { file: 'function-return.ts', code: `export function getProcess() { return process; }\n` },
        { file: 'arrow-return.ts', code: `export const getProcess = () => process;\n` },
        {
          file: 'conditional.ts',
          code: `declare const condition: boolean;\nexport const val = condition ? process : {};\n`,
        },
        { file: 'object.ts', code: `export const val = { runtime: process };\n` },
        {
          file: 'argument.ts',
          code: `declare function consume(value: unknown): void;\nconsume(process);\n`,
        },
      ];

      for (const tc of testCases) {
        const filePath = join(tempDir, 'src', 'app', tc.file);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, tc.code, 'utf-8');

        const violations = checkSourceBoundaries({
          rootDir: tempDir,
          entryFiles: [filePath],
        });

        expect(violations.length).toBeGreaterThan(0);
        expect(
          violations.some((v) => v.importPath === '<prohibited-runtime-identifier:process>'),
        ).toBe(true);
      }
    });
  });

  it('13b. process.env metni yalnız string veya yorum içindeyse ihlal üretmemelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const filePath = join(tempDir, 'src', 'app', 'text-only.ts');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        `// process.env.COMMENT_ONLY\nexport const text = "process.env.STRING_ONLY";\n`,
        'utf-8',
      );

      expect(checkSourceBoundaries({ rootDir: tempDir, entryFiles: [filePath] })).toEqual([]);
    });
  });

  it('13c. global process runtime dolaylı erişimleri ve node:process importları reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const testCases = [
        { file: 'global-computed.ts', code: `export const p = globalThis['process'];\n` },
        {
          file: 'reflect.ts',
          code: `export const p = Reflect.get(globalThis, 'process');\n`,
        },
        {
          file: 'global-alias.ts',
          code: `const runtimeGlobal = globalThis;\nexport const p = runtimeGlobal.process;\n`,
        },
        {
          file: 'global-computed-concat.ts',
          code: `export const p = globalThis['pro' + 'cess'];\n`,
        },
        {
          file: 'reflect-computed-concat.ts',
          code: `export const p = Reflect.get(globalThis, 'pro' + 'cess');\n`,
        },
        {
          file: 'reflect-bracket.ts',
          code: `export const p = Reflect['get'](globalThis, 'process');\n`,
        },
        {
          file: 'global-value-of.ts',
          code: `export const p = globalThis.valueOf().process;\n`,
        },
        {
          file: 'global-self-chain.ts',
          code: `export const p = globalThis.self.process;\n`,
        },
        {
          file: 'reflect-alias-dynamic.ts',
          code: `const RuntimeReflect = Reflect;\ndeclare const key: string;\nexport const p = RuntimeReflect.get(globalThis.self, key);\n`,
        },
        {
          file: 'node-import.ts',
          code: `import runtime from 'node:process';\nexport { runtime };\n`,
        },
        {
          file: 'node-named.ts',
          code: `import { env as runtimeEnv } from 'node:process';\nexport { runtimeEnv };\n`,
        },
        { file: 'node-require.ts', code: `export const runtime = require('node:process');\n` },
        {
          file: 'comma-require.ts',
          code: `export const runtime = (0, require)('node:process');\n`,
        },
        {
          file: 'module-require.ts',
          code: `export const runtime = module.require('node:' + 'process');\n`,
        },
        {
          file: 'require-alias-variable.ts',
          code: `const load = require;\nconst target = 'node:process';\nexport const runtime = load(target);\n`,
        },
      ];

      for (const tc of testCases) {
        const filePath = join(tempDir, 'src', 'app', tc.file);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, tc.code, 'utf-8');
        expect(
          checkSourceBoundaries({ rootDir: tempDir, entryFiles: [filePath] }).length,
        ).toBeGreaterThan(0);
      }
    });
  });

  it('13d. Yerel process binding ve yalnız process adlı nesne alanı global runtime ihlali değildir', () => {
    runWithTempFixture({}, (tempDir) => {
      const filePath = join(tempDir, 'src', 'app', 'local-process.ts');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        `const process = { version: 'local' };\nconst Reflect = { get: (_target: object, key: string) => key };\nconst globalThis = { self: { label: true } };\nexport const version = process.version;\nexport const metadata = { process: 'label' };\nexport const reflected = Reflect.get({}, 'process');\nexport const localGlobal = globalThis.self;\n`,
        'utf-8',
      );

      expect(checkSourceBoundaries({ rootDir: tempDir, entryFiles: [filePath] })).toEqual([]);
    });
  });

  it('14. src/app içinde yalnızca import.meta.env.VITE_* serbest olmalı; VITE_ dışı veya doğrudan nesne yasaklanmalıdır', () => {
    runWithTempFixture({}, (tempDir) => {
      const allowedFile = join(tempDir, 'src', 'app', 'allowed-meta.ts');
      mkdirSync(dirname(allowedFile), { recursive: true });
      writeFileSync(
        allowedFile,
        `export const apiUrl = import.meta.env.VITE_API_URL;\nexport const title = import.meta.env['VITE_APP_TITLE'];\n`,
        'utf-8',
      );

      const allowedViolations = checkSourceBoundaries({
        rootDir: tempDir,
        entryFiles: [allowedFile],
      });
      expect(allowedViolations).toEqual([]);

      const forbiddenFile = join(tempDir, 'src', 'app', 'forbidden-meta.ts');
      writeFileSync(
        forbiddenFile,
        `export const dbSecret = import.meta.env.DB_PASSWORD;\nconst rawEnv = import.meta.env;\nexport const x = rawEnv;\n`,
        'utf-8',
      );

      const forbiddenViolations = checkSourceBoundaries({
        rootDir: tempDir,
        entryFiles: [forbiddenFile],
      });
      expect(forbiddenViolations.length).toBeGreaterThan(0);
      expect(
        forbiddenViolations.some((v) => v.importPath === '<import.meta.env.DB_PASSWORD>'),
      ).toBe(true);
      expect(forbiddenViolations.some((v) => v.importPath === '<import.meta.env-raw>')).toBe(true);
    });
  });

  it('15. src/shared içinde hem process.env hem import.meta.env çalışma zamanı erişimleri tamamen reddedilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const sharedEnvFile = join(tempDir, 'src', 'shared', 'runtime-env-test.ts');
      mkdirSync(dirname(sharedEnvFile), { recursive: true });
      writeFileSync(
        sharedEnvFile,
        `export const a = process.env.APP_ENV;\nexport const b = import.meta.env.VITE_API_URL;\n`,
        'utf-8',
      );

      const violations = checkSourceBoundaries({
        rootDir: tempDir,
        entryFiles: [sharedEnvFile],
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(
        violations.some((v) => v.importPath === '<prohibited-runtime-identifier:process>'),
      ).toBe(true);
      expect(violations.some((v) => v.importPath === '<shared-import.meta.env>')).toBe(true);
    });
  });
});

describe('Bulgu 4: İstemci Demeti Gizli Bilgi Sızıntı Taraması (Dotenv Semantiği ve 1-3 Karakter Sırlar)', () => {
  it('16. 1-3 karakterlik boş olmayan sunucu sırları atlanmamalı ve demette tespit edilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const distDir = join(tempDir, 'dist', 'client');
      mkdirSync(distDir, { recursive: true });

      const envFile = join(tempDir, '.env');
      writeFileSync(
        envFile,
        `SHORT_SECRET=xyz\nTINY_SECRET=1\nVITE_PUBLIC=hello\nEMPTY_VAL=\n`,
        'utf-8',
      );

      const bundleFile = join(distDir, 'main.js');
      writeFileSync(bundleFile, `console.log("Sunucu sırrı: xyz ve token: 1");`, 'utf-8');

      const result = checkClientBundleForSecrets({
        rootDir: tempDir,
        distDir,
        envPath: envFile,
      });

      expect(result.checked).toBe(true);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations.some((v) => v.variableName === 'SHORT_SECRET')).toBe(true);
      expect(result.violations.some((v) => v.variableName === 'TINY_SECRET')).toBe(true);
      expect(result.violations.some((v) => v.variableName === 'VITE_PUBLIC')).toBe(false);
      expect(result.violations.some((v) => v.variableName === 'EMPTY_VAL')).toBe(false);
    });
  });

  it('17. JSON veya JS içinde çözümlenmiş ya da kaçış karakterli dizge temsilleri tespit edilmeli, değerler çıktıda asla yer almamalıdır', () => {
    runWithTempFixture({}, (tempDir) => {
      const distDir = join(tempDir, 'dist', 'client');
      mkdirSync(distDir, { recursive: true });

      const secretName = 'SECRET_ESCAPE';
      const secretVal = 'secret"with"quote\\and\nnewline';

      const envFile = join(tempDir, '.env');
      writeFileSync(envFile, `${secretName}="secret\\"with\\"quote\\\\and\\nnewline"\n`, 'utf-8');

      const bundleFile = join(distDir, 'bundle-escaped.js');
      writeFileSync(
        bundleFile,
        `const payload = ${JSON.stringify({ leak: secretVal })};\n`,
        'utf-8',
      );

      const result = checkClientBundleForSecrets({
        rootDir: tempDir,
        distDir,
        envPath: envFile,
      });

      expect(result.checked).toBe(true);
      const violation = result.violations.find((v) => v.variableName === secretName);
      expect(violation).toBeDefined();
      expect(violation?.reason).toBe(`SECRET LEAK: FOUND (${secretName})`);
      // Değerin kendisi asla hata nedeninde veya raporda yer almamalıdır
      expect(violation?.reason.includes(secretVal)).toBe(false);
      expect(violation?.reason.includes('quote')).toBe(false);
    });
  });

  it('18. .env bulunmadığında sentetik işaretçi denetimini korumalıdır', () => {
    runWithTempFixture({}, (tempDir) => {
      const distDir = join(tempDir, 'dist', 'client');
      mkdirSync(distDir, { recursive: true });

      const bundlePath = join(distDir, 'bundle.js');
      writeFileSync(bundlePath, `console.log("${SYNTHETIC_SECRET_MARKER}");`, 'utf-8');

      const result = checkClientBundleForSecrets({
        rootDir: tempDir,
        distDir,
        envPath: join(tempDir, 'nonexistent.env'),
      });

      expect(result.checked).toBe(true);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations.some((v) => v.variableName === 'SYNTHETIC_SECRET_MARKER')).toBe(
        true,
      );
    });
  });

  it('19. Vite loadEnv tırnak, yorum ve boş değer semantiğiyle project secret değerlerini çözmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const envContent = `
# Yorum satırı
DOUBLE_QUOTE="hello world"
SINGLE_QUOTE='single value'
QUOTE_WITH_HASH="value # not a comment"
SINGLE_WITH_HASH='value # also not a comment'
TRAILING_COMMENT=regular_value # this is a comment
SPACED_KEY   =   spaced_value   
EMPTY_RAW=
EMPTY_QUOTED=""
EMPTY_SINGLE=''
SHORT_VAL=abc
TINY_VAL=z
export EXPORTED_KEY="exported value"
VITE_PUBLIC_KEY="public"
`;
      writeFileSync(join(tempDir, '.env'), envContent, 'utf-8');

      const map = new Map(loadProjectEnvSecrets({ rootDir: tempDir }));

      expect(map.get('DOUBLE_QUOTE')).toBe('hello world');
      expect(map.get('SINGLE_QUOTE')).toBe('single value');
      expect(map.get('QUOTE_WITH_HASH')).toBe('value # not a comment');
      expect(map.get('SINGLE_WITH_HASH')).toBe('value # also not a comment');
      expect(map.get('TRAILING_COMMENT')).toBe('regular_value');
      expect(map.get('SPACED_KEY')).toBe('spaced_value');
      expect(map.get('SHORT_VAL')).toBe('abc');
      expect(map.get('TINY_VAL')).toBe('z');
      expect(map.get('EXPORTED_KEY')).toBe('exported value');
      expect(map.has('EMPTY_RAW')).toBe(false);
      expect(map.has('EMPTY_QUOTED')).toBe(false);
      expect(map.has('EMPTY_SINGLE')).toBe(false);
      expect(map.has('VITE_PUBLIC_KEY')).toBe(false);
    });
  });

  it('19b. Vite değişken genişletmesi effective secret değerini üretmeli ve genişletilmiş sızıntıyı yakalamalıdır', () => {
    runWithTempFixture({}, (tempDir) => {
      writeFileSync(
        join(tempDir, '.env'),
        `BASE_PART=abc\nSERVER_SECRET=\${BASE_PART}-xyz\n`,
        'utf-8',
      );
      const secrets = new Map(loadProjectEnvSecrets({ rootDir: tempDir }));
      expect(secrets.get('SERVER_SECRET')).toBe('abc-xyz');

      const distDir = join(tempDir, 'dist', 'client');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'main.js'), `const leaked = "abc-xyz";\n`, 'utf-8');

      const result = checkClientBundleForSecrets({ rootDir: tempDir, distDir });
      expect(result.violations.some((v) => v.variableName === 'SERVER_SECRET')).toBe(true);
    });
  });

  it('19c. Production env precedence Vite ile aynı effective değeri kullanmalıdır', () => {
    runWithTempFixture({}, (tempDir) => {
      writeFileSync(join(tempDir, '.env'), 'SERVER_SECRET=base\n', 'utf-8');
      writeFileSync(join(tempDir, '.env.local'), 'SERVER_SECRET=local\n', 'utf-8');
      writeFileSync(join(tempDir, '.env.production'), 'SERVER_SECRET=production\n', 'utf-8');
      writeFileSync(
        join(tempDir, '.env.production.local'),
        'SERVER_SECRET=production-local\n',
        'utf-8',
      );

      const secrets = new Map(loadProjectEnvSecrets({ rootDir: tempDir, mode: 'production' }));
      expect(secrets.get('SERVER_SECRET')).toBe('production-local');
    });
  });

  it('20. Odak Test: Ham, JSON kodlu ve JavaScript kaçış karakterli (unicode/hex) dizge temsilleri tespit edilmelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const distDir = join(tempDir, 'dist', 'client');
      mkdirSync(distDir, { recursive: true });

      const envFile = join(tempDir, '.env');
      writeFileSync(
        envFile,
        `UNICODE_SECRET=alpha\nHEX_SECRET=beta\nJSON_SECRET=quote"newline\\test\n`,
        'utf-8',
      );

      const bundleFile = join(distDir, 'main.js');
      writeFileSync(
        bundleFile,
        `
const a = "\\u0061\\u006c\\u0070\\u0068\\u0061";
const b = "\\x62\\x65\\x74\\x61";
const c = ${JSON.stringify('quote"newline\\test')};
`,
        'utf-8',
      );

      const result = checkClientBundleForSecrets({
        rootDir: tempDir,
        distDir,
        envPath: envFile,
      });

      expect(result.checked).toBe(true);
      expect(result.violations.some((v) => v.variableName === 'UNICODE_SECRET')).toBe(true);
      expect(result.violations.some((v) => v.variableName === 'HEX_SECRET')).toBe(true);
      expect(result.violations.some((v) => v.variableName === 'JSON_SECRET')).toBe(true);
    });
  });

  it('20b. Çift kaçışlı Unicode JS literal gösterimi çalışma zamanında sırra dönüşüyorsa yakalanmalıdır', () => {
    runWithTempFixture({}, (tempDir) => {
      const distDir = join(tempDir, 'dist', 'client');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(tempDir, '.env'), 'RUNTIME_SECRET=alpha\n', 'utf-8');
      writeFileSync(
        join(distDir, 'runtime.js'),
        String.raw`const leak = JSON.parse('"\\u0061\\u006c\\u0070\\u0068\\u0061"');`,
        'utf-8',
      );

      const result = checkClientBundleForSecrets({ rootDir: tempDir, distDir });
      expect(result.violations.some((v) => v.variableName === 'RUNTIME_SECRET')).toBe(true);
    });
  });

  it('21. Odak Test: 1-3 karakterlik kısa sırlar atlanmamalı ve demette sızıntı durumunda güvenle hata vermelidir', () => {
    runWithTempFixture({}, (tempDir) => {
      const distDir = join(tempDir, 'dist', 'client');
      mkdirSync(distDir, { recursive: true });

      const envFile = join(tempDir, '.env');
      writeFileSync(envFile, `KEY_ONE=1\nKEY_TWO=ab\nKEY_THREE=xyz\nEMPTY_VAL=\n`, 'utf-8');

      const bundleFile = join(distDir, 'app.js');
      writeFileSync(
        bundleFile,
        `const config = { token: "xyz", flag: "ab", digit: "1" };\n`,
        'utf-8',
      );

      const result = checkClientBundleForSecrets({
        rootDir: tempDir,
        distDir,
        envPath: envFile,
      });

      expect(result.checked).toBe(true);
      expect(result.violations.some((v) => v.variableName === 'KEY_ONE')).toBe(true);
      expect(result.violations.some((v) => v.variableName === 'KEY_TWO')).toBe(true);
      expect(result.violations.some((v) => v.variableName === 'KEY_THREE')).toBe(true);
      expect(result.violations.some((v) => v.variableName === 'EMPTY_VAL')).toBe(false);
    });
  });

  it('21b. 1-3 karakterlik secret demette bulunmasa bile güvenli doğrulanamadığı için fail-closed olmalıdır', () => {
    runWithTempFixture({}, (tempDir) => {
      const distDir = join(tempDir, 'dist', 'client');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(tempDir, '.env'), 'TINY_SECRET=xy\n', 'utf-8');
      writeFileSync(join(distDir, 'app.js'), 'const harmless = "nothing here";\n', 'utf-8');

      const result = checkClientBundleForSecrets({ rootDir: tempDir, distDir });
      const violation = result.violations.find((v) => v.variableName === 'TINY_SECRET');
      expect(violation?.reason).toBe('SECRET VALUE TOO SHORT FOR SAFE VERIFICATION: TINY_SECRET');
    });
  });

  it('22. Odak Test: İhlal raporlarında ve hata çıktılarında yalnızca değişken adı yer almalı, sır değerleri asla sızdırılmamalıdır', () => {
    runWithTempFixture({}, (tempDir) => {
      const distDir = join(tempDir, 'dist', 'client');
      mkdirSync(distDir, { recursive: true });

      const secretVal = 'SUPER_SECRET_PAYLOAD_VALUE_999';
      const envFile = join(tempDir, '.env');
      writeFileSync(envFile, `DB_PASSWORD=${secretVal}\n`, 'utf-8');

      const bundleFile = join(distDir, 'bundle.js');
      writeFileSync(bundleFile, `console.log("${secretVal}");\n`, 'utf-8');

      const result = checkClientBundleForSecrets({
        rootDir: tempDir,
        distDir,
        envPath: envFile,
      });

      expect(result.checked).toBe(true);
      expect(result.violations.length).toBeGreaterThan(0);

      for (const violation of result.violations) {
        expect(violation.variableName).toBe('DB_PASSWORD');
        expect(violation.reason).toContain('DB_PASSWORD');
        expect(violation.reason.includes(secretVal)).toBe(false);
        expect(JSON.stringify(violation).includes(secretVal)).toBe(false);
      }
    });
  });
});
