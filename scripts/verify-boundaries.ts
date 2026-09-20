import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, relative, normalize, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import ts from 'typescript';
import { loadEnv } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const rootDir = resolve(__filename, '../..');

export const SYNTHETIC_SECRET_MARKER =
  'SYNTHETIC_SERVER_SECRET_MARKER_DO_NOT_LEAK_INTO_CLIENT_BUNDLE';

export interface BoundaryViolation {
  file: string;
  importPath: string;
  resolvedPath?: string;
  reason?: string;
  chain?: string[];
}

export interface SecretLeakViolation {
  file: string;
  reason: string;
  variableName?: string;
}

export interface BundleCheckResult {
  checked: boolean;
  violations: SecretLeakViolation[];
  message?: string;
}

export interface CheckBoundariesOptions {
  rootDir?: string;
  entryDirs?: string[];
  entryFiles?: string[];
  tsConfigPath?: string;
  customAliases?: Record<string, string | string[]>;
  serverDirName?: string;
}

export interface BundleCheckOptions {
  rootDir?: string;
  distDir?: string;
  envPath?: string;
  mode?: string;
}

/**
 * Dosya yolunu kanonik (canonical) gerçek yola dönüştürür.
 * Sembolik bağları (symlink) ve bağlantı noktalarını (junction) çözer.
 */
export function canonicalizePath(p: string): string {
  try {
    if (existsSync(p)) {
      return realpathSync(p);
    }
  } catch {
    // Erişilemeyen veya sanal yollarda resolve ile devam et
  }
  return resolve(p);
}

/**
 * Büyük/küçük harf ve ters bölü (\) farklarını ortadan kaldırarak
 * platformdan bağımsız karşılaştırma için yolu normalize eder.
 */
export function normalizePathForComparison(p: string): string {
  return normalize(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * Hedef yolun belirtilen üst dizinle aynı veya onun altında olup olmadığını kontrol eder.
 */
export function isSameOrInside(parentDir: string, targetPath: string): boolean {
  const normParent = normalizePathForComparison(parentDir).replace(/\/+$/, '');
  const normTarget = normalizePathForComparison(targetPath).replace(/\/+$/, '');
  return normTarget === normParent || normTarget.startsWith(normParent + '/');
}

/**
 * Belirtilen dizindeki dosyaları özyinelemeli olarak listeler.
 */
function getAllFiles(dir: string, fileList: string[] = []): string[] {
  if (!existsSync(dir)) return fileList;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      getAllFiles(fullPath, fileList);
    } else {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

interface ExtractedSpecifier {
  specifier: string;
  kind: 'static-import' | 'export-from' | 'import-equals' | 'require' | 'dynamic-import';
}

/**
 * TypeScript AST üzerinden statik import, export-from, export-star,
 * import-equals, require ve dynamic import çağrılarını ayıklar.
 * Dinamik/hesaplanmış (computed) ifadeleri doğrudan ihlal olarak bildirir (Fail-Closed).
 */
function extractImportSpecifiers(
  sourceFile: ts.SourceFile,
  filePath: string,
  effectiveRootDir: string,
  violations: BoundaryViolation[],
): ExtractedSpecifier[] {
  const specifiers: ExtractedSpecifier[] = [];
  const relFile = relative(effectiveRootDir, filePath).replace(/\\/g, '/');

  function visit(node: ts.Node) {
    // 1. Statik import bildirimi (import ... from '...')
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push({
          specifier: node.moduleSpecifier.text,
          kind: 'static-import',
        });
      } else {
        violations.push({
          file: relFile,
          importPath: '<computed-import-declaration>',
          reason: 'Statik import bildiriminde dizge harici belirteç kullanımı yasaktır.',
        });
      }
    }
    // 2. Yeniden dışa aktarım (export ... from '...' / export * from '...')
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push({
          specifier: node.moduleSpecifier.text,
          kind: 'export-from',
        });
      } else {
        violations.push({
          file: relFile,
          importPath: '<computed-export-declaration>',
          reason: 'Yeniden dışa aktarımda (export-from) dizge harici belirteç kullanımı yasaktır.',
        });
      }
    }
    // 3. Dinamik import() çağrısı (import('...'))
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length === 0) {
        violations.push({
          file: relFile,
          importPath: '<empty-dynamic-import>',
          reason: 'Boş dinamik import() çağrısı tespit edildi.',
        });
      } else {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          specifiers.push({
            specifier: arg.text,
            kind: 'dynamic-import',
          });
        } else {
          violations.push({
            file: relFile,
            importPath: '<computed-dynamic-import>',
            reason:
              'Dinamik import() çağrısında dinamik/hesaplanmış (computed) ifade kullanımı güvenlik nedeniyle yasaktır.',
          });
        }
      }
    }
    // 4. import foo = require('...')
    else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const expr = node.moduleReference.expression;
        if (expr && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))) {
          specifiers.push({
            specifier: expr.text,
            kind: 'import-equals',
          });
        } else {
          violations.push({
            file: relFile,
            importPath: '<computed-import-equals>',
            reason:
              'import equals (require) bildiriminde dinamik/hesaplanmış ifade kullanımı yasaktır.',
          });
        }
      }
    }
    // 5. Doğrudan require('...') veya require.resolve('...') çağrısı
    else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'require' &&
          node.expression.name.text === 'resolve'))
    ) {
      if (node.arguments.length === 0) {
        violations.push({
          file: relFile,
          importPath: '<empty-require>',
          reason: 'Boş require() çağrısı tespit edildi.',
        });
      } else {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          specifiers.push({
            specifier: arg.text,
            kind: 'require',
          });
        } else {
          violations.push({
            file: relFile,
            importPath: '<computed-require>',
            reason:
              'require() çağrısında dinamik/hesaplanmış (computed) ifade kullanımı güvenlik nedeniyle yasaktır.',
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

/**
 * Kaynak kod içinde sunucu yapılandırması sembolleri, CLOUDFLARE_API_KEY,
 * process.env ve yetkisiz import.meta.env erişimlerini denetler.
 *
 * SÖZLEŞME:
 * - src/app ve src/shared içinde process.env kullanımı (nokta, köşeli parantez,
 *   hesaplanmış, takma ad ve yeniden yapılandırma dahil) tamamen yasaktır.
 * - src/shared içinde çalışma zamanı ortam değişkeni (import.meta.env) yasaktır.
 * - src/app içinde yalnızca import.meta.env.VITE_* erişimine izin verilir.
 */
function checkForbiddenSourceSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filePath: string,
  effectiveRootDir: string,
  violations: BoundaryViolation[],
): void {
  const relFile = relative(effectiveRootDir, filePath).replace(/\\/g, '/');
  const normFilePath = filePath.replace(/\\/g, '/').toLowerCase();
  const isShared = normFilePath.includes('/src/shared/') || normFilePath.includes('/shared/');
  const isApp = !isShared && (normFilePath.includes('/src/app/') || normFilePath.includes('/app/'));

  function isNameOnlyIdentifier(node: ts.Identifier): boolean {
    const parent = node.parent;
    return (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node) ||
      (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
      (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
      (ts.isPropertyDeclaration(parent) && parent.name === node) ||
      (ts.isPropertySignature(parent) && parent.name === node) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
      (ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isFunctionExpression(parent) && parent.name === node) ||
      (ts.isClassDeclaration(parent) && parent.name === node) ||
      (ts.isClassExpression(parent) && parent.name === node) ||
      (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
      (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
      (ts.isEnumDeclaration(parent) && parent.name === node) ||
      (ts.isImportClause(parent) && parent.name === node) ||
      (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
      (ts.isNamespaceImport(parent) && parent.name === node) ||
      (ts.isImportEqualsDeclaration(parent) && parent.name === node) ||
      (ts.isLabeledStatement(parent) && parent.label === node) ||
      ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node)
    );
  }

  function resolvesToLocalBinding(node: ts.Identifier): boolean {
    let symbol = checker.getSymbolAtLocation(node);
    if (ts.isShorthandPropertyAssignment(node.parent)) {
      symbol = checker.getShorthandAssignmentValueSymbol(node.parent) ?? symbol;
    }
    return Boolean(
      symbol?.declarations?.some((declaration) => declaration.getSourceFile() === sourceFile),
    );
  }

  const prohibitedRuntimeIdentifiers = new Set([
    'process',
    'require',
    'module',
    'globalThis',
    'global',
    'window',
    'self',
  ]);

  function visit(node: ts.Node) {
    // 1. CLOUDFLARE_API_KEY doğrudan sembol veya literal erişim kontrolü
    if (
      (ts.isIdentifier(node) && node.text === 'CLOUDFLARE_API_KEY') ||
      (ts.isStringLiteral(node) && node.text === 'CLOUDFLARE_API_KEY')
    ) {
      violations.push({
        file: relFile,
        importPath: '<secret-access: CLOUDFLARE_API_KEY>',
        reason:
          'İstemci veya paylaşılan kod içinde CLOUDFLARE_API_KEY erişimi kesinlikle yasaktır!',
      });
    }

    // 2. Sunucu yapılandırması sembollerine erişim denetimi
    if (
      ts.isIdentifier(node) &&
      (node.text === 'parseServerConfig' ||
        node.text === 'ServerConfig' ||
        node.text === 'ServerConfigSchema' ||
        node.text === 'SYNTHETIC_SERVER_SECRET_MARKER' ||
        node.text === 'parseAccessConfig' ||
        node.text === 'AccessConfig' ||
        node.text === 'createAccessVerifier' ||
        node.text === 'AccessVerifier')
    ) {
      violations.push({
        file: relFile,
        importPath: `<server-config-symbol: ${node.text}>`,
        reason: `İstemci veya paylaşılan kod içinde sunucu yapılandırması sembolü (${node.text}) kullanılamaz!`,
      });
    }

    // 3. İstemci/paylaşılan kod Node/CommonJS runtime nesnelerine veya global nesne
    // indirection'ına başvuramaz. Doğrudan web API'leri kendi global adlarıyla kullanılmalıdır.
    // Bu sade fail-closed kural alias/zincir takibi gerektirmeden process erişimini kapatır.
    if (
      ts.isIdentifier(node) &&
      prohibitedRuntimeIdentifiers.has(node.text) &&
      !isNameOnlyIdentifier(node) &&
      !resolvesToLocalBinding(node)
    ) {
      violations.push({
        file: relFile,
        importPath: `<prohibited-runtime-identifier:${node.text}>`,
        reason: `İstemci veya paylaşılan çalıştırılabilir kod içinde '${node.text}' runtime/global nesnesine başvuru yasaktır!`,
      });
    }

    // 4. import.meta.env denetimi:
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.expression.name.text === 'meta'
    ) {
      if (isShared) {
        violations.push({
          file: relFile,
          importPath: '<shared-import.meta.env>',
          reason:
            'Paylaşılan (src/shared) modüller içinde çalışma zamanı ortam değişkeni (import.meta.env) erişimi kesinlikle yasaktır! Paylaşılan modüller saf ve çalışma zamanından bağımsız olmalıdır.',
        });
      } else if (isApp) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          const propName = parent.name.text;
          if (!propName.startsWith('VITE_')) {
            violations.push({
              file: relFile,
              importPath: `<import.meta.env.${propName}>`,
              reason: `İstemci kodunda yalnızca import.meta.env.VITE_* erişimine izin verilir. '${propName}' erişimi yasaktır!`,
            });
          }
        } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
          const arg = parent.argumentExpression;
          if (arg && ts.isStringLiteral(arg) && arg.text.startsWith('VITE_')) {
            // VITE_ ile başlayan dizge sabitine izin verilir
          } else {
            violations.push({
              file: relFile,
              importPath: '<import.meta.env[...]>',
              reason:
                'İstemci kodunda import.meta.env üzerinden hesaplanmış veya VITE_ dışı erişim yasaktır!',
            });
          }
        } else {
          // Destructuring, alias veya doğrudan nesne aktarımı
          violations.push({
            file: relFile,
            importPath: '<import.meta.env-raw>',
            reason:
              'İstemci kodunda import.meta.env nesnesini takma adlandırma veya yeniden yapılandırma yasaktır; yalnızca doğrudan statik import.meta.env.VITE_* erişimi geçerlidir.',
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/**
 * Bir modül belirtecinin yerel/proje veya takma ad (alias) olup olmadığını belirler.
 */
function isLocalOrAliasSpecifier(specifier: string, configuredAliases: string[]): boolean {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    isAbsolute(specifier) ||
    /^[a-zA-Z]:[\\/]/.test(specifier)
  ) {
    return true;
  }
  if (
    specifier.startsWith('@app') ||
    specifier.startsWith('@shared') ||
    specifier.startsWith('@server') ||
    specifier.startsWith('@/') ||
    specifier.startsWith('~/')
  ) {
    return true;
  }
  for (const alias of configuredAliases) {
    const cleanAlias = alias.replace(/\/\*$/, '');
    if (specifier === cleanAlias || specifier.startsWith(cleanAlias + '/')) {
      return true;
    }
  }
  if (
    specifier.includes('src/server') ||
    specifier.includes('src/app') ||
    specifier.includes('src/shared')
  ) {
    return true;
  }
  return false;
}

/**
 * 1. TypeScript Compiler API Tabanlı Modül Grafiği Gezintisi (Module Graph Traversal)
 *
 * SÖZLEŞME VE KONTROLLER:
 * - Statik import, export-from, import-equals, require ve dinamik import() çözümlenir.
 * - Çözümlenemeyen yerel/proje ve takma ad (alias) ithalatları doğrudan reddedilir (Fail-Closed).
 * - Proje kökü, sunucu kökü ve çözümlenen modüller fs.realpathSync ile kanonikleştirilir.
 * - Sembolik bağlar (symlink/junction) üzerinden sunucuya sızmalar engellenir.
 * - Proje kök dizini dışına kaçışlar (outside-root escape) engellenir.
 */
export function checkSourceBoundaries(options?: CheckBoundariesOptions): BoundaryViolation[] {
  const effectiveRootDir = options?.rootDir || rootDir;
  const canonicalRootDir = canonicalizePath(effectiveRootDir);
  const rawServerDir = resolve(effectiveRootDir, options?.serverDirName || 'src/server');
  const canonicalServerDir = canonicalizePath(rawServerDir);

  const violations: BoundaryViolation[] = [];

  let initialFiles: string[] = [];
  if (options?.entryFiles && options.entryFiles.length > 0) {
    initialFiles = [...options.entryFiles];
  } else {
    const entryDirs = options?.entryDirs || [
      join(effectiveRootDir, 'src', 'app'),
      join(effectiveRootDir, 'src', 'shared'),
    ];
    for (const dir of entryDirs) {
      initialFiles.push(...getAllFiles(dir));
    }
  }

  const validExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'];
  const filesToCheck = initialFiles.filter((f) => validExtensions.some((ext) => f.endsWith(ext)));

  // tsconfig.json derleyici seçeneklerini yükle
  const tsconfigPath = options?.tsConfigPath || join(effectiveRootDir, 'tsconfig.json');
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
  };

  if (existsSync(tsconfigPath)) {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        effectiveRootDir,
      );
      compilerOptions = { ...compilerOptions, ...parsedConfig.options };
    }
  }

  const paths: Record<string, string[]> = { ...(compilerOptions.paths ?? {}) };

  if (options?.customAliases) {
    for (const [key, val] of Object.entries(options.customAliases)) {
      paths[key] = Array.isArray(val) ? val : [val];
    }
  }

  compilerOptions.paths = paths;

  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: () => effectiveRootDir,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };

  function isServerModule(filePath: string): boolean {
    const canonical = canonicalizePath(filePath);
    if (isSameOrInside(canonicalServerDir, canonical)) return true;
    const norm = normalizePathForComparison(canonical);
    return norm.includes('/src/server/') || norm.endsWith('/src/server');
  }

  const visitedFiles = new Set<string>();
  const queue: Array<{ filePath: string; chain: string[] }> = filesToCheck.map((f) => ({
    filePath: canonicalizePath(f),
    chain: [relative(effectiveRootDir, f).replace(/\\/g, '/')],
  }));

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const { filePath, chain } = item;
    const normCurrentFile = normalizePathForComparison(filePath);
    if (visitedFiles.has(normCurrentFile)) continue;
    visitedFiles.add(normCurrentFile);

    if (!existsSync(filePath)) continue;

    if (isServerModule(filePath)) {
      const relResolved = relative(effectiveRootDir, filePath).replace(/\\/g, '/');
      violations.push({
        file: chain[0] ?? relResolved,
        importPath: '<canonical-entry>',
        resolvedPath: relResolved,
        reason: `Kanonik giriş yolu sunucu sınırına çözülüyor: ${relResolved}`,
        chain,
      });
      continue;
    }

    if (!isSameOrInside(canonicalRootDir, filePath)) {
      const relResolved = relative(effectiveRootDir, filePath).replace(/\\/g, '/');
      violations.push({
        file: chain[0] ?? relResolved,
        importPath: '<canonical-entry>',
        resolvedPath: relResolved,
        reason: `Kanonik giriş yolu proje kökü dışına çözülüyor: ${relResolved}`,
        chain,
      });
      continue;
    }

    const program = ts.createProgram({
      rootNames: [filePath],
      options: {
        ...compilerOptions,
        noLib: true,
        noResolve: true,
        types: [],
      },
    });
    const sourceFile =
      program.getSourceFile(filePath) ??
      program
        .getSourceFiles()
        .find((candidate) => normalizePathForComparison(candidate.fileName) === normCurrentFile);
    if (!sourceFile) {
      violations.push({
        file: chain[0] ?? relative(effectiveRootDir, filePath).replace(/\\/g, '/'),
        importPath: '<source-parse-failure>',
        reason: 'Kaynak dosya TypeScript programına yüklenemedi; doğrulama fail-closed durduruldu.',
        chain,
      });
      continue;
    }

    // 1. Yasaklı sembol ve sır erişimi denetimi
    checkForbiddenSourceSymbols(
      sourceFile,
      program.getTypeChecker(),
      filePath,
      effectiveRootDir,
      violations,
    );

    // 2. Modül belirteçlerini çıkar ve çözümle
    const extractedSpecifiers = extractImportSpecifiers(
      sourceFile,
      filePath,
      effectiveRootDir,
      violations,
    );

    for (const item of extractedSpecifiers) {
      const specifier = item.specifier;

      if (specifier === 'process' || specifier === 'node:process') {
        violations.push({
          file: relative(effectiveRootDir, filePath).replace(/\\/g, '/'),
          importPath: specifier,
          reason: `İstemci veya paylaşılan kod içinde Node process runtime modülü (${specifier}) kullanılamaz!`,
          chain: [...chain, specifier],
        });
        continue;
      }

      const resolved = ts.resolveModuleName(specifier, filePath, compilerOptions, resolutionHost);

      if (resolved.resolvedModule) {
        const resolvedFileName = resolved.resolvedModule.resolvedFileName;
        const canonicalResolved = canonicalizePath(resolvedFileName);
        const isExternal =
          resolved.resolvedModule.isExternalLibraryImport ||
          canonicalResolved.replace(/\\/g, '/').includes('/node_modules/');

        // A. Sunucu modülü kontrolü (sembolik bağ/bağlantı noktası dahil)
        if (isServerModule(canonicalResolved)) {
          const relResolved = relative(effectiveRootDir, canonicalResolved).replace(/\\/g, '/');
          violations.push({
            file: relative(effectiveRootDir, filePath).replace(/\\/g, '/'),
            importPath: specifier,
            resolvedPath: relResolved,
            reason: `Sunucu modülü bağımlılığı tespit edildi: ${relResolved}`,
            chain: [...chain, specifier],
          });
          continue;
        }

        // B. Proje kök dizini dışına kaçış kontrolü (outside-root escape)
        if (!isExternal && !isSameOrInside(canonicalRootDir, canonicalResolved)) {
          const relResolved = relative(effectiveRootDir, canonicalResolved).replace(/\\/g, '/');
          violations.push({
            file: relative(effectiveRootDir, filePath).replace(/\\/g, '/'),
            importPath: specifier,
            resolvedPath: relResolved,
            reason: `Proje kök dizini dışına kaçış (outside-root escape) tespit edildi: ${relResolved}`,
            chain: [...chain, specifier],
          });
          continue;
        }

        // C. Geçişli (transitive) bağımlılık grafiği gezintisi
        if (!isExternal && existsSync(canonicalResolved)) {
          queue.push({
            filePath: canonicalResolved,
            chain: [...chain, specifier],
          });
        }
      } else {
        // Çözümlenemeyen modül: fail closed
        if (isLocalOrAliasSpecifier(specifier, Object.keys(compilerOptions.paths || {}))) {
          violations.push({
            file: relative(effectiveRootDir, filePath).replace(/\\/g, '/'),
            importPath: specifier,
            reason: `Çözümlenemeyen yerel/proje veya takma ad (alias) modül başvurusu: ${specifier}`,
            chain: [...chain, specifier],
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Protected permission executor yalnız merkezi route composer tarafından kullanılabilir.
 * Test kodu bu production kaynak taramasına dahil değildir.
 */
export function checkProtectedMutationExecutorBoundaries(
  options?: Pick<CheckBoundariesOptions, 'rootDir' | 'tsConfigPath'>,
): BoundaryViolation[] {
  const effectiveRootDir = options?.rootDir || rootDir;
  const serverDir = resolve(effectiveRootDir, 'src/server');
  const internalExecutor = canonicalizePath(
    resolve(serverDir, 'mutations/internal/protected-permission-executor.ts'),
  );
  const authorizedImporter = canonicalizePath(resolve(serverDir, 'mutations/protected-route.ts'));
  const violations: BoundaryViolation[] = [];
  if (!existsSync(serverDir) || !existsSync(internalExecutor)) return violations;

  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
  };
  const tsconfigPath = options?.tsConfigPath || resolve(effectiveRootDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!configFile.error) {
      compilerOptions = {
        ...compilerOptions,
        ...ts.parseJsonConfigFileContent(configFile.config, ts.sys, effectiveRootDir).options,
      };
    }
  }
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: () => effectiveRootDir,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };

  for (const filePath of getAllFiles(serverDir)) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(filePath)) continue;
    const sourceFile = ts.createSourceFile(
      filePath,
      readFileSync(filePath, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const extractionViolations: BoundaryViolation[] = [];
    const specifiers = extractImportSpecifiers(
      sourceFile,
      filePath,
      effectiveRootDir,
      extractionViolations,
    );
    // Bu production sınırında çözülemeyen bir computed import hedefinin internal
    // executor olmadığını kanıtlayamayız. Extractor'ın fail-closed ihlallerini
    // yutmadan doğrudan sonuca taşı.
    violations.push(...extractionViolations);
    for (const { specifier } of specifiers) {
      const resolved = ts.resolveModuleName(specifier, filePath, compilerOptions, resolutionHost);
      if (!resolved.resolvedModule) continue;
      const resolvedPath = canonicalizePath(resolved.resolvedModule.resolvedFileName);
      if (
        normalizePathForComparison(resolvedPath) !== normalizePathForComparison(internalExecutor)
      ) {
        continue;
      }
      if (
        normalizePathForComparison(canonicalizePath(filePath)) ===
        normalizePathForComparison(authorizedImporter)
      ) {
        continue;
      }
      violations.push({
        file: relative(effectiveRootDir, filePath).replace(/\\/g, '/'),
        importPath: specifier,
        resolvedPath: relative(effectiveRootDir, resolvedPath).replace(/\\/g, '/'),
        reason:
          'Internal protected mutation executor yalnız src/server/mutations/protected-route.ts tarafından içe aktarılabilir.',
      });
    }
  }
  return violations;
}

/**
 * Domain mutation executor sınırı (BLOCKER B):
 * Internal customer domain executor (src/server/mutations/internal/customer-domain-executor.ts)
 * yalnız `src/server/customers/service.ts` tarafından,
 * Internal catalog domain executor (src/server/mutations/internal/catalog-domain-executor.ts)
 * yalnız `src/server/catalogs/service.ts` tarafından içe aktarılabilir.
 * Başka hiçbir production sunucu dosyası, route handler veya harici modül doğrudan erişemez.
 * AST ve module-resolution ile statik import, export-from, literal dynamic import
 * ve computed/unresolved import bypassları fail-closed yakalanır.
 */
export function checkDomainMutationExecutorBoundaries(
  options?: Pick<CheckBoundariesOptions, 'rootDir' | 'tsConfigPath'>,
): BoundaryViolation[] {
  const effectiveRootDir = options?.rootDir || rootDir;
  const serverDir = resolve(effectiveRootDir, 'src/server');
  const internalCustomerExecutor = canonicalizePath(
    resolve(serverDir, 'mutations/internal/customer-domain-executor.ts'),
  );
  const internalCatalogExecutor = canonicalizePath(
    resolve(serverDir, 'mutations/internal/catalog-domain-executor.ts'),
  );
  const deprecatedExecutor = canonicalizePath(resolve(serverDir, 'mutations/domain-executor.ts'));
  const authorizedCustomerImporter = canonicalizePath(resolve(serverDir, 'customers/service.ts'));
  const authorizedCatalogImporter = canonicalizePath(resolve(serverDir, 'catalogs/service.ts'));
  const violations: BoundaryViolation[] = [];

  if (!existsSync(serverDir)) return violations;

  // 1. Deprecated modülde keyfi fonksiyon/interface dışa aktarımı kontrolü
  if (existsSync(deprecatedExecutor)) {
    const content = readFileSync(deprecatedExecutor, 'utf-8');
    if (
      content.includes('export function') ||
      content.includes('export const') ||
      content.includes('export type') ||
      content.includes('export interface')
    ) {
      violations.push({
        file: relative(effectiveRootDir, deprecatedExecutor).replace(/\\/g, '/'),
        importPath: '<deprecated-executor-export>',
        reason:
          'src/server/mutations/domain-executor.ts boş ve mühürlü (sealed) olmalıdır. Hiçbir capability export edemez.',
      });
    }
  }

  const executorsToCheck: Array<{
    executorPath: string;
    authorizedImporter: string;
    name: string;
    targetModule: string;
  }> = [];

  if (existsSync(internalCustomerExecutor)) {
    executorsToCheck.push({
      executorPath: internalCustomerExecutor,
      authorizedImporter: authorizedCustomerImporter,
      name: 'customer',
      targetModule: 'src/server/customers/service.ts',
    });
  }

  if (existsSync(internalCatalogExecutor)) {
    executorsToCheck.push({
      executorPath: internalCatalogExecutor,
      authorizedImporter: authorizedCatalogImporter,
      name: 'catalog',
      targetModule: 'src/server/catalogs/service.ts',
    });
  }

  if (executorsToCheck.length === 0) return violations;

  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
  };
  const tsconfigPath = options?.tsConfigPath || resolve(effectiveRootDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!configFile.error) {
      compilerOptions = {
        ...compilerOptions,
        ...ts.parseJsonConfigFileContent(configFile.config, ts.sys, effectiveRootDir).options,
      };
    }
  }
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: () => effectiveRootDir,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };

  for (const filePath of getAllFiles(serverDir)) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(filePath)) continue;
    const sourceFile = ts.createSourceFile(
      filePath,
      readFileSync(filePath, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const extractionViolations: BoundaryViolation[] = [];
    const specifiers = extractImportSpecifiers(
      sourceFile,
      filePath,
      effectiveRootDir,
      extractionViolations,
    );
    // Computed / dinamik import fail-closed
    violations.push(...extractionViolations);

    for (const { specifier } of specifiers) {
      const resolved = ts.resolveModuleName(specifier, filePath, compilerOptions, resolutionHost);
      if (!resolved.resolvedModule) continue;
      const resolvedPath = canonicalizePath(resolved.resolvedModule.resolvedFileName);

      // A. Internal domain executors kontrolü
      for (const executor of executorsToCheck) {
        if (
          normalizePathForComparison(resolvedPath) ===
          normalizePathForComparison(executor.executorPath)
        ) {
          if (
            normalizePathForComparison(canonicalizePath(filePath)) !==
            normalizePathForComparison(executor.authorizedImporter)
          ) {
            violations.push({
              file: relative(effectiveRootDir, filePath).replace(/\\/g, '/'),
              importPath: specifier,
              resolvedPath: relative(effectiveRootDir, resolvedPath).replace(/\\/g, '/'),
              reason: `Internal ${executor.name} domain executor yalnız ${executor.targetModule} tarafından içe aktarılabilir.`,
            });
          }
        }
      }

      // B. Deprecated executor import kontrolü
      if (
        normalizePathForComparison(resolvedPath) === normalizePathForComparison(deprecatedExecutor)
      ) {
        violations.push({
          file: relative(effectiveRootDir, filePath).replace(/\\/g, '/'),
          importPath: specifier,
          resolvedPath: relative(effectiveRootDir, resolvedPath).replace(/\\/g, '/'),
          reason:
            'Mühürlü domain-executor.ts içe aktarılamaz. Yalnızca internal domain executorlar ve yetkili servisler kullanılmalıdır.',
        });
      }
    }
  }

  return violations;
}

export interface ProjectEnvLoadOptions {
  rootDir?: string;
  envPath?: string;
  mode?: string;
}

/**
 * Production Vite env dosyalarındaki proje anahtarlarını Vite'ın kendi loadEnv
 * öncelik ve dotenv-expand semantiğiyle çözümler. Makinenin ilgisiz ortam
 * değişkenleri, yalnız env dosyalarında adı geçen anahtarlar seçilerek dışarıda bırakılır.
 */
export function loadProjectEnvSecrets(
  options?: ProjectEnvLoadOptions,
): Array<readonly [string, string]> {
  const effectiveRootDir = options?.rootDir || rootDir;
  const envDir = options?.envPath ? dirname(options.envPath) : effectiveRootDir;
  const mode = options?.mode || 'production';
  const envFiles = [
    join(envDir, '.env'),
    join(envDir, '.env.local'),
    join(envDir, `.env.${mode}`),
    join(envDir, `.env.${mode}.local`),
  ];
  const projectKeys = new Set<string>();

  for (const envFile of envFiles) {
    if (!existsSync(envFile)) continue;
    const parsedNames = parseEnv(readFileSync(envFile, 'utf-8'));
    for (const key of Object.keys(parsedNames)) {
      projectKeys.add(key);
    }
  }

  const effectiveValues = loadEnv(mode, envDir, '');
  const secrets: Array<readonly [string, string]> = [];
  for (const key of projectKeys) {
    if (key.startsWith('VITE_')) continue;
    const value = effectiveValues[key];
    if (value) secrets.push([key, value] as const);
  }
  return secrets;
}

/**
 * JS ve JSON kaçış karakterlerini (unicode, hex, kaçış dizilimleri) çözümler.
 */
export function decodeJsStringEscapes(str: string): string {
  let decoded = str;
  for (let depth = 0; depth < 8; depth += 1) {
    const next = decoded
      .replace(/\\\\/g, '\\')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

/**
 * 2. İstemci Demeti Gizli Bilgi Sızıntı Denetimi (Client Bundle Secret Leak Check)
 *
 * SÖZLEŞME VE KONTROLLER:
 * - Vite ve dotenv uyumlu ayrıştırma yapılır; 1-3 karakterlik sırlar atlanmaz.
 * - Ham metin, JSON kodlu ve çözümlenmiş JS dizge temsilleri taranır.
 * - Doğrulama güvensiz ise sadece değişken adı ile fail-safe başarısızlık verilir.
 * - Gizli değerler hiçbir zaman konsola veya rapor çıktısına yazdırılmaz.
 */
export function checkClientBundleForSecrets(options?: BundleCheckOptions): BundleCheckResult {
  const effectiveRootDir = options?.rootDir || rootDir;
  const distClientDir = options?.distDir || join(effectiveRootDir, 'dist', 'client');
  const violations: SecretLeakViolation[] = [];

  if (!existsSync(distClientDir)) {
    return {
      checked: false,
      violations: [],
      message:
        'dist/client dizini henüz derlenmemiş; demet taraması derleme sonrasında çalıştırılmalıdır.',
    };
  }

  const bundleFiles = getAllFiles(distClientDir);
  const secretsToScan: Array<{ name: string; value: string }> = [];

  try {
    const projectSecrets = loadProjectEnvSecrets({
      rootDir: effectiveRootDir,
      envPath: options?.envPath,
      mode: options?.mode || 'production',
    });
    secretsToScan.push(...projectSecrets.map(([name, value]) => ({ name, value })));
  } catch {
    violations.push({
      file: '.env*',
      variableName: 'ENV_LOAD_FAILURE',
      reason: 'SECRET SCAN FAILED: UNSAFE (ENV_LOAD_FAILURE)',
    });
  }

  secretsToScan.push(
    { name: 'SYNTHETIC_SECRET_MARKER', value: SYNTHETIC_SECRET_MARKER },
    { name: 'CF_ACCESS_SECURE_AUDIENCE', value: 'CF_ACCESS_SECURE_AUDIENCE' },
  );

  const uniqueSecrets = [...new Map(secretsToScan.map((secret) => [secret.name, secret])).values()];
  const verifiableSecrets: Array<{ name: string; value: string }> = [];
  for (const secret of uniqueSecrets) {
    if (secret.value.length < 4) {
      violations.push({
        file: '.env*',
        variableName: secret.name,
        reason: `SECRET VALUE TOO SHORT FOR SAFE VERIFICATION: ${secret.name}`,
      });
    } else {
      verifiableSecrets.push(secret);
    }
  }

  for (const file of bundleFiles) {
    let rawContent: string;
    let decodedContent: string;

    try {
      rawContent = readFileSync(file, 'utf-8');
      decodedContent = decodeJsStringEscapes(rawContent);
    } catch {
      violations.push({
        file: relative(effectiveRootDir, file).replace(/\\/g, '/'),
        variableName: 'FILE_READ_ERROR',
        reason: 'SECRET SCAN FAILED: UNSAFE (FILE_READ_ERROR)',
      });
      continue;
    }

    for (const secret of verifiableSecrets) {
      try {
        const rawSecret = secret.value;
        let jsonEscaped = '';
        try {
          const stringified = JSON.stringify(rawSecret);
          jsonEscaped = stringified.slice(1, -1);
        } catch {
          // ignore stringify error
        }

        const hasLeak =
          rawContent.includes(rawSecret) ||
          (jsonEscaped.length > 0 && rawContent.includes(jsonEscaped)) ||
          decodedContent.includes(rawSecret) ||
          (jsonEscaped.length > 0 && decodedContent.includes(jsonEscaped));

        if (hasLeak) {
          violations.push({
            file: relative(effectiveRootDir, file).replace(/\\/g, '/'),
            variableName: secret.name,
            reason: `SECRET LEAK: FOUND (${secret.name})`,
          });
        }
      } catch {
        // Doğrulama güvensiz veya hata oluştuğunda sadece değişken adı ile güvenli başarısızlık (fail-safe)
        violations.push({
          file: relative(effectiveRootDir, file).replace(/\\/g, '/'),
          variableName: secret.name,
          reason: `SECRET SCAN FAILED: UNSAFE (${secret.name})`,
        });
      }
    }
  }

  return {
    checked: true,
    violations,
  };
}

/**
 * Ana doğrulama yürütücüsü.
 */
export function runVerification(): void {
  console.info('[Güvenlik Sınırı Denetimi] Başlatılıyor...');

  // 1. Kaynak modül sınırlarını denetle
  const boundaryViolations = [
    ...checkSourceBoundaries(),
    ...checkProtectedMutationExecutorBoundaries(),
    ...checkDomainMutationExecutorBoundaries(),
  ];
  if (boundaryViolations.length > 0) {
    console.error('HATA: Mimari kaynak sınırı ihlali tespit edildi:');
    for (const v of boundaryViolations) {
      console.error(`  -> Dosya: ${v.file} | İthalat/Neden: ${v.importPath} | ${v.reason ?? ''}`);
    }
    process.exit(1);
  }

  console.info(
    '✓ Kaynak modül sınırları doğrulandı: src/app ve src/shared içinde sunucu ithalatı yok.',
  );

  // 2. İstemci demetini denetle (eğer derlendiyse)
  const bundleCheck = checkClientBundleForSecrets();
  if (bundleCheck.checked) {
    if (bundleCheck.violations.length > 0) {
      console.error('HATA: İstemci demetine gizli bilgi sızdı!');
      for (const v of bundleCheck.violations) {
        console.error(`  -> Dosya: ${v.file} | SECRET LEAK: FOUND: ${v.variableName}`);
      }
      process.exit(1);
    }
    console.info(
      '✓ İstemci demetinde sentetik gizli anahtar veya sunucu konfigürasyonu sızıntısı bulunmadı.',
    );
  } else {
    console.info(`ℹ ${bundleCheck.message}`);
  }

  console.info('[Güvenlik Sınırı Denetimi] Başarıyla tamamlandı.');
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  (normalizePathForComparison(process.argv[1] ?? '') ===
    normalizePathForComparison(fileURLToPath(import.meta.url)) ||
    (process.argv[1] ?? '').endsWith('verify-boundaries.ts'));

if (isDirectRun) {
  runVerification();
}
