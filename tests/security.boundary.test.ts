import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, createWorker } from '../src/server/index';
import { parseServerConfig } from '../src/server/config';
import {
  validateRequestOrigin,
  parseAndValidateTrustedOrigin,
  SecurityConfigurationError,
  validateFetchMetadata,
  generateIdentityBoundCsrfToken,
  verifyIdentityBoundCsrfToken,
  verifyCsrfMutationGuard,
  createAuthenticatedCsrfGuard,
  CSRF_HEADER_NAME,
  getSecurityHeaders,
  applySecurityHeaders,
} from '../src/server/security/index';
import type { AccessConfig } from '../src/server/auth/config';
import type { AccessVerifier } from '../src/server/auth/verifier';
import type {
  ApplicationIdentityResolver,
  AuthenticatedUserContext,
} from '../src/server/auth/identity';
import type { ApiResponse, ApiErrorEnvelope, UserMeDto } from '../src/shared/types';

describe('M1-T08 Request Security Boundary & Headers', () => {
  const TRUSTED_ORIGIN = 'https://panel.mayisigorta.com';
  const AUTHENTICATED_SUBJECT = 'usr-01HXYZ1234567890ABCDEF';
  const TEST_SECRET = 'synthetic-secret-key-for-csrf-tests-at-least-32-chars';

  describe('1. Exact Trusted Origin Validation & Fail-Closed Configuration', () => {
    it('güvenilen exact origin değerini kabul etmelidir', () => {
      const req = new Request(`${TRUSTED_ORIGIN}/api/test`, {
        method: 'POST',
        headers: { Origin: TRUSTED_ORIGIN },
      });
      const result = validateRequestOrigin(req, TRUSTED_ORIGIN);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.origin).toBe(TRUSTED_ORIGIN);
      }
    });

    it('Origin eksik olduğunda fail-closed reddetmelidir', () => {
      const req = new Request(`${TRUSTED_ORIGIN}/api/test`, {
        method: 'POST',
      });
      const result = validateRequestOrigin(req, TRUSTED_ORIGIN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('MISSING_ORIGIN');
      }
    });

    it.each([
      ['suffix lookalike', `${TRUSTED_ORIGIN}.attacker.com`],
      ['prefix lookalike', 'https://attacker-panel.mayisigorta.com'],
      ['same-site apex PHP domain', 'https://mayisigorta.com'],
      ['insecure http protocol', 'http://panel.mayisigorta.com'],
      ['null origin', 'null'],
      ['untrusted non-default port', 'https://panel.mayisigorta.com:8443'],
      ['arbitrary untrusted origin', 'https://evil.com'],
    ])('düşmanca veya benzer origin %s (%s) reddedilmelidir', (_name, hostileOrigin) => {
      const req = new Request(`${TRUSTED_ORIGIN}/api/test`, {
        method: 'POST',
        headers: { Origin: hostileOrigin },
      });
      const result = validateRequestOrigin(req, TRUSTED_ORIGIN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('UNTRUSTED_ORIGIN');
      }
    });

    it.each([
      ['path içeren origin', `${TRUSTED_ORIGIN}/foo`],
      ['query içeren origin', `${TRUSTED_ORIGIN}?foo=bar`],
      ['credentials içeren origin', 'https://user:pass@panel.mayisigorta.com'],
      ['javascript URI', 'javascript:alert(1)'],
      ['boşluklu origin', ` ${TRUSTED_ORIGIN} `],
      ['CRLF enjeksiyonlu origin', `${TRUSTED_ORIGIN}\r\nX-Injected: true`],
      ['geçersiz url', 'not a valid url'],
    ])('bozuk veya standart dışı origin %s (%s) reddedilmelidir', (_name, malformedOrigin) => {
      const result = validateRequestOrigin(malformedOrigin, TRUSTED_ORIGIN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(['MALFORMED_ORIGIN', 'UNTRUSTED_ORIGIN']).toContain(result.code);
      }
    });

    it('Host başlığından güven asla türetilmemelidir (Host spoofing koruması)', () => {
      // Saldırgan Host başlığını panel.mayisigorta.com olarak gönderse bile Origin evil.com ise reddedilmeli
      const req = new Request('https://attacker.com/api/test', {
        method: 'POST',
        headers: {
          Host: 'panel.mayisigorta.com',
          'X-Forwarded-Host': 'panel.mayisigorta.com',
          Origin: 'https://evil.com',
        },
      });
      const result = validateRequestOrigin(req, TRUSTED_ORIGIN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('UNTRUSTED_ORIGIN');
      }
    });

    it('bozuk trustedOrigin yapılandırmasında sessizce varsayılana düşmemeli, fail-closed hata fırlatmalıdır', () => {
      const req = new Request(`${TRUSTED_ORIGIN}/api/test`, {
        method: 'POST',
        headers: { Origin: TRUSTED_ORIGIN },
      });

      expect(() => validateRequestOrigin(req, 'http://insecure.com')).toThrow(
        SecurityConfigurationError,
      );
      expect(() => validateRequestOrigin(req, 'not-a-valid-url')).toThrow(
        SecurityConfigurationError,
      );
      expect(() => validateRequestOrigin(req, `${TRUSTED_ORIGIN}/with-path`)).toThrow(
        SecurityConfigurationError,
      );
      expect(() => validateRequestOrigin(req, `${TRUSTED_ORIGIN}?with-query=true`)).toThrow(
        SecurityConfigurationError,
      );
      expect(() => validateRequestOrigin(req, 'https://user:pass@panel.mayisigorta.com')).toThrow(
        SecurityConfigurationError,
      );
      expect(() => parseAndValidateTrustedOrigin('https://panel.mayisigorta.com/')).toThrow(
        SecurityConfigurationError,
      );
    });

    it('parseServerConfig PANEL_ORIGIN değerini kanonik HTTPS origin olarak doğrulamalıdır', () => {
      const validConfig = parseServerConfig({
        PANEL_ORIGIN: 'https://panel.mayisigorta.com',
      });
      expect(validConfig.PANEL_ORIGIN).toBe('https://panel.mayisigorta.com');

      expect(() =>
        parseServerConfig({
          PANEL_ORIGIN: 'http://insecure.mayisigorta.com',
        }),
      ).toThrow();

      expect(() =>
        parseServerConfig({
          PANEL_ORIGIN: 'https://panel.mayisigorta.com/path',
        }),
      ).toThrow();

      expect(() =>
        parseServerConfig({
          PANEL_ORIGIN: 'https://user:pass@panel.mayisigorta.com',
        }),
      ).toThrow();
    });
  });

  describe('2. Sec-Fetch-* Additive Signals', () => {
    it('Sec-Fetch-Site cross-site olduğunda istek reddedilmelidir', () => {
      const req = new Request(`${TRUSTED_ORIGIN}/api/test`, {
        method: 'POST',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'Sec-Fetch-Site': 'cross-site',
        },
      });
      const result = validateFetchMetadata(req);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('CROSS_SITE_FETCH_BLOCKED');
      }
    });

    it('Sec-Fetch-Mode no-cors olan mutasyon reddedilmelidir', () => {
      const req = new Request(`${TRUSTED_ORIGIN}/api/test`, {
        method: 'POST',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'Sec-Fetch-Mode': 'no-cors',
        },
      });
      const result = validateFetchMetadata(req);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('INVALID_FETCH_MODE');
      }
    });

    it('Sec-Fetch-Mode navigate olan mutasyon reddedilmelidir', () => {
      const req = new Request(`${TRUSTED_ORIGIN}/api/test`, {
        method: 'POST',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'Sec-Fetch-Mode': 'navigate',
        },
      });
      const result = validateFetchMetadata(req);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('INVALID_FETCH_MODE');
      }
    });

    it('Sec-Fetch başlıkları bulunmadığında (eski istemci/sentetik test) geçerli sayılmalıdır', () => {
      const req = new Request(`${TRUSTED_ORIGIN}/api/test`, {
        method: 'POST',
        headers: { Origin: TRUSTED_ORIGIN },
      });
      const result = validateFetchMetadata(req);
      expect(result.valid).toBe(true);
    });

    it('Sec-Fetch-Site same-origin ve cors modu geçerli sayılmalıdır', () => {
      const req = new Request(`${TRUSTED_ORIGIN}/api/test`, {
        method: 'POST',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
        },
      });
      const result = validateFetchMetadata(req);
      expect(result.valid).toBe(true);
    });
  });

  describe('3. Signed Short-Lived Identity-Bound CSRF Token & Guard', () => {
    it('geçerli kimliğe bağlı CSRF token üretmeli ve doğrulamalıdır', async () => {
      const token = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT },
        TEST_SECRET,
      );
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(32);

      const verification = await verifyIdentityBoundCsrfToken(
        token,
        AUTHENTICATED_SUBJECT,
        TEST_SECRET,
      );
      expect(verification.valid).toBe(true);
      if (verification.valid) {
        expect(verification.subject).toBe(AUTHENTICATED_SUBJECT);
      }
    });

    it('yalnız canonical unpadded Base64URL token parçalarını kabul etmelidir', async () => {
      const token = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT },
        TEST_SECRET,
      );
      const [payload, signature] = token.split('.') as [string, string];
      const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const canonicalLastIndex = base64UrlAlphabet.indexOf(signature.at(-1)!);
      const equivalentNonCanonicalSignature = `${signature.slice(0, -1)}${base64UrlAlphabet[canonicalLastIndex + 1]}`;

      await expect(
        verifyIdentityBoundCsrfToken(token, AUTHENTICATED_SUBJECT, TEST_SECRET),
      ).resolves.toMatchObject({ valid: true });

      const malformedTokens = [
        `${payload}.${signature}=`,
        `${payload}=.${signature}`,
        `${payload}.${signature.slice(0, -1)}+`,
        `${payload}.${signature.slice(0, -1)}/`,
        `${payload}.${signature} `,
        `${payload}.${signature.slice(0, -1)}*`,
        `${payload}.${signature.slice(0, -2)}`,
        `${payload}.${equivalentNonCanonicalSignature}`,
        `${payload}A.${signature}`,
      ];

      for (const malformedToken of malformedTokens) {
        const verification = await verifyIdentityBoundCsrfToken(
          malformedToken,
          AUTHENTICATED_SUBJECT,
          TEST_SECRET,
        );
        expect(verification.valid, malformedToken).toBe(false);
      }
    });

    it('farklı/uyuşmayan kimlik subject değeri için reddetmelidir', async () => {
      const token = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT },
        TEST_SECRET,
      );
      const verification = await verifyIdentityBoundCsrfToken(
        token,
        'attacker_subject',
        TEST_SECRET,
      );
      expect(verification.valid).toBe(false);
      if (!verification.valid) {
        expect(verification.code).toBe('SUBJECT_MISMATCH');
      }
    });

    it('tahrif edilmiş (tampered) token reddedilmelidir', async () => {
      const token = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT },
        TEST_SECRET,
      );
      const tampered = token.slice(0, -5) + 'XXXXX';
      const verification = await verifyIdentityBoundCsrfToken(
        tampered,
        AUTHENTICATED_SUBJECT,
        TEST_SECRET,
      );
      expect(verification.valid).toBe(false);
      if (!verification.valid) {
        expect(verification.code).toBe('INVALID_SIGNATURE');
      }
    });

    it('süresi dolmuş (expired) token reddedilmelidir', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT, issuedAt: now - 20, ttlSeconds: 10 },
        TEST_SECRET,
      );
      const verification = await verifyIdentityBoundCsrfToken(
        token,
        AUTHENTICATED_SUBJECT,
        TEST_SECRET,
      );
      expect(verification.valid).toBe(false);
      if (!verification.valid) {
        expect(verification.code).toBe('EXPIRED_TOKEN');
      }
    });

    it('gelecekte üretilmiş veya azami ömrü aşan CSRF tokenlarını fail-closed reddetmelidir', async () => {
      const now = Math.floor(Date.now() / 1000);
      const futureToken = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT, issuedAt: now + 300, ttlSeconds: 60 },
        TEST_SECRET,
      );
      const futureVerification = await verifyIdentityBoundCsrfToken(
        futureToken,
        AUTHENTICATED_SUBJECT,
        TEST_SECRET,
      );
      expect(futureVerification.valid).toBe(false);

      await expect(
        generateIdentityBoundCsrfToken(
          { subject: AUTHENTICATED_SUBJECT, ttlSeconds: 901 },
          TEST_SECRET,
        ),
      ).rejects.toThrow();
      await expect(
        generateIdentityBoundCsrfToken(
          { subject: AUTHENTICATED_SUBJECT, ttlSeconds: 0 },
          TEST_SECRET,
        ),
      ).rejects.toThrow();
    });

    it('bozuk veya geçersiz biçimli token fail-closed reddedilmelidir', async () => {
      const verification = await verifyIdentityBoundCsrfToken(
        'not.a.valid.token',
        AUTHENTICATED_SUBJECT,
        TEST_SECRET,
      );
      expect(verification.valid).toBe(false);
      if (!verification.valid) {
        expect(['MALFORMED_TOKEN', 'INVALID_SIGNATURE']).toContain(verification.code);
      }
    });

    it('verifyCsrfMutationGuard sunucu kimlikli ve özel başlıklı mutasyon doğrulaması yapmalıdır', async () => {
      const validToken = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT },
        TEST_SECRET,
      );

      // Başarılı durum: başlık mevcut, imza geçerli, subject eşleşiyor
      const validReq = new Request(`${TRUSTED_ORIGIN}/api/mutation`, {
        method: 'POST',
        headers: {
          [CSRF_HEADER_NAME]: validToken,
        },
      });
      const validRes = await verifyCsrfMutationGuard(validReq, {
        authenticatedSubject: AUTHENTICATED_SUBJECT,
        secret: TEST_SECRET,
      });
      expect(validRes.allowed).toBe(true);
      if (validRes.allowed) {
        expect(validRes.subject).toBe(AUTHENTICATED_SUBJECT);
      }

      // Eksik başlık
      const missingReq = new Request(`${TRUSTED_ORIGIN}/api/mutation`, {
        method: 'POST',
      });
      const missingRes = await verifyCsrfMutationGuard(missingReq, {
        authenticatedSubject: AUTHENTICATED_SUBJECT,
        secret: TEST_SECRET,
      });
      expect(missingRes.allowed).toBe(false);
      if (!missingRes.allowed) {
        expect(missingRes.code).toBe('MISSING_CSRF_TOKEN');
      }

      // Tahrif edilmiş başlık
      const tamperedReq = new Request(`${TRUSTED_ORIGIN}/api/mutation`, {
        method: 'POST',
        headers: {
          [CSRF_HEADER_NAME]: validToken.slice(0, -5) + 'YYYYY',
        },
      });
      const tamperedRes = await verifyCsrfMutationGuard(tamperedReq, {
        authenticatedSubject: AUTHENTICATED_SUBJECT,
        secret: TEST_SECRET,
      });
      expect(tamperedRes.allowed).toBe(false);
      if (!tamperedRes.allowed) {
        expect(tamperedRes.code).toBe('INVALID_SIGNATURE');
      }

      // Uyuşmayan kimlik (farklı kullanıcıya verilmiş belirteç)
      const wrongSubjectReq = new Request(`${TRUSTED_ORIGIN}/api/mutation`, {
        method: 'POST',
        headers: {
          [CSRF_HEADER_NAME]: validToken,
        },
      });
      const wrongSubjectRes = await verifyCsrfMutationGuard(wrongSubjectReq, {
        authenticatedSubject: 'different_user_subject',
        secret: TEST_SECRET,
      });
      expect(wrongSubjectRes.allowed).toBe(false);
      if (!wrongSubjectRes.allowed) {
        expect(wrongSubjectRes.code).toBe('SUBJECT_MISMATCH');
      }

      // Sunucu tarafından geçerli bir subject sağlanmazsa fail-closed ret
      const emptySubjectRes = await verifyCsrfMutationGuard(validReq, {
        authenticatedSubject: '',
        secret: TEST_SECRET,
      });
      expect(emptySubjectRes.allowed).toBe(false);
      if (!emptySubjectRes.allowed) {
        expect(emptySubjectRes.code).toBe('SUBJECT_MISMATCH');
      }
    });
  });

  describe('4. Security Headers & Caching Posture', () => {
    it('gerekli tüm güvenlik başlıklarını doğru direktiflerle üretmelidir', () => {
      const headers = getSecurityHeaders({
        appEnv: 'development',
        isHttps: false,
        isApi: true,
      });

      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['Referrer-Policy']).toBe('no-referrer');
      expect(headers['Permissions-Policy']).toContain('camera=()');
      expect(headers['Permissions-Policy']).toContain('microphone=()');
      expect(headers['Permissions-Policy']).toContain('geolocation=()');
      expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
      expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
      expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
      expect(headers['Content-Security-Policy']).toContain("base-uri 'none'");
      // Development ortamında HSTS olmamalıdır
      expect(headers['Strict-Transport-Security']).toBeUndefined();
      // API yanıtlarında no-store olmalıdır
      expect(headers['Cache-Control']).toContain('no-store');
      expect(headers['Pragma']).toBe('no-cache');
    });

    it('yalnızca production ve HTTPS durumunda HSTS başlığı eklenmelidir', () => {
      const prodHttpsHeaders = getSecurityHeaders({
        appEnv: 'production',
        isHttps: true,
        isApi: false,
      });
      expect(prodHttpsHeaders['Strict-Transport-Security']).toBeDefined();
      expect(prodHttpsHeaders['Strict-Transport-Security']).toContain('max-age=86400');
      expect(prodHttpsHeaders['Strict-Transport-Security']).not.toContain('includeSubDomains');
      expect(prodHttpsHeaders['Strict-Transport-Security']).not.toContain('preload');

      const prodHttpHeaders = getSecurityHeaders({
        appEnv: 'production',
        isHttps: false,
        isApi: false,
      });
      expect(prodHttpHeaders['Strict-Transport-Security']).toBeUndefined();

      const devHttpsHeaders = getSecurityHeaders({
        appEnv: 'development',
        isHttps: true,
        isApi: false,
      });
      expect(devHttpsHeaders['Strict-Transport-Security']).toBeUndefined();
    });

    it('mevcut yanıta güvenlik başlıklarını koruyarak eklemelidir', () => {
      const baseResponse = Response.json({ hello: 'world' }, { status: 200 });
      const secured = applySecurityHeaders(baseResponse, {
        appEnv: 'production',
        isHttps: true,
        isApi: true,
      });

      expect(secured.headers.get('x-content-type-options')).toBe('nosniff');
      expect(secured.headers.get('x-frame-options')).toBe('DENY');
      expect(secured.headers.get('cache-control')).toContain('no-store');
      expect(secured.headers.get('strict-transport-security')).toContain('max-age=86400');
    });
  });

  describe('5. App-Level Request Security Boundary & Integrated Mutation Protection', () => {
    let appWithMutation: ReturnType<typeof createApp>;

    beforeEach(() => {
      appWithMutation = createApp({}, (subApp) => {
        // T05/T06 sonrası doğrulanmış kimliğe karşı çalışan reusable CSRF mutation guard
        const csrfGuard = createAuthenticatedCsrfGuard(() => ({
          authenticatedSubject: AUTHENTICATED_SUBJECT,
          secret: TEST_SECRET,
        }));

        subApp.post('/api/test-mutation', csrfGuard, (c) => {
          return c.json({ success: true, message: 'mutated' }, 200);
        });
        subApp.put('/api/test-mutation', csrfGuard, (c) => {
          return c.json({ success: true, message: 'mutated' }, 200);
        });
        subApp.patch('/api/test-mutation', csrfGuard, (c) => {
          return c.json({ success: true, message: 'mutated' }, 200);
        });
        subApp.delete('/api/test-mutation', csrfGuard, (c) => {
          return c.json({ success: true, message: 'mutated' }, 200);
        });
      });
    });

    it('geçerli exact origin VE geçerli identity-bound CSRF token taşıyan mutasyonlar 200 ile başarılı olmalıdır', async () => {
      const validToken = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT },
        TEST_SECRET,
      );

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await appWithMutation.request('/api/test-mutation', {
          method,
          headers: {
            Origin: TRUSTED_ORIGIN,
            [CSRF_HEADER_NAME]: validToken,
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'cors',
          },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('cache-control')).toContain('no-store');
      }
    });

    it('X-CSRF-Token başlığı eksik olduğunda mutasyon 403 ile fail-closed reddedilmelidir', async () => {
      const res = await appWithMutation.request('/api/test-mutation', {
        method: 'POST',
        headers: {
          Origin: TRUSTED_ORIGIN,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
        },
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as ApiErrorEnvelope;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
      expect(json.error.message).toContain('X-CSRF-Token');
    });

    it('tahrif edilmiş X-CSRF-Token başlığı ile yapılan mutasyon 403 ile reddedilmelidir', async () => {
      const validToken = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT },
        TEST_SECRET,
      );
      const tampered = validToken.slice(0, -6) + 'ZZZZZZ';

      const res = await appWithMutation.request('/api/test-mutation', {
        method: 'POST',
        headers: {
          Origin: TRUSTED_ORIGIN,
          [CSRF_HEADER_NAME]: tampered,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
        },
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as ApiErrorEnvelope;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('başka bir kullanıcıya ait (subject mismatch) CSRF token ile yapılan mutasyon 403 ile reddedilmelidir', async () => {
      const foreignToken = await generateIdentityBoundCsrfToken(
        { subject: 'another-user-uuid-999' },
        TEST_SECRET,
      );

      const res = await appWithMutation.request('/api/test-mutation', {
        method: 'POST',
        headers: {
          Origin: TRUSTED_ORIGIN,
          [CSRF_HEADER_NAME]: foreignToken,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
        },
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as ApiErrorEnvelope;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('süresi dolmuş CSRF token ile yapılan mutasyon 403 ile reddedilmelidir', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiredToken = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT, issuedAt: now - 60, ttlSeconds: 10 },
        TEST_SECRET,
      );

      const res = await appWithMutation.request('/api/test-mutation', {
        method: 'POST',
        headers: {
          Origin: TRUSTED_ORIGIN,
          [CSRF_HEADER_NAME]: expiredToken,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
        },
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as ApiErrorEnvelope;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('CSRF token geçerli olsa dahi Origin başlığı eksikse istek 403 ile reddedilmelidir (Origin asla zayıflatılamaz)', async () => {
      const validToken = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT },
        TEST_SECRET,
      );

      const res = await appWithMutation.request('/api/test-mutation', {
        method: 'POST',
        headers: {
          [CSRF_HEADER_NAME]: validToken,
        },
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as ApiErrorEnvelope;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('CSRF token geçerli olsa dahi Origin düşmanca ise (https://evil.com) istek reddedilmelidir', async () => {
      const validToken = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT },
        TEST_SECRET,
      );

      const res = await appWithMutation.request('/api/test-mutation', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.com',
          [CSRF_HEADER_NAME]: validToken,
        },
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as ApiErrorEnvelope;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('CSRF token geçerli olsa dahi same-site PHP domaininden (https://mayisigorta.com) gelen istek reddedilmelidir', async () => {
      const validToken = await generateIdentityBoundCsrfToken(
        { subject: AUTHENTICATED_SUBJECT },
        TEST_SECRET,
      );

      const res = await appWithMutation.request('/api/test-mutation', {
        method: 'POST',
        headers: {
          Origin: 'https://mayisigorta.com',
          [CSRF_HEADER_NAME]: validToken,
        },
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as ApiErrorEnvelope;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('GET ve HEAD istekleri Origin başlığı olmaksızın serbestçe çalışmalıdır', async () => {
      const getRes = await appWithMutation.request('/api/health', {
        method: 'GET',
      });
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get('cache-control')).toContain('no-store');
      expect(getRes.headers.get('x-content-type-options')).toBe('nosniff');

      const headRes = await appWithMutation.request('/api/health', {
        method: 'HEAD',
      });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get('cache-control')).toContain('no-store');
    });

    it('GET isteğinde cross-site Sec-Fetch-Site varsa 403 ile engellenmelidir', async () => {
      const res = await appWithMutation.request('/api/health', {
        method: 'GET',
        headers: {
          'Sec-Fetch-Site': 'cross-site',
        },
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as ApiErrorEnvelope;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('OPTIONS isteği güvenilen origin ile yapıldığında güvenli CORS başlıkları dönmelidir', async () => {
      const res = await appWithMutation.request('/api/test-mutation', {
        method: 'OPTIONS',
        headers: {
          Origin: TRUSTED_ORIGIN,
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('allow')).toContain('POST');
      expect(res.headers.get('access-control-allow-origin')).toBe(TRUSTED_ORIGIN);
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('OPTIONS isteği düşmanca origin ile yapıldığında 403 dönmeli ve origin yansıtılmamalıdır', async () => {
      const res = await appWithMutation.request('/api/test-mutation', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.com',
        },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('OPTIONS isteği Origin olmaksızın yapıldığında 204 dönmeli fakat CORS başlığı açmamalıdır', async () => {
      const res = await appWithMutation.request('/api/test-mutation', {
        method: 'OPTIONS',
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('allow')).toContain('POST');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('tüm API hata yanıtları (404, 500 vb.) güvenlik ve no-store başlıklarını taşımalıdır', async () => {
      const res = await appWithMutation.request('/api/bilinmeyen-endpoint-404', {
        method: 'GET',
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('pragma')).toBe('no-cache');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });
  });

  describe('6. Worker Shell & SPA Regression Protection', () => {
    function createAssetsBinding(): Fetcher {
      return {
        fetch: vi.fn(async (input: RequestInfo | URL) => {
          const request = input instanceof Request ? input : new Request(input);
          const pathname = new URL(request.url).pathname;

          if (pathname === '/' || pathname === '/index.html') {
            return new Response('<!doctype html><html><body>SPA shell</body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          if (pathname === '/assets/app.js') {
            return new Response('console.info("asset");', {
              status: 200,
              headers: { 'content-type': 'text/javascript; charset=utf-8' },
            });
          }
          return new Response('asset not found', { status: 404 });
        }),
        connect: vi.fn(),
      } as unknown as Fetcher;
    }

    it('SPA kök ve doğrudan navigasyon yanıtlarına güvenlik başlıkları eklenmelidir', async () => {
      const workerInstance = createWorker();
      const response = await workerInstance.fetch(
        new Request(`${TRUSTED_ORIGIN}/yenilemeler`, {
          headers: { accept: 'text/html' },
        }),
        { ASSETS: createAssetsBinding(), DB: {} as D1Database, APP_ENV: 'production' },
        {} as ExecutionContext,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('SPA shell');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
      // Production HTTPS ortamında HSTS bulunmalıdır
      expect(response.headers.get('strict-transport-security')).toContain('max-age=86400');
    });

    it('mevcut statik varlık (asset) içerik türünü ve güvenlik başlıklarını korumalıdır', async () => {
      const workerInstance = createWorker();
      const response = await workerInstance.fetch(
        new Request(`${TRUSTED_ORIGIN}/assets/app.js`),
        { ASSETS: createAssetsBinding(), DB: {} as D1Database, APP_ENV: 'development' },
        {} as ExecutionContext,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/javascript');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    });
  });

  describe('7. Auth & Authz Reachability (T05 / T06 / T07 Preserved)', () => {
    it('GET /api/me geçerli kimlik ile çağrıldığında güvenlik başlıkları ve no-store ile yanıt vermelidir', async () => {
      const mockPrincipal = {
        subject: 'sub-test-123',
        issuer: 'https://test.cloudflareaccess.com',
        email: 'test@mayisigorta.com',
      };

      const mockVerifier: AccessVerifier = {
        config: {} as AccessConfig,
        verify: vi.fn().mockResolvedValue(mockPrincipal),
      };

      const mockContext: AuthenticatedUserContext = {
        userId: 'usr-123',
        identityId: 'idn-123',
        email: 'test@mayisigorta.com',
        assurance: 'NORMAL',
        memberships: [
          {
            id: 'mem-123',
            agencyId: 'agn-123',
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 1,
          },
        ],
      };

      const mockResolver: ApplicationIdentityResolver = {
        resolve: vi.fn().mockResolvedValue(mockContext),
      };

      const testApp = createApp({
        createVerifier: () => mockVerifier,
        createResolver: () => mockResolver,
      });

      const res = await testApp.request(
        '/api/me',
        {
          method: 'GET',
          headers: {
            'Cf-Access-Jwt-Assertion': 'mock.jwt.token',
          },
        },
        {
          DB: {} as D1Database,
          CF_ACCESS_TEAM_DOMAIN: 'mayi-test.cloudflareaccess.com',
          CF_ACCESS_AUDIENCE: 'synthetic-normal-aud-1234567890abcdef',
          CF_ACCESS_SECURE_AUDIENCE: 'synthetic-secure-aud-9876543210fedcba',
        },
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<UserMeDto>;
      expect(json.success).toBe(true);
      if (json.success) {
        expect(json.data.email).toBe('test@mayisigorta.com');
      }

      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });

    it('GET /api/me kimlik doğrulama başarısızlığında 401 ve güvenlik başlıkları dönmelidir', async () => {
      const testApp = createApp();
      const res = await testApp.request(
        '/api/me',
        {
          method: 'GET',
        },
        {
          DB: {} as D1Database,
          CF_ACCESS_TEAM_DOMAIN: 'mayi-test.cloudflareaccess.com',
          CF_ACCESS_AUDIENCE: 'synthetic-normal-aud-1234567890abcdef',
          CF_ACCESS_SECURE_AUDIENCE: 'synthetic-secure-aud-9876543210fedcba',
        },
      );

      expect(res.status).toBe(401);
      const json = (await res.json()) as ApiErrorEnvelope;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');

      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });
  });
});
