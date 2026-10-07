// Historical Access/JWKS crypto evidence only. F-27 runtime uses native local sessions.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  type JWK,
  createLocalJWKSet,
  errors as joseErrors,
} from 'jose';
import {
  parseAccessConfig,
  assertTrustedAccessConfig,
  type AccessConfig,
  AccessConfigError,
} from './historical/access-config';
import { parseServerConfig } from '../src/server/config';
import {
  extractAccessJwtAssertion,
  MAX_ASSERTION_LENGTH_BYTES,
} from './historical/access-extraction';
import { AccessVerificationError } from './historical/access-errors';
import {
  AccessVerifier,
  createAccessVerifier,
  createHardenedJwksFetch,
  type AccessKeyResolver,
} from './historical/access-verifier';
import { app } from '../src/server/index';
import { API_PREFIX } from '../src/shared/constants';
import type { ApiResponse, HealthCheckData } from '../src/shared/types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Sentetik test yapılandırması
const TEST_TEAM_DOMAIN = 'mayi-test.cloudflareaccess.com';
const TEST_ISSUER = `https://${TEST_TEAM_DOMAIN}`;
const TEST_NORMAL_AUDIENCE = 'synthetic-normal-aud-1234567890abcdef';
const TEST_SECURE_AUDIENCE = 'synthetic-secure-aud-9876543210fedcba';
const TEST_JWKS_URL = `${TEST_ISSUER}/cdn-cgi/access/certs`;

describe('M1-T05 Cloudflare Access JWT Doğrulama Temeli (Offline Synthetic Test Matrix)', () => {
  let validConfig: AccessConfig;

  // Ephemeral RSA anahtar çiftleri
  let primaryKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
  let secondaryKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
  let primaryJwk: JWK;
  let secondaryJwk: JWK;
  const primaryKid = 'key-synthetic-primary-001';
  const secondaryKid = 'key-synthetic-secondary-002';

  beforeAll(async () => {
    validConfig = parseAccessConfig({
      CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
      CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
      CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
    });

    primaryKeyPair = await generateKeyPair('RS256', { extractable: true });
    secondaryKeyPair = await generateKeyPair('RS256', { extractable: true });

    const exportedPrimary = await exportJWK(primaryKeyPair.publicKey);
    primaryJwk = {
      ...exportedPrimary,
      kid: primaryKid,
      alg: 'RS256',
      use: 'sig',
    };

    const exportedSecondary = await exportJWK(secondaryKeyPair.publicKey);
    secondaryJwk = {
      ...exportedSecondary,
      kid: secondaryKid,
      alg: 'RS256',
      use: 'sig',
    };
  });

  function createTestResolver(jwks: { keys: JWK[] }): AccessKeyResolver {
    return createLocalJWKSet(jwks);
  }

  async function createValidToken(
    claims: Record<string, unknown> = {},
    options: {
      keyPair?: typeof primaryKeyPair;
      kid?: string;
      alg?: string;
      customHeader?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const key = options.keyPair ? options.keyPair.privateKey : primaryKeyPair.privateKey;
    const kid = options.kid ?? primaryKid;
    const alg = options.alg ?? 'RS256';

    const nowSec = Math.floor(Date.now() / 1000);
    const builder = new SignJWT({
      iss: TEST_ISSUER,
      aud: TEST_NORMAL_AUDIENCE,
      sub: 'usr-synthetic-worker-001',
      type: 'app',
      email: 'personel@mayisigorta.com',
      iat: nowSec - 60,
      nbf: nowSec - 60,
      exp: nowSec + 3600,
      ...claims,
    });

    const header: Record<string, unknown> = {
      alg,
      kid,
      typ: 'JWT',
      ...options.customHeader,
    };

    builder.setProtectedHeader(header as never);
    return builder.sign(key);
  }

  function asAccessRequest(token: string): Request {
    return new Request('https://panel.mayisigorta.com/api/test', {
      headers: { 'cf-access-jwt-assertion': token },
    });
  }

  function asAccessHeaders(token: string): Headers {
    return new Headers({ 'cf-access-jwt-assertion': token });
  }

  // ============================================================================
  // GRUP 1: BAŞLIK ÇIKARMA (HEADER EXTRACTION)
  // ============================================================================
  describe('Grup 1: Başlık Çıkarma ve Sınır Güvenliği', () => {
    it('1.1. Geçerli Cf-Access-Jwt-Assertion başlığını başarıyla çıkarmalıdır', () => {
      const token = 'header.payload.signature';
      const request = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { 'cf-access-jwt-assertion': token },
      });
      expect(extractAccessJwtAssertion(request)).toBe(token);
    });

    it('1.2. Başlık eksik olduğunda fail-closed MISSING_ASSERTION vermelidir', () => {
      const request = new Request('https://panel.mayisigorta.com/api/test');
      expect(() => extractAccessJwtAssertion(request)).toThrowError(AccessVerificationError);
      try {
        extractAccessJwtAssertion(request);
      } catch (err) {
        expect((err as AccessVerificationError).code).toBe('MISSING_ASSERTION');
      }
    });

    it('1.3. Boş başlık değeri MISSING_ASSERTION ile reddedilmelidir', () => {
      const request = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { 'cf-access-jwt-assertion': '' },
      });
      expect(() => extractAccessJwtAssertion(request)).toThrowError(
        expect.objectContaining({ code: 'MISSING_ASSERTION' }),
      );
    });

    it('1.4. Yalnızca boşluk içeren başlık MISSING_ASSERTION ile reddedilmelidir', () => {
      const request = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { 'cf-access-jwt-assertion': '   \t  \n ' },
      });
      expect(() => extractAccessJwtAssertion(request)).toThrowError(
        expect.objectContaining({ code: 'MISSING_ASSERTION' }),
      );
    });

    it('1.5. Malformed compact token (3 nokta parçalı olmayan) INVALID_ASSERTION_FORMAT vermelidir', () => {
      const malformedSamples = [
        'not-a-jwt',
        'part1.part2',
        'part1.part2.part3.part4',
        '.foo.',
        '..',
      ];
      for (const sample of malformedSamples) {
        const req = new Request('https://panel.mayisigorta.com/api/test', {
          headers: { 'cf-access-jwt-assertion': sample },
        });
        expect(() => extractAccessJwtAssertion(req)).toThrowError(
          expect.objectContaining({ code: 'INVALID_ASSERTION_FORMAT' }),
        );
      }
    });

    it('1.6. Base64url dışı geçersiz karakterler INVALID_ASSERTION_FORMAT ile reddedilmelidir', () => {
      const req = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { 'cf-access-jwt-assertion': 'part1.part 2.part3' },
      });
      expect(() => extractAccessJwtAssertion(req)).toThrowError(
        expect.objectContaining({ code: 'INVALID_ASSERTION_FORMAT' }),
      );
    });

    it('1.7. Authorization: Bearer başlığı dikkate alınmamalı ve MISSING_ASSERTION vermelidir', () => {
      const req = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { authorization: 'Bearer header.payload.signature' },
      });
      expect(() => extractAccessJwtAssertion(req)).toThrowError(
        expect.objectContaining({ code: 'MISSING_ASSERTION' }),
      );
    });

    it('1.8. Sorgu parametresindeki token (?Cf-Access-Jwt-Assertion=...) tamamen yok sayılmalıdır', () => {
      const req = new Request(
        'https://panel.mayisigorta.com/api/test?Cf-Access-Jwt-Assertion=header.payload.signature',
      );
      expect(() => extractAccessJwtAssertion(req)).toThrowError(
        expect.objectContaining({ code: 'MISSING_ASSERTION' }),
      );
    });

    it('1.9. Sorgu parametresindeki ?token= veya ?jwt= tamamen yok sayılmalıdır', () => {
      const req = new Request(
        'https://panel.mayisigorta.com/api/test?token=header.payload.signature',
      );
      expect(() => extractAccessJwtAssertion(req)).toThrowError(
        expect.objectContaining({ code: 'MISSING_ASSERTION' }),
      );
    });

    it('1.10. Çift veya virgülle ayrılmış belirsiz başlık AMBIGUOUS_ASSERTION_HEADER ile reddedilmelidir', () => {
      const req = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { 'cf-access-jwt-assertion': 'tok1.payload.sig, tok2.payload.sig' },
      });
      expect(() => extractAccessJwtAssertion(req)).toThrowError(
        expect.objectContaining({ code: 'AMBIGUOUS_ASSERTION_HEADER' }),
      );
    });
  });

  // ============================================================================
  // GRUP 2: KRİPTOGRAFİK VE ALGORİTMA DOĞRULAMA (CRYPTO & SIGNATURE)
  // ============================================================================
  describe('Grup 2: Kriptografik ve Algoritma Doğrulama', () => {
    let verifier: AccessVerifier;

    beforeAll(() => {
      const resolver = createTestResolver({ keys: [primaryJwk] });
      verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: resolver,
      });
    });

    it('2.1. Güvenilen anahtarla imzalanmış geçerli RS256 belirteç doğrulamadan geçmelidir', async () => {
      const token = await createValidToken();
      const principal = await verifier.verify(asAccessHeaders(token));
      expect(principal.issuer).toBe(TEST_ISSUER);
      expect(principal.subject).toBe('usr-synthetic-worker-001');
      expect(principal.assurance).toBe('NORMAL');
    });

    it('2.2. Yanlış imzalayıcı (JWKS dışı RSA anahtarı) INVALID_SIGNATURE ile reddedilmelidir', async () => {
      const token = await createValidToken({}, { keyPair: secondaryKeyPair });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_SIGNATURE' }),
      );
    });

    it('2.3. Değiştirilmiş payload (tampered payload) INVALID_SIGNATURE ile reddedilmelidir', async () => {
      const token = await createValidToken();
      const [h, p, s] = token.split('.');
      const decodedPayload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf-8'));
      decodedPayload.sub = 'attacker-tampered-sub';
      const tamperedP = Buffer.from(JSON.stringify(decodedPayload)).toString('base64url');
      const tamperedToken = `${h}.${tamperedP}.${s}`;

      await expect(verifier.verify(asAccessRequest(tamperedToken))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_SIGNATURE' }),
      );
    });

    it('2.4. Değiştirilmiş imza baytları INVALID_SIGNATURE ile reddedilmelidir', async () => {
      const token = await createValidToken();
      const [h, p, s] = token.split('.');
      const tamperedS = s!.slice(0, -4) + 'AAAA';
      const tamperedToken = `${h}.${p}.${tamperedS}`;

      await expect(verifier.verify(asAccessRequest(tamperedToken))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_SIGNATURE' }),
      );
    });

    it('2.5. alg: "none" saldırısı fail-closed INVALID_ALGORITHM ile reddedilmelidir', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const p = Buffer.from(
        JSON.stringify({
          iss: TEST_ISSUER,
          aud: TEST_NORMAL_AUDIENCE,
          sub: 'usr-synthetic-worker-001',
          iat: nowSec - 10,
          exp: nowSec + 3600,
        }),
      ).toString('base64url');
      const noneToken = `${h}.${p}.`;

      await expect(verifier.verify(asAccessRequest(noneToken))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_ALGORITHM' }),
      );
    });

    it('2.6. Desteklenmeyen algoritma (ES256, PS256 vb.) INVALID_ALGORITHM ile reddedilmelidir', async () => {
      const ecKeyPair = await generateKeyPair('ES256');
      const nowSec = Math.floor(Date.now() / 1000);
      const ecToken = await new SignJWT({
        iss: TEST_ISSUER,
        aud: TEST_NORMAL_AUDIENCE,
        sub: 'usr-synthetic-worker-001',
        iat: nowSec - 10,
        exp: nowSec + 3600,
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: primaryKid })
        .sign(ecKeyPair.privateKey);

      await expect(verifier.verify(asAccessRequest(ecToken))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_ALGORITHM' }),
      );
    });

    it('2.7. HMAC kafa karışıklığı (HS256) saldırısı INVALID_ALGORITHM ile reddedilmelidir', async () => {
      const hmacSecret = new Uint8Array(32).fill(42);
      const nowSec = Math.floor(Date.now() / 1000);
      const hmacToken = await new SignJWT({
        iss: TEST_ISSUER,
        aud: TEST_NORMAL_AUDIENCE,
        sub: 'usr-synthetic-worker-001',
        iat: nowSec - 10,
        exp: nowSec + 3600,
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: primaryKid })
        .sign(hmacSecret);

      await expect(verifier.verify(asAccessRequest(hmacToken))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_ALGORITHM' }),
      );
    });

    it('2.8. Bilinmeyen kid değeri KEY_NOT_FOUND ile reddedilmelidir', async () => {
      const token = await createValidToken({}, { kid: 'non-existent-kid-999' });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'KEY_NOT_FOUND' }),
      );
    });

    it('2.9. Yanlış JWK (kid eşleşse bile yanlış public key) INVALID_SIGNATURE ile reddedilmelidir', async () => {
      // kid primaryKid olarak etiketlenmiş ama secondaryKeyPair'ın genel anahtarını taşıyan JWKS
      const fakePrimaryJwk = { ...secondaryJwk, kid: primaryKid };
      const resolver = createTestResolver({ keys: [fakePrimaryJwk] });
      const badVerifier = createAccessVerifier({
        config: validConfig,
        keyResolver: resolver,
      });

      const token = await createValidToken(); // primaryKeyPair ile imzalandı
      await expect(badVerifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_SIGNATURE' }),
      );
    });
  });

  // ============================================================================
  // GRUP 3: TALEP (CLAIMS) VE ZAMANSAL DOĞRULAMA (CLAIMS & AUDIENCE)
  // ============================================================================
  describe('Grup 3: Talep (Claims) ve Zamansal Doğrulama', () => {
    let verifier: AccessVerifier;

    beforeAll(() => {
      const resolver = createTestResolver({ keys: [primaryJwk] });
      verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: resolver,
        clockToleranceSeconds: 5,
      });
    });

    it('3.1. Doğru issuer geçerlidir', async () => {
      const token = await createValidToken({ iss: TEST_ISSUER });
      const p = await verifier.verify(asAccessRequest(token));
      expect(p.issuer).toBe(TEST_ISSUER);
    });

    it('3.2. Yanlış issuer INVALID_ISSUER ile reddedilmelidir', async () => {
      const token = await createValidToken({ iss: 'https://attacker.cloudflareaccess.com' });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_ISSUER' }),
      );
    });

    it('3.3. Eksik issuer INVALID_ISSUER ile reddedilmelidir', async () => {
      const token = await createValidToken({ iss: undefined });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_ISSUER' }),
      );
    });

    it('3.4. Geçerli dizge subject başarıyla doğrulanmalıdır', async () => {
      const token = await createValidToken({ sub: 'valid-subject-uuid' });
      const p = await verifier.verify(asAccessRequest(token));
      expect(p.subject).toBe('valid-subject-uuid');
    });

    it('3.5. Eksik subject INVALID_SUBJECT ile reddedilmelidir', async () => {
      const token = await createValidToken({ sub: undefined });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_SUBJECT' }),
      );
    });

    it('3.6. Boş subject ("") INVALID_SUBJECT ile reddedilmelidir', async () => {
      const token = await createValidToken({ sub: '' });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_SUBJECT' }),
      );
    });

    it('3.7. Sayı veya nesne tipinde subject INVALID_SUBJECT ile reddedilmelidir', async () => {
      const token = await createValidToken({ sub: 12345 });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_SUBJECT' }),
      );
    });

    it('3.8. Normal audience NORMAL güvence sınıfına sınıflandırılmalıdır', async () => {
      const token = await createValidToken({ aud: TEST_NORMAL_AUDIENCE });
      const p = await verifier.verify(asAccessRequest(token));
      expect(p.assurance).toBe('NORMAL');
    });

    it('3.9. Secure audience SECURE güvence sınıfına sınıflandırılmalıdır', async () => {
      const token = await createValidToken({ aud: TEST_SECURE_AUDIENCE });
      const p = await verifier.verify(asAccessRequest(token));
      expect(p.assurance).toBe('SECURE');
    });

    it('3.10. Yanlış audience INVALID_AUDIENCE ile reddedilmelidir', async () => {
      const token = await createValidToken({ aud: 'wrong-audience-value' });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_AUDIENCE' }),
      );
    });

    it('3.11. Eksik audience INVALID_AUDIENCE ile reddedilmelidir', async () => {
      const token = await createValidToken({ aud: undefined });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_AUDIENCE' }),
      );
    });

    it('3.12. Normal belirteç SECURE güvence gerektiren kontrolde reddedilmelidir', async () => {
      const token = await createValidToken({ aud: TEST_NORMAL_AUDIENCE });
      await expect(verifier.verify(asAccessRequest(token), 'SECURE')).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_AUDIENCE' }),
      );
    });

    it("3.13. Her iki audience'ı birden içeren belirteç AMBIGUOUS_AUDIENCE ile reddedilmelidir", async () => {
      const token = await createValidToken({
        aud: [TEST_NORMAL_AUDIENCE, TEST_SECURE_AUDIENCE],
      });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'AMBIGUOUS_AUDIENCE' }),
      );
    });

    it('3.14. Süresi dolmuş belirteç (exp geçmişte) TOKEN_EXPIRED ile reddedilmelidir', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = await createValidToken({
        iat: nowSec - 4000,
        exp: nowSec - 100, // 100 saniye önce dolmuş
      });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
      );
    });

    it('3.15. Henüz geçerli olmayan belirteç (nbf gelecekte) TOKEN_NOT_YET_VALID ile reddedilmelidir', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = await createValidToken({
        nbf: nowSec + 120, // 2 dakika gelecekte
        exp: nowSec + 3600,
      });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'TOKEN_NOT_YET_VALID' }),
      );
    });

    it('3.16. Geçerli pencere (nbf <= now <= exp) doğrulamayı geçmelidir', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = await createValidToken({
        nbf: nowSec - 10,
        exp: nowSec + 600,
      });
      const p = await verifier.verify(asAccessRequest(token));
      expect(p.expiresAt).toBe(nowSec + 600);
    });

    it('3.17. Saat toleransı (5 saniye): 3 saniye önce dolan belirteç geçer, 10 saniye önce dolan reddedilir', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const passToken = await createValidToken({ exp: nowSec - 3 });
      const failToken = await createValidToken({ exp: nowSec - 10 });

      await expect(verifier.verify(asAccessRequest(passToken))).resolves.toBeDefined();
      await expect(verifier.verify(asAccessRequest(failToken))).rejects.toThrowError(
        expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
      );
    });

    it('3.18. Saat toleransı (5 saniye): 3 saniye gelecekteki nbf geçer, 10 saniye gelecekteki reddedilir', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const passToken = await createValidToken({ nbf: nowSec + 3 });
      const failToken = await createValidToken({ nbf: nowSec + 10 });

      await expect(verifier.verify(asAccessRequest(passToken))).resolves.toBeDefined();
      await expect(verifier.verify(asAccessRequest(failToken))).rejects.toThrowError(
        expect.objectContaining({ code: 'TOKEN_NOT_YET_VALID' }),
      );
    });

    it('3.19. exp sayı harici tipte olduğunda INVALID_CLAIM_TYPES ile reddedilmelidir', async () => {
      const token = await createValidToken({ exp: 'not-a-number' });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_CLAIM_TYPES' }),
      );
    });

    it('3.20. nbf sayı harici tipte olduğunda INVALID_CLAIM_TYPES ile reddedilmelidir', async () => {
      const token = await createValidToken({ nbf: 'not-a-number' });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_CLAIM_TYPES' }),
      );
    });

    it('3.21. iss sayı tipinde olduğunda INVALID_ISSUER veya INVALID_CLAIM_TYPES ile reddedilmelidir', async () => {
      const token = await createValidToken({ iss: 12345 });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(/INVALID_ISSUER|INVALID_CLAIM_TYPES/),
        }),
      );
    });

    it('3.22. aud sayı tipinde olduğunda INVALID_AUDIENCE veya INVALID_CLAIM_TYPES ile reddedilmelidir', async () => {
      const token = await createValidToken({ aud: 99999 });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(/INVALID_AUDIENCE|INVALID_CLAIM_TYPES/),
        }),
      );
    });

    it('3.23. type alanı "app" dışında (ör. "service", "admin") olduğunda INVALID_CLAIM_TYPES ile reddedilmelidir', async () => {
      const token = await createValidToken({ type: 'service_token' });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_CLAIM_TYPES' }),
      );
    });

    it('3.24. type alanı eksik olduğunda fail-closed INVALID_CLAIM_TYPES ile reddedilmelidir', async () => {
      const token = await createValidToken({ type: undefined });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_CLAIM_TYPES' }),
      );
    });
  });

  // ============================================================================
  // GRUP 4: YETKİ İZOLASYONU VE KİMLİK SEMANTİĞİ (AUTHORITY ISOLATION)
  // ============================================================================
  describe('Grup 4: Yetki İzolasyonu ve Kimlik Semantiği', () => {
    let verifier: AccessVerifier;

    beforeAll(() => {
      const resolver = createTestResolver({ keys: [primaryJwk] });
      verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: resolver,
      });
    });

    it('4.1. role: "OWNER" talebi taşıyan belirteçte principal nesnesine hiçbir role/yetki sızmamalıdır', async () => {
      const token = await createValidToken({ role: 'OWNER' });
      const p = (await verifier.verify(asAccessRequest(token))) as unknown as Record<
        string,
        unknown
      >;
      expect(p.role).toBeUndefined();
      expect(p['is_owner']).toBeUndefined();
    });

    it('4.2. agency_id talebi taşıyan belirteçte principal nesnesine agency_id sızmamalıdır', async () => {
      const token = await createValidToken({ agency_id: 'agency-synthetic-attack' });
      const p = (await verifier.verify(asAccessRequest(token))) as unknown as Record<
        string,
        unknown
      >;
      expect(p.agency_id).toBeUndefined();
    });

    it('4.3. permissions: ["*"] talebi taşıyan belirteçte principal nesnesine permissions sızmamalıdır', async () => {
      const token = await createValidToken({ permissions: ['*'] });
      const p = (await verifier.verify(asAccessRequest(token))) as unknown as Record<
        string,
        unknown
      >;
      expect(p.permissions).toBeUndefined();
    });

    it('4.4. is_admin: true talebi taşıyan belirteçte principal nesnesine is_admin sızmamalıdır', async () => {
      const token = await createValidToken({ is_admin: true });
      const p = (await verifier.verify(asAccessRequest(token))) as unknown as Record<
        string,
        unknown
      >;
      expect(p.is_admin).toBeUndefined();
    });

    it('4.5. groups: ["admin"] talebi taşıyan belirteçte principal nesnesine groups sızmamalıdır', async () => {
      const token = await createValidToken({ groups: ['admin', 'superusers'] });
      const p = (await verifier.verify(asAccessRequest(token))) as unknown as Record<
        string,
        unknown
      >;
      expect(p.groups).toBeUndefined();
    });

    it('4.6. Keyfi talepler (arbitrary claims) VerifiedAccessPrincipal nesnesine kesinlikle kopyalanmamalıdır', async () => {
      const token = await createValidToken({
        custom_hack: 'value',
        scope: 'root',
        isSuper: true,
      });
      const p = (await verifier.verify(asAccessRequest(token))) as unknown as Record<
        string,
        unknown
      >;
      expect(p.custom_hack).toBeUndefined();
      expect(p.scope).toBeUndefined();
      expect(p.isSuper).toBeUndefined();

      // İzin verilen özellikler kümesi katı olmalıdır
      const allowedKeys = new Set([
        'issuer',
        'subject',
        'assurance',
        'expiresAt',
        'issuedAt',
        'notBefore',
        'email',
      ]);
      for (const key of Object.keys(p)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    });

    it("4.7. E-posta claim'i yalnız bilgilendirme amaçlıdır; subject yerine ASLA geçemez", async () => {
      const token = await createValidToken({
        sub: 'sub-canonical-user-uuid',
        email: 'personel@mayisigorta.com',
      });
      const p = await verifier.verify(asAccessRequest(token));
      expect(p.subject).toBe('sub-canonical-user-uuid');
      expect(p.email).toBe('personel@mayisigorta.com');
      expect(p.subject).not.toBe(p.email);
    });

    it('4.8. Aynı e-posta fakat farklı sub değerine sahip iki belirteç farklı principal üretmelidir', async () => {
      const t1 = await createValidToken({
        sub: 'sub-user-alpha',
        email: 'shared@mayisigorta.com',
      });
      const t2 = await createValidToken({
        sub: 'sub-user-beta',
        email: 'shared@mayisigorta.com',
      });

      const p1 = await verifier.verify(asAccessRequest(t1));
      const p2 = await verifier.verify(asAccessRequest(t2));

      expect(p1.email).toBe(p2.email);
      expect(p1.subject).not.toBe(p2.subject);
    });

    it('4.9. E-posta bulunmayan geçerli belirteç principal.email === undefined ile kabul edilmelidir', async () => {
      const token = await createValidToken({ email: undefined });
      const p = await verifier.verify(asAccessRequest(token));
      expect(p.subject).toBe('usr-synthetic-worker-001');
      expect(p.email).toBeUndefined();
    });

    it('4.10. E-posta alanı sayı/nesne gibi dizge dışı olduğunda INVALID_CLAIM_TYPES ile reddedilmelidir', async () => {
      const token = await createValidToken({ email: 123456 });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_CLAIM_TYPES' }),
      );
    });
  });

  // ============================================================================
  // GRUP 5: ANAHTAR YÖNETİMİ, ROTASYON VE JWKS SAVUNMASI (JWKS & DEFENSE)
  // ============================================================================
  describe('Grup 5: Anahtar Yönetimi, Rotasyon ve JWKS Savunması', () => {
    it('5.1. Bilinen kid başarılı şekilde çözümlenmelidir', async () => {
      const resolver = createTestResolver({ keys: [primaryJwk] });
      const verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: resolver,
      });
      const token = await createValidToken({}, { kid: primaryKid });
      await expect(verifier.verify(asAccessRequest(token))).resolves.toBeDefined();
    });

    it('5.2. Bilinmeyen kid fail-closed KEY_NOT_FOUND vermelidir', async () => {
      const resolver = createTestResolver({ keys: [primaryJwk] });
      const verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: resolver,
      });
      const token = await createValidToken({}, { kid: 'totally-unknown-kid' });
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'KEY_NOT_FOUND' }),
      );
    });

    it('5.3. JWKS getirme hatası (network/resolver error) fail-closed JWKS_FETCH_FAILED vermelidir', async () => {
      const failingResolver: AccessKeyResolver = vi
        .fn()
        .mockRejectedValue(new Error('Network offline'));
      const verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: failingResolver,
      });
      const token = await createValidToken();
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'JWKS_FETCH_FAILED' }),
      );
    });

    it('5.4. Bozuk veya geçersiz JWKS fail-closed JWKS_FETCH_FAILED vermelidir', async () => {
      const malformedResolver: AccessKeyResolver = vi
        .fn()
        .mockRejectedValue(new TypeError('Invalid JWKS JSON structure'));
      const verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: malformedResolver,
      });
      const token = await createValidToken();
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'JWKS_FETCH_FAILED' }),
      );
    });

    it('5.5. JWK "use" veya "alg" uyuşmazlığı fail-closed olmalıdır', async () => {
      // use: 'enc' (imza için kullanılamaz)
      const encJwk = { ...primaryJwk, use: 'enc' };
      const resolver = createTestResolver({ keys: [encJwk] });
      const verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: resolver,
      });
      const token = await createValidToken();
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError();
    });

    it('5.6. Anahtar rotasyonu: Eski ve yeni anahtar setinde her iki belirteç de doğrulanmalıdır', async () => {
      // JWKS setinde hem eski (primary) hem yeni (secondary) anahtarlar var
      const rotatingResolver = createTestResolver({ keys: [primaryJwk, secondaryJwk] });
      const verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: rotatingResolver,
      });

      const oldToken = await createValidToken({}, { keyPair: primaryKeyPair, kid: primaryKid });
      const newToken = await createValidToken({}, { keyPair: secondaryKeyPair, kid: secondaryKid });

      await expect(verifier.verify(asAccessRequest(oldToken))).resolves.toBeDefined();
      await expect(verifier.verify(asAccessRequest(newToken))).resolves.toBeDefined();
    });

    it('5.7. jku korumalı başlığı reddedilmeli ve anahtar seçiminde asla kullanılmamalıdır', async () => {
      const resolver = createTestResolver({ keys: [primaryJwk] });
      const verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: resolver,
      });

      const tokenWithJku = await createValidToken(
        {},
        {
          customHeader: {
            jku: 'https://attacker.com/jwks.json',
          },
        },
      );

      await expect(verifier.verify(asAccessRequest(tokenWithJku))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_TOKEN' }),
      );
    });

    it('5.8. x5u korumalı başlığı reddedilmeli ve anahtar seçiminde asla kullanılmamalıdır', async () => {
      const resolver = createTestResolver({ keys: [primaryJwk] });
      const verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: resolver,
      });

      const tokenWithX5u = await createValidToken(
        {},
        {
          customHeader: {
            x5u: 'https://attacker.com/cert.pem',
          },
        },
      );

      await expect(verifier.verify(asAccessRequest(tokenWithX5u))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_TOKEN' }),
      );
    });

    it('5.9. Saldırgan kontrollü token iss alanı JWKS URL adresini asla değiştiremez', async () => {
      let requestedUrl = '';
      const spyResolver: AccessKeyResolver = vi.fn(async (_header, _token) => {
        // Resolver yalnızca güvenilir config JWKS'ine bağlanır
        requestedUrl = validConfig.jwksUrl;
        return primaryKeyPair.publicKey as never;
      });

      const verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: spyResolver,
      });

      const maliciousToken = await createValidToken({
        iss: 'https://evil-team.cloudflareaccess.com',
      });

      await expect(verifier.verify(asAccessRequest(maliciousToken))).rejects.toThrowError();
      expect(requestedUrl).toBe(TEST_JWKS_URL);
      expect(requestedUrl).not.toContain('evil-team');
    });
  });

  // ============================================================================
  // GRUP 6: YAPILANDIRMA DOĞRULAMA SÖZLEŞMESİ (CONFIG CONTRACT)
  // ============================================================================
  describe('Grup 6: Sunucu Yapılandırma Doğrulama Sözleşmesi', () => {
    it('6.1. Eksik issuer / team domain yapılandırması fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.2. Eksik normal audience yapılandırması fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.3. Eksik secure audience yapılandırması fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.4. Boş veya sadece boşluk içeren alanlar fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_TEAM_DOMAIN: '   ',
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);

      expect(() =>
        parseAccessConfig({
          CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
          CF_ACCESS_AUDIENCE: '',
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.5. HTTPS olmayan issuer (http://) fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_ISSUER: `http://${TEST_TEAM_DOMAIN}`,
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.6. Kimlik bilgisi (credentials) içeren issuer fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_ISSUER: `https://user:password@${TEST_TEAM_DOMAIN}`,
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.7. Sorgu dizesi (?query) içeren issuer fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_ISSUER: `https://${TEST_TEAM_DOMAIN}?foo=bar`,
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.8. Fragment (#hash) içeren issuer fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_ISSUER: `https://${TEST_TEAM_DOMAIN}#fragment`,
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.9. Kök harici yol (/path) içeren issuer fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_ISSUER: `https://${TEST_TEAM_DOMAIN}/extra/path`,
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.10. cloudflareaccess.com dışı veya güvenli olmayan host fail-closed reddedilmelidir', () => {
      const badHosts = [
        'attacker.com',
        'cloudflareaccess.com', // alt alan adı yok
        '.cloudflareaccess.com',
        'evilcloudflareaccess.com',
        'mayisigorta.com',
        'team.cloudflareaccess.com.attacker.com',
      ];
      for (const host of badHosts) {
        expect(() =>
          parseAccessConfig({
            CF_ACCESS_TEAM_DOMAIN: host,
            CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
            CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
          }),
        ).toThrowError(AccessConfigError);
      }
    });

    it('6.11. Normal ve secure audience birbirinin aynısı olduğunda fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
          CF_ACCESS_AUDIENCE: 'identical-audience',
          CF_ACCESS_SECURE_AUDIENCE: 'identical-audience',
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.12. Geçerli yapılandırma kanonik issuer ve JWKS URL adresini deterministik türetmelidir', () => {
      const config = parseAccessConfig({
        CF_ACCESS_TEAM_DOMAIN: 'my-team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
        CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
      });

      expect(config.issuer).toBe('https://my-team.cloudflareaccess.com');
      expect(config.teamDomain).toBe('my-team.cloudflareaccess.com');
      expect(config.jwksUrl).toBe('https://my-team.cloudflareaccess.com/cdn-cgi/access/certs');
      expect(config.normalAudience).toBe(TEST_NORMAL_AUDIENCE);
      expect(config.secureAudience).toBe(TEST_SECURE_AUDIENCE);
    });

    it('6.13. CF_ACCESS_* yapılandırmaları ve verifier modülleri istemciye (client) asla sızdırılmamalıdır', () => {
      const clientAppPath = resolve(__dirname, '../src/app/App.tsx');
      const content = readFileSync(clientAppPath, 'utf-8');
      expect(content).not.toContain('CF_ACCESS_SECURE_AUDIENCE');
      expect(content).not.toContain('parseAccessConfig');
      expect(content).not.toContain('createAccessVerifier');
    });

    it('6.14. Elle sahte jwksUrl ile üretilmiş AccessConfig nesnesi fetch öncesinde fail-closed reddedilmelidir', async () => {
      const forgedConfig: AccessConfig = {
        issuer: 'https://mayi-test.cloudflareaccess.com',
        teamDomain: 'mayi-test.cloudflareaccess.com',
        normalAudience: TEST_NORMAL_AUDIENCE,
        secureAudience: TEST_SECURE_AUDIENCE,
        jwksUrl: 'https://attacker.com/evil-certs',
      };
      expect(() => createAccessVerifier({ config: forgedConfig })).toThrowError(
        expect.objectContaining({ code: 'CONFIGURATION_ERROR' }),
      );
    });

    it('6.15. Hem CF_ACCESS_ISSUER hem CF_ACCESS_TEAM_DOMAIN verilip uyuşmadığında fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_ISSUER: 'https://team-a.cloudflareaccess.com',
          CF_ACCESS_TEAM_DOMAIN: 'team-b.cloudflareaccess.com',
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.16. Sonunda tire olan takım etiketi (team-) fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_TEAM_DOMAIN: 'my-team-.cloudflareaccess.com',
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);

      expect(() =>
        parseAccessConfig({
          CF_ACCESS_TEAM_DOMAIN: '-my-team.cloudflareaccess.com',
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.17. Boşlukla sarılmış (whitespace-padded) audience veya config değerleri fail-closed reddedilmelidir', () => {
      expect(() =>
        parseAccessConfig({
          CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
          CF_ACCESS_AUDIENCE: '  ' + TEST_NORMAL_AUDIENCE + '  ',
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
        }),
      ).toThrowError(AccessConfigError);

      expect(() =>
        parseAccessConfig({
          CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
          CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
          CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE + ' ',
        }),
      ).toThrowError(AccessConfigError);
    });

    it('6.18. assertTrustedAccessConfig: Sahte credentials (username/password) içeren issuer fail-closed reddedilmelidir', () => {
      const forgedConfig: AccessConfig = {
        issuer: `https://user:pass@${TEST_TEAM_DOMAIN}`,
        teamDomain: TEST_TEAM_DOMAIN,
        normalAudience: TEST_NORMAL_AUDIENCE,
        secureAudience: TEST_SECURE_AUDIENCE,
        jwksUrl: `https://user:pass@${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`,
      };
      expect(() => assertTrustedAccessConfig(forgedConfig)).toThrowError(AccessConfigError);
      expect(() => createAccessVerifier({ config: forgedConfig })).toThrowError(
        expect.objectContaining({ code: 'CONFIGURATION_ERROR' }),
      );
    });

    it('6.19. assertTrustedAccessConfig: Standart dışı port (:444) içeren issuer fail-closed reddedilmelidir', () => {
      const forgedConfig: AccessConfig = {
        issuer: `https://${TEST_TEAM_DOMAIN}:444`,
        teamDomain: TEST_TEAM_DOMAIN,
        normalAudience: TEST_NORMAL_AUDIENCE,
        secureAudience: TEST_SECURE_AUDIENCE,
        jwksUrl: `https://${TEST_TEAM_DOMAIN}:444/cdn-cgi/access/certs`,
      };
      expect(() => assertTrustedAccessConfig(forgedConfig)).toThrowError(AccessConfigError);
      expect(() => createAccessVerifier({ config: forgedConfig })).toThrowError(
        expect.objectContaining({ code: 'CONFIGURATION_ERROR' }),
      );
    });

    it('6.20. assertTrustedAccessConfig: Kök harici yol (/extra-path) içeren issuer fail-closed reddedilmelidir', () => {
      const forgedConfig: AccessConfig = {
        issuer: `https://${TEST_TEAM_DOMAIN}/extra-path`,
        teamDomain: TEST_TEAM_DOMAIN,
        normalAudience: TEST_NORMAL_AUDIENCE,
        secureAudience: TEST_SECURE_AUDIENCE,
        jwksUrl: `https://${TEST_TEAM_DOMAIN}/extra-path/cdn-cgi/access/certs`,
      };
      expect(() => assertTrustedAccessConfig(forgedConfig)).toThrowError(AccessConfigError);
      expect(() => createAccessVerifier({ config: forgedConfig })).toThrowError(
        expect.objectContaining({ code: 'CONFIGURATION_ERROR' }),
      );
    });

    it('6.21. assertTrustedAccessConfig: Sorgu dizesi (?query=evil) içeren issuer fail-closed reddedilmelidir', () => {
      const forgedConfig: AccessConfig = {
        issuer: `https://${TEST_TEAM_DOMAIN}?query=evil`,
        teamDomain: TEST_TEAM_DOMAIN,
        normalAudience: TEST_NORMAL_AUDIENCE,
        secureAudience: TEST_SECURE_AUDIENCE,
        jwksUrl: `https://${TEST_TEAM_DOMAIN}?query=evil/cdn-cgi/access/certs`,
      };
      expect(() => assertTrustedAccessConfig(forgedConfig)).toThrowError(AccessConfigError);
      expect(() => createAccessVerifier({ config: forgedConfig })).toThrowError(
        expect.objectContaining({ code: 'CONFIGURATION_ERROR' }),
      );
    });

    it('6.22. assertTrustedAccessConfig: Parça (#frag) içeren issuer fail-closed reddedilmelidir', () => {
      const forgedConfig: AccessConfig = {
        issuer: `https://${TEST_TEAM_DOMAIN}#frag`,
        teamDomain: TEST_TEAM_DOMAIN,
        normalAudience: TEST_NORMAL_AUDIENCE,
        secureAudience: TEST_SECURE_AUDIENCE,
        jwksUrl: `https://${TEST_TEAM_DOMAIN}#frag/cdn-cgi/access/certs`,
      };
      expect(() => assertTrustedAccessConfig(forgedConfig)).toThrowError(AccessConfigError);
      expect(() => createAccessVerifier({ config: forgedConfig })).toThrowError(
        expect.objectContaining({ code: 'CONFIGURATION_ERROR' }),
      );
    });

    it('6.23. parseAccessConfig: Aynı hostname fakat bozuk CF_ACCESS_TEAM_DOMAIN içeren ikili yapılandırma fail-closed reddedilmelidir', () => {
      const malformedDomains = [
        `${TEST_TEAM_DOMAIN}:444`,
        `${TEST_TEAM_DOMAIN}/some-path`,
        `admin:secret@${TEST_TEAM_DOMAIN}`,
        `${TEST_TEAM_DOMAIN}?evil=1`,
        `${TEST_TEAM_DOMAIN}#evil`,
      ];

      for (const malformed of malformedDomains) {
        expect(() =>
          parseAccessConfig({
            CF_ACCESS_ISSUER: `https://${TEST_TEAM_DOMAIN}`,
            CF_ACCESS_TEAM_DOMAIN: malformed,
            CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
            CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
          }),
        ).toThrowError(AccessConfigError);
      }
    });

    it('6.24. parseServerConfig({}) sentetik Cloudflare Access alanları (CF_ACCESS_*) üretmemelidir', () => {
      const genericConfig = parseServerConfig({});
      expect((genericConfig as Record<string, unknown>).CF_ACCESS_TEAM_DOMAIN).toBeUndefined();
      expect((genericConfig as Record<string, unknown>).CF_ACCESS_AUDIENCE).toBeUndefined();
      expect((genericConfig as Record<string, unknown>).CF_ACCESS_SECURE_AUDIENCE).toBeUndefined();
    });

    it('6.25. parseAccessConfig eksik alanlarda fail-closed hata fırlatmalıdır ve generic ServerConfig AccessConfig yerine kullanılamaz', () => {
      expect(() => parseAccessConfig({})).toThrowError(AccessConfigError);
      expect(() => parseAccessConfig({ CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN })).toThrowError(
        AccessConfigError,
      );

      const genericConfig = parseServerConfig({});
      expect(() =>
        parseAccessConfig(genericConfig as unknown as Record<string, unknown>),
      ).toThrowError(AccessConfigError);
      expect(() =>
        assertTrustedAccessConfig(genericConfig as unknown as AccessConfig),
      ).toThrowError(AccessConfigError);
    });
  });

  // ============================================================================
  // GRUP 7: GÜVENLİK SINIRI, SIZINTI VE SAĞLIK KONTROLÜ İNVARYANTLARI
  // ============================================================================
  describe('Grup 7: Güvenlik Sınırı, Sızıntı ve Sistem Sağlığı', () => {
    let verifier: AccessVerifier;

    beforeAll(() => {
      const resolver = createTestResolver({ keys: [primaryJwk] });
      verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: resolver,
      });
    });

    it('7.1. Aşırı büyük belirteç (>16 KiB) fail-closed ASSERTION_TOO_LARGE ile reddedilmelidir', () => {
      const largePayload = 'A'.repeat(MAX_ASSERTION_LENGTH_BYTES + 100);
      const largeToken = `header.${largePayload}.signature`;
      const req = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { 'cf-access-jwt-assertion': largeToken },
      });
      expect(() => extractAccessJwtAssertion(req)).toThrowError(
        expect.objectContaining({ code: 'ASSERTION_TOO_LARGE' }),
      );
    });

    it('7.2. Hata mesajlarında ve hata nesnelerinde ham belirteç veya sır sızıntısı olmamalıdır', async () => {
      const rawSecretPayload = 'super-secret-user-pii-token-fragment';
      const token = await createValidToken({
        iss: 'https://attacker.cloudflareaccess.com',
        sub: rawSecretPayload,
      });

      try {
        await verifier.verify(asAccessRequest(token));
        expect.unreachable('Doğrulama başarısız olmalıydı');
      } catch (err) {
        expect(err).toBeInstanceOf(AccessVerificationError);
        const errorMsg = (err as Error).message;
        const serialized = JSON.stringify(err);

        expect(errorMsg).not.toContain(rawSecretPayload);
        expect(serialized).not.toContain(rawSecretPayload);
        expect(errorMsg).not.toContain(token);
        expect(serialized).not.toContain(token);
      }
    });

    it('7.3. Üretim kaynaklarında ve çalışma zamanı dosyalarında özel test anahtarı bulunmamalıdır', () => {
      const serverIndexPath = resolve(__dirname, '../src/server/index.ts');
      const serverConfigPath = resolve(__dirname, '../src/server/config.ts');
      const content =
        readFileSync(serverIndexPath, 'utf-8') + readFileSync(serverConfigPath, 'utf-8');

      expect(content).not.toContain('BEGIN RSA PRIVATE KEY');
      expect(content).not.toContain('BEGIN PRIVATE KEY');
      expect(content).not.toContain('d":'); // RSA private exponent in JWK
    });

    it('7.4. /api/health uç noktası Access yapılandırması olmasa dahi bozulmadan çalışmalıdır', async () => {
      // Access config olmadan çağrıldığında bile /api/health 200 dönmelidir
      const res = await app.request(`https://panel.mayisigorta.com${API_PREFIX}/health`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<HealthCheckData>;
      expect(json.success).toBe(true);
      if (json.success) {
        expect(json.data.status).toBe('healthy');
      }
    });

    it('7.5. Saldırgan kontrollü alg başlığı (malicious alg) hata mesajlarına veya serileştirmeye sızmamalıdır', async () => {
      const maliciousAlg = 'MALICIOUS_TOKEN_ALG_LEAK_SECRET';
      const h = Buffer.from(
        JSON.stringify({ alg: maliciousAlg, typ: 'JWT', kid: primaryKid }),
      ).toString('base64url');
      const p = Buffer.from(
        JSON.stringify({
          iss: TEST_ISSUER,
          aud: TEST_NORMAL_AUDIENCE,
          sub: 'usr-synthetic-worker-001',
          type: 'app',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');
      const token = `${h}.${p}.c2lnbmF0dXJl`;

      try {
        await verifier.verify(asAccessRequest(token));
        expect.unreachable('Doğrulama başarısız olmalıydı');
      } catch (err) {
        expect(err).toBeInstanceOf(AccessVerificationError);
        const errorMsg = (err as Error).message;
        const serialized = JSON.stringify(err);
        expect(errorMsg).not.toContain(maliciousAlg);
        expect(serialized).not.toContain(maliciousAlg);
        expect((err as AccessVerificationError).code).toBe('INVALID_ALGORITHM');
      }
    });

    it('7.6. verifier.verify doğrudan etiketlenmemiş ham metin (unlabelled raw assertion string) ile çağrıldığında fail-closed reddedilmelidir', async () => {
      const validToken = await createValidToken();
      await expect(verifier.verify(validToken as unknown as Request)).rejects.toThrowError(
        expect.objectContaining({ code: 'MISSING_ASSERTION' }),
      );
    });

    it('7.7. Authorization: Bearer başlığı taşıyan istekler fail-closed MISSING_ASSERTION ile reddedilmelidir', async () => {
      const validToken = await createValidToken();
      const req = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { authorization: `Bearer ${validToken}` },
      });
      await expect(verifier.verify(req)).rejects.toThrowError(
        expect.objectContaining({ code: 'MISSING_ASSERTION' }),
      );
    });

    it('7.8. URL sorgu parametresi (?token= veya ?jwt=) taşıyan istekler fail-closed MISSING_ASSERTION ile reddedilmelidir', async () => {
      const validToken = await createValidToken();
      const req = new Request(
        `https://panel.mayisigorta.com/api/test?token=${validToken}&jwt=${validToken}&cf_token=${validToken}`,
      );
      await expect(verifier.verify(req)).rejects.toThrowError(
        expect.objectContaining({ code: 'MISSING_ASSERTION' }),
      );
    });

    it('7.9. Çerez (Cookie: CF_Authorization=...) taşıyan istekler fail-closed MISSING_ASSERTION ile reddedilmelidir', async () => {
      const validToken = await createValidToken();
      const req = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { cookie: `CF_Authorization=${validToken}; session=${validToken}` },
      });
      await expect(verifier.verify(req)).rejects.toThrowError(
        expect.objectContaining({ code: 'MISSING_ASSERTION' }),
      );
    });

    it('7.10. Boş veya belirsiz (virgülle ayrılmış çift) Cf-Access-Jwt-Assertion başlığı fail-closed reddedilmelidir', async () => {
      const validToken = await createValidToken();
      const emptyReq = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { 'cf-access-jwt-assertion': '   ' },
      });
      await expect(verifier.verify(emptyReq)).rejects.toThrowError(
        expect.objectContaining({ code: 'MISSING_ASSERTION' }),
      );

      const ambiguousReq = new Request('https://panel.mayisigorta.com/api/test', {
        headers: { 'cf-access-jwt-assertion': `${validToken},${validToken}` },
      });
      await expect(verifier.verify(ambiguousReq)).rejects.toThrowError(
        expect.objectContaining({ code: 'AMBIGUOUS_ASSERTION_HEADER' }),
      );
    });
  });

  // ============================================================================
  // GRUP 8: PRODÜKSİYON REMOTE JWKS VE HARDENED CUSTOMFETCH YOLU (OFFLINE SYNTHETIC)
  // ============================================================================
  describe('Grup 8: Prodüksiyon Remote JWKS ve Hardened CustomFetch Yolu (Offline Synthetic)', () => {
    it('8.1. Bilinen anahtar prodüksiyon remote JWKS / customFetch yoluyla başarıyla doğrulanmalıdır', async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const targetUrl =
          typeof url === 'string' ? url : url instanceof Request ? url.url : url.href;
        expect(targetUrl).toBe(TEST_JWKS_URL);
        return new Response(JSON.stringify({ keys: [primaryJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const verifier = createAccessVerifier({
        config: validConfig,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const token = await createValidToken();
      const principal = await verifier.verify(asAccessRequest(token));
      expect(principal.issuer).toBe(TEST_ISSUER);
      expect(principal.subject).toBe('usr-synthetic-worker-001');
      expect(mockFetch).toHaveBeenCalled();
    });

    it('8.2. Ağ arızasında (network failure) prodüksiyon remote JWKS fail-closed JWKS_FETCH_FAILED vermelidir', async () => {
      const mockFetch = vi.fn(async () => {
        throw new TypeError('Network connection refused (simulated)');
      });

      const verifier = createAccessVerifier({
        config: validConfig,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const token = await createValidToken();
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'JWKS_FETCH_FAILED' }),
      );
    });

    it('8.3. Bozuk JWKS yanıtında (malformed JSON) prodüksiyon remote JWKS fail-closed JWKS_FETCH_FAILED vermelidir', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response('<html>Error: Bad Gateway</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      const verifier = createAccessVerifier({
        config: validConfig,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const token = await createValidToken();
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'JWKS_FETCH_FAILED' }),
      );
    });

    it('8.4. HTTP yönlendirmelerinde (301/302/307 redirect) fail-closed JWKS_FETCH_FAILED ile reddedilmelidir', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://attacker.com/evil-jwks' },
        });
      });

      const verifier = createAccessVerifier({
        config: validConfig,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const token = await createValidToken();
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'JWKS_FETCH_FAILED' }),
      );
    });

    it('8.5. Yanlış anahtar durumunda (wrong key) fail-closed INVALID_SIGNATURE vermelidir', async () => {
      const fakePrimaryJwk = { ...secondaryJwk, kid: primaryKid };
      const mockFetch = vi.fn(async () => {
        return new Response(JSON.stringify({ keys: [fakePrimaryJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const verifier = createAccessVerifier({
        config: validConfig,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const token = await createValidToken();
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_SIGNATURE' }),
      );
    });

    it('8.6. Anahtar rotasyonu: Yeni kid geldiğinde remote JWKS fetch tetiklenmeli ve yenilenen anahtar ile doğrulanmalıdır', async () => {
      let fetchCount = 0;
      const mockFetch = vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return new Response(JSON.stringify({ keys: [primaryJwk] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ keys: [primaryJwk, secondaryJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const verifier = createAccessVerifier({
        config: validConfig,
        cooldownDurationMs: 0,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const oldToken = await createValidToken({}, { keyPair: primaryKeyPair, kid: primaryKid });
      const newToken = await createValidToken({}, { keyPair: secondaryKeyPair, kid: secondaryKid });

      await expect(verifier.verify(asAccessRequest(oldToken))).resolves.toBeDefined();
      expect(fetchCount).toBe(1);

      await expect(verifier.verify(asAccessRequest(newToken))).resolves.toBeDefined();
      expect(fetchCount).toBe(2);
    });

    it('8.7. createHardenedJwksFetch: Hedef URL sorgu dizesi (?query) veya parça (#hash) içerdiğinde fail-closed reddedilmelidir', async () => {
      const mockBaseFetch = vi.fn(async () => new Response('{}', { status: 200 }));
      const hardenedFetch = createHardenedJwksFetch(
        TEST_JWKS_URL,
        mockBaseFetch as unknown as typeof fetch,
      );

      const queryTarget = `${TEST_JWKS_URL}?attacker_token=secret123`;
      await expect(
        hardenedFetch(queryTarget, {
          headers: new Headers(),
          method: 'GET',
          redirect: 'manual',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrowError(/tam eşleşmiyor/);

      expect(mockBaseFetch).not.toHaveBeenCalled();

      const hashTarget = `${TEST_JWKS_URL}#evil_fragment`;
      await expect(
        hardenedFetch(hashTarget, {
          headers: new Headers(),
          method: 'GET',
          redirect: 'manual',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrowError(/tam eşleşmiyor/);

      expect(mockBaseFetch).not.toHaveBeenCalled();
    });

    it('8.8. JWKSMultipleMatchingKeys hatası JOSEError tarafından maskelenmeden doğrudan INVALID_TOKEN olarak eşlenmelidir', async () => {
      const mockResolver: AccessKeyResolver = async () => {
        throw new joseErrors.JWKSMultipleMatchingKeys('multiple matching keys found');
      };

      const verifier = createAccessVerifier({
        config: validConfig,
        keyResolver: mockResolver,
      });

      const token = await createValidToken();
      await expect(verifier.verify(asAccessRequest(token))).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_TOKEN' }),
      );
    });
  });
});
