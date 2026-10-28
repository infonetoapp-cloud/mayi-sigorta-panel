// DORMANT F-27 historical Access unit evidence; never a Worker runtime dependency.
/**
 * Cloudflare Access Sunucu Yapılandırması (M1-T05).
 *
 * KRİTİK GÜVENLİK SÖZLEŞMESİ:
 * - Doğrulama yapılandırmasında güvensiz varsayılan (fallback default) DEĞERLER KESİNLİKLE KULLANILAMAZ.
 * - Eksik, boş veya bozuk yapılandırmalar fail-closed olarak doğrudan hata üretir.
 * - Issuer, cloudflareaccess.com üzerinde meşru bir takım alt alan adına sahip
 *   kanonik HTTPS origin olmalıdır.
 * - Normal ve secure audience değerleri zorunludur ve birbirinden farklı (distinct) olmalıdır.
 * - Boşlukla sarılmış (whitespace-padded) alanlar sessizce normalize edilmez; fail-closed reddedilir.
 * - Hem CF_ACCESS_ISSUER hem CF_ACCESS_TEAM_DOMAIN sağlandığında uyuşmazlık reddedilir.
 */

export interface AccessConfig {
  readonly issuer: string;
  readonly teamDomain: string;
  readonly normalAudience: string;
  readonly secureAudience: string;
  readonly jwksUrl: string;
}

export class AccessConfigError extends Error {
  readonly code: string = 'CONFIGURATION_ERROR';

  constructor(message: string) {
    super(`[Cloudflare Access Yapılandırma Hatası] ${message}`);
    this.name = 'AccessConfigError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// RFC 1123 uyumlu takım alt alan adı: tire ile başlayamaz veya bitemez
const CLOUDFLARE_ACCESS_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/;

function parseAndValidateTeamHost(
  input: unknown,
  fieldName: 'CF_ACCESS_TEAM_DOMAIN' | 'CF_ACCESS_ISSUER',
): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input !== 'string' || input.trim() === '') {
    return undefined;
  }

  if (input.startsWith('http://')) {
    throw new AccessConfigError(`${fieldName} protokolü HTTPS olmalıdır; 'http:' kabul edilemez.`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = input.startsWith('https://') ? new URL(input) : new URL(`https://${input}`);
  } catch {
    throw new AccessConfigError(`Geçersiz ${fieldName} biçimi: '${input}'`);
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new AccessConfigError(
      `${fieldName} protokolü HTTPS olmalıdır; '${parsedUrl.protocol}' kabul edilemez.`,
    );
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new AccessConfigError(
      `${fieldName} adresi kullanıcı adı veya parola (credentials) içeremez.`,
    );
  }

  if (parsedUrl.port && parsedUrl.port !== '443') {
    throw new AccessConfigError(`Standart dışı HTTPS portu kabul edilemez: '${parsedUrl.port}'`);
  }

  if (parsedUrl.search) {
    throw new AccessConfigError(`${fieldName} adresi sorgu dizesi (?query) içeremez.`);
  }

  if (parsedUrl.hash) {
    throw new AccessConfigError(`${fieldName} adresi parça (#fragment) içeremez.`);
  }

  if (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '') {
    throw new AccessConfigError(
      `${fieldName} kök harici bir yol içeremez: '${parsedUrl.pathname}'`,
    );
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (!CLOUDFLARE_ACCESS_HOST_PATTERN.test(host)) {
    throw new AccessConfigError(
      `${fieldName} etki alanı geçerli bir Cloudflare Access takım hostu olmalıdır (*.cloudflareaccess.com): '${host}'`,
    );
  }

  return host;
}

export function parseAccessConfig(env: Record<string, unknown> = {}): AccessConfig {
  const rawTeamDomain = env.CF_ACCESS_TEAM_DOMAIN as unknown;
  const rawIssuer = env.CF_ACCESS_ISSUER as unknown;
  const rawNormalAudience = env.CF_ACCESS_AUDIENCE as unknown;
  const rawSecureAudience = env.CF_ACCESS_SECURE_AUDIENCE as unknown;

  // 1. Boşlukla sarılmış (whitespace-padded) girdi kontrolü
  if (typeof rawNormalAudience === 'string' && rawNormalAudience !== rawNormalAudience.trim()) {
    throw new AccessConfigError('CF_ACCESS_AUDIENCE başında veya sonunda boşluk içeremez.');
  }
  if (typeof rawSecureAudience === 'string' && rawSecureAudience !== rawSecureAudience.trim()) {
    throw new AccessConfigError('CF_ACCESS_SECURE_AUDIENCE başında veya sonunda boşluk içeremez.');
  }
  if (typeof rawTeamDomain === 'string' && rawTeamDomain !== rawTeamDomain.trim()) {
    throw new AccessConfigError('CF_ACCESS_TEAM_DOMAIN başında veya sonunda boşluk içeremez.');
  }
  if (typeof rawIssuer === 'string' && rawIssuer !== rawIssuer.trim()) {
    throw new AccessConfigError('CF_ACCESS_ISSUER başında veya sonunda boşluk içeremez.');
  }

  // 2. CF_ACCESS_TEAM_DOMAIN ve CF_ACCESS_ISSUER değerlerinin ayrı ayrı ve bireysel olarak tam doğrulanması
  const teamHost = parseAndValidateTeamHost(rawTeamDomain, 'CF_ACCESS_TEAM_DOMAIN');
  const issuerHost = parseAndValidateTeamHost(rawIssuer, 'CF_ACCESS_ISSUER');

  if (!teamHost && !issuerHost) {
    throw new AccessConfigError(
      'CF_ACCESS_TEAM_DOMAIN veya CF_ACCESS_ISSUER tanımlı ve boş olmamalıdır.',
    );
  }

  // İkisi birden verilmişse aynı canonical hostname'e sahip oldukları doğrulanır
  if (teamHost && issuerHost && teamHost !== issuerHost) {
    throw new AccessConfigError(
      `CF_ACCESS_ISSUER ('${issuerHost}') ve CF_ACCESS_TEAM_DOMAIN ('${teamHost}') uyuşmuyor.`,
    );
  }

  const host = (issuerHost ?? teamHost)!;

  // 3. Audience doğrulamaları
  if (typeof rawNormalAudience !== 'string' || rawNormalAudience.trim() === '') {
    throw new AccessConfigError('CF_ACCESS_AUDIENCE tanımlı ve boş olmamalıdır.');
  }

  if (typeof rawSecureAudience !== 'string' || rawSecureAudience.trim() === '') {
    throw new AccessConfigError('CF_ACCESS_SECURE_AUDIENCE tanımlı ve boş olmamalıdır.');
  }

  const normalAudience = rawNormalAudience;
  const secureAudience = rawSecureAudience;

  if (normalAudience === secureAudience) {
    throw new AccessConfigError(
      'Normal ve secure audience değerleri birbirinden farklı (distinct) olmalıdır.',
    );
  }

  const canonicalIssuer = `https://${host}`;
  const jwksUrl = `${canonicalIssuer}/cdn-cgi/access/certs`;

  return Object.freeze({
    issuer: canonicalIssuer,
    teamDomain: host,
    normalAudience,
    secureAudience,
    jwksUrl,
  });
}

/**
 * Üretim çözücü sınırında (resolver boundary) yapılandırmanın güvenilir ve
 * tahrif edilmemiş olduğunu teyit eder.
 */
export function assertTrustedAccessConfig(config: AccessConfig): void {
  if (!config || typeof config !== 'object') {
    throw new AccessConfigError('Yapılandırma nesnesi geçersiz.');
  }

  if (typeof config.issuer !== 'string' || typeof config.teamDomain !== 'string') {
    throw new AccessConfigError('Issuer veya teamDomain geçersiz.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(config.issuer);
  } catch {
    throw new AccessConfigError('Geçersiz issuer URL biçimi.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new AccessConfigError('Issuer HTTPS olmalıdır.');
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new AccessConfigError('Issuer adresi kullanıcı adı veya parola (credentials) içeremez.');
  }

  if (parsedUrl.port && parsedUrl.port !== '443') {
    throw new AccessConfigError(`Standart dışı HTTPS portu kabul edilemez: '${parsedUrl.port}'`);
  }

  if (parsedUrl.search) {
    throw new AccessConfigError('Issuer adresi sorgu dizesi (?query) içeremez.');
  }

  if (parsedUrl.hash) {
    throw new AccessConfigError('Issuer adresi parça (#fragment) içeremez.');
  }

  if (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '') {
    throw new AccessConfigError(`Issuer kök harici bir yol içeremez: '${parsedUrl.pathname}'`);
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (!CLOUDFLARE_ACCESS_HOST_PATTERN.test(host)) {
    throw new AccessConfigError(`Issuer geçerli bir Cloudflare Access hostu olmalıdır: '${host}'`);
  }

  const canonicalIssuer = `https://${host}`;
  if (config.issuer !== canonicalIssuer) {
    throw new AccessConfigError(
      `Issuer kanonik 'https://${host}' biçiminde olmalıdır; '${config.issuer}' bulundu.`,
    );
  }

  if (config.teamDomain !== host) {
    throw new AccessConfigError(
      `teamDomain kanonik host '${host}' ile tam eşleşmelidir; '${config.teamDomain}' bulundu.`,
    );
  }

  const expectedJwksUrl = `${canonicalIssuer}/cdn-cgi/access/certs`;
  if (config.jwksUrl !== expectedJwksUrl) {
    throw new AccessConfigError(
      `Güvensiz veya sahte jwksUrl tespit edildi; '${expectedJwksUrl}' beklenirken '${config.jwksUrl}' bulundu.`,
    );
  }

  if (
    typeof config.normalAudience !== 'string' ||
    config.normalAudience.trim() === '' ||
    config.normalAudience !== config.normalAudience.trim()
  ) {
    throw new AccessConfigError('Normal audience geçersiz veya boşluk içeriyor.');
  }

  if (
    typeof config.secureAudience !== 'string' ||
    config.secureAudience.trim() === '' ||
    config.secureAudience !== config.secureAudience.trim()
  ) {
    throw new AccessConfigError('Secure audience geçersiz veya boşluk içeriyor.');
  }

  if (config.normalAudience === config.secureAudience) {
    throw new AccessConfigError('Normal ve secure audience birbirinden farklı olmalıdır.');
  }
}
