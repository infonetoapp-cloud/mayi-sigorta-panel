// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  parseIdentityCryptoConfig,
  IdentityCryptoConfigError,
  encryptIdentity,
  decryptIdentity,
  computeIdentitySearchHash,
  validateIdentityFormat,
  IdentityDecryptionError,
} from '../src/server/security/identity-crypto';

describe('M2-T02 Identity Crypto & Server Config Provider', () => {
  // 32-byte keys (64 hex characters)
  const VALID_ENC_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const VALID_HMAC_KEY_HEX = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  const VALID_ENV = {
    IDENTITY_ENCRYPTION_KEY: VALID_ENC_KEY_HEX,
    IDENTITY_HMAC_KEY: VALID_HMAC_KEY_HEX,
    IDENTITY_KEY_VERSION: '1',
  };

  describe('parseIdentityCryptoConfig', () => {
    it('parses valid 64-hex configuration with key version', () => {
      const config = parseIdentityCryptoConfig(VALID_ENV);
      expect(config.keyVersion).toBe(1);
      expect(config.encryptionKey).toBeDefined();
      expect(config.hmacKey).toBeDefined();
    });

    it('defaults keyVersion to 1 if not provided', () => {
      const config = parseIdentityCryptoConfig({
        IDENTITY_ENCRYPTION_KEY: VALID_ENC_KEY_HEX,
        IDENTITY_HMAC_KEY: VALID_HMAC_KEY_HEX,
      });
      expect(config.keyVersion).toBe(1);
    });

    it('fails closed when IDENTITY_ENCRYPTION_KEY is missing', () => {
      expect(() =>
        parseIdentityCryptoConfig({
          IDENTITY_HMAC_KEY: VALID_HMAC_KEY_HEX,
        }),
      ).toThrowError(IdentityCryptoConfigError);
    });

    it('fails closed when IDENTITY_HMAC_KEY is missing', () => {
      expect(() =>
        parseIdentityCryptoConfig({
          IDENTITY_ENCRYPTION_KEY: VALID_ENC_KEY_HEX,
        }),
      ).toThrowError(IdentityCryptoConfigError);
    });

    it('fails closed when key is too short or malformed', () => {
      expect(() =>
        parseIdentityCryptoConfig({
          IDENTITY_ENCRYPTION_KEY: 'too-short',
          IDENTITY_HMAC_KEY: VALID_HMAC_KEY_HEX,
        }),
      ).toThrowError(IdentityCryptoConfigError);
    });

    it('rejects reuse of the encryption key as the HMAC key', () => {
      expect(() =>
        parseIdentityCryptoConfig({
          IDENTITY_ENCRYPTION_KEY: VALID_ENC_KEY_HEX,
          IDENTITY_HMAC_KEY: VALID_ENC_KEY_HEX,
          IDENTITY_KEY_VERSION: '1',
        }),
      ).toThrowError(IdentityCryptoConfigError);
    });
  });

  describe('AES-256-GCM Encryption & Decryption', () => {
    const config = parseIdentityCryptoConfig(VALID_ENV);

    it('encrypts and decrypts round-trip successfully', async () => {
      const plaintext = '12345678901';
      const envelope = await encryptIdentity(plaintext, config);

      expect(envelope.ciphertext).toBeDefined();
      expect(envelope.iv).toBeDefined();
      expect(envelope.tag).toBeDefined();
      expect(envelope.keyVersion).toBe(1);
      expect(envelope.searchHash).toBeDefined();

      // Plaintext must NOT appear in ciphertext, IV, tag, or searchHash
      expect(envelope.ciphertext).not.toContain(plaintext);
      expect(envelope.iv).not.toContain(plaintext);
      expect(envelope.tag).not.toContain(plaintext);
      expect(envelope.searchHash).not.toContain(plaintext);

      const decrypted = await decryptIdentity(
        {
          ciphertext: envelope.ciphertext,
          iv: envelope.iv,
          tag: envelope.tag,
          keyVersion: envelope.keyVersion,
        },
        config,
      );

      expect(decrypted).toBe(plaintext);
    });

    it('generates distinct IV and ciphertext for identical plaintexts (probabilistic encryption)', async () => {
      const plaintext = '12345678901';
      const env1 = await encryptIdentity(plaintext, config);
      const env2 = await encryptIdentity(plaintext, config);

      expect(env1.iv).not.toBe(env2.iv);
      expect(env1.ciphertext).not.toBe(env2.ciphertext);
      // But deterministic search hash must be identical
      expect(env1.searchHash).toBe(env2.searchHash);
    });

    it('fails closed without leaking raw crypto exceptions when ciphertext is tampered', async () => {
      const envelope = await encryptIdentity('12345678901', config);
      const tamperedCiphertext =
        envelope.ciphertext.substring(0, envelope.ciphertext.length - 2) +
        (envelope.ciphertext.endsWith('00') ? 'ff' : '00');

      await expect(
        decryptIdentity(
          {
            ciphertext: tamperedCiphertext,
            iv: envelope.iv,
            tag: envelope.tag,
            keyVersion: envelope.keyVersion,
          },
          config,
        ),
      ).rejects.toThrowError(IdentityDecryptionError);
    });

    it('fails closed when tag is tampered', async () => {
      const envelope = await encryptIdentity('12345678901', config);
      const tamperedTag =
        envelope.tag.substring(0, envelope.tag.length - 2) +
        (envelope.tag.endsWith('00') ? 'ff' : '00');

      await expect(
        decryptIdentity(
          {
            ciphertext: envelope.ciphertext,
            iv: envelope.iv,
            tag: tamperedTag,
            keyVersion: envelope.keyVersion,
          },
          config,
        ),
      ).rejects.toThrowError(IdentityDecryptionError);
    });

    it('fails closed when key version does not match active config', async () => {
      const envelope = await encryptIdentity('12345678901', config);

      await expect(
        decryptIdentity(
          {
            ciphertext: envelope.ciphertext,
            iv: envelope.iv,
            tag: envelope.tag,
            keyVersion: 999, // Unknown key version
          },
          config,
        ),
      ).rejects.toThrowError(IdentityDecryptionError);
    });

    it('fails closed when decrypted with a different key', async () => {
      const envelope = await encryptIdentity('12345678901', config);
      const otherConfig = parseIdentityCryptoConfig({
        IDENTITY_ENCRYPTION_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        IDENTITY_HMAC_KEY: VALID_HMAC_KEY_HEX,
        IDENTITY_KEY_VERSION: '1',
      });

      await expect(
        decryptIdentity(
          {
            ciphertext: envelope.ciphertext,
            iv: envelope.iv,
            tag: envelope.tag,
            keyVersion: envelope.keyVersion,
          },
          otherConfig,
        ),
      ).rejects.toThrowError(IdentityDecryptionError);
    });
  });

  describe('Deterministic HMAC-SHA-256 Exact Search Index', () => {
    const config = parseIdentityCryptoConfig(VALID_ENV);

    it('computes deterministic search hash for identical plaintexts', async () => {
      const hmac1 = await computeIdentitySearchHash('12345678901', config);
      const hmac2 = await computeIdentitySearchHash('12345678901', config);
      expect(hmac1).toBe(hmac2);
      expect(hmac1).toHaveLength(64); // 32 bytes hex
    });

    it('computes different search hashes for different plaintexts', async () => {
      const hmac1 = await computeIdentitySearchHash('12345678901', config);
      const hmac2 = await computeIdentitySearchHash('12345678902', config);
      expect(hmac1).not.toBe(hmac2);
    });

    it('computes different search hashes for different HMAC keys', async () => {
      const otherConfig = parseIdentityCryptoConfig({
        IDENTITY_ENCRYPTION_KEY: VALID_ENC_KEY_HEX,
        IDENTITY_HMAC_KEY: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      });
      const hmac1 = await computeIdentitySearchHash('12345678901', config);
      const hmac2 = await computeIdentitySearchHash('12345678901', otherConfig);
      expect(hmac1).not.toBe(hmac2);
    });
  });

  describe('validateIdentityFormat', () => {
    it('validates TCKN shape: 11 numeric digits', () => {
      expect(validateIdentityFormat('TCKN', '12345678901')).toBe(true);
      expect(validateIdentityFormat('TCKN', '1234567890')).toBe(false); // 10 digits
      expect(validateIdentityFormat('TCKN', '123456789012')).toBe(false); // 12 digits
      expect(validateIdentityFormat('TCKN', '1234567890a')).toBe(false); // non-numeric
      expect(validateIdentityFormat('TCKN', '')).toBe(false);
    });

    it('validates VKN shape: 10 numeric digits', () => {
      expect(validateIdentityFormat('VKN', '1234567890')).toBe(true);
      expect(validateIdentityFormat('VKN', '123456789')).toBe(false); // 9 digits
      expect(validateIdentityFormat('VKN', '12345678901')).toBe(false); // 11 digits
      expect(validateIdentityFormat('VKN', '123456789x')).toBe(false); // non-numeric
      expect(validateIdentityFormat('VKN', '')).toBe(false);
    });
  });
});
