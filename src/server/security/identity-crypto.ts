import { z } from 'zod';

/**
 * Mayı Sigorta CRM — Sunucu Kimlik Kripto ve Yapılandırma Sağlayıcısı (M2-T02)
 *
 * KRİTİK GÜVENLİK KURALLARI:
 * 1. Sunucuya özeldir; istemciye veya paylaşılan modüllere sızdırılamaz.
 * 2. Web Crypto API standartlarına uygundur (Cloudflare Worker uyumlu).
 * 3. AES-256-GCM kimlik doğrulamalı şifreleme ve deterministik HMAC-SHA-256 arama indeksi
 *    birbirinden tamamen bağımsız iki ayrı sunucu anahtarı kullanır.
 * 4. Sabit kodlu (hardcoded) veya fallback anahtar kesinlikle yasaktır.
 * 5. Anahtarlar veritabanına, istemciye, loglara, denetim izine veya makbuza ASLA yazılamaz.
 * 6. Şifre çözme veya doğrulama hataları ham sistem istisnalarını dışarı sızdırmadan fail-closed kapanır.
 */

export class IdentityCryptoConfigError extends Error {
  readonly code: string;

  constructor(message: string, code = 'IDENTITY_CONFIG_ERROR') {
    super(`[${code}] ${message}`);
    this.name = 'IdentityCryptoConfigError';
    this.code = code;
  }
}

export class IdentityDecryptionError extends Error {
  readonly code: string;

  constructor(message = 'Kimlik bilgisi şifresi çözülemedi.', code = 'IDENTITY_DECRYPTION_FAILED') {
    super(`[${code}] ${message}`);
    this.name = 'IdentityDecryptionError';
    this.code = code;
  }
}

export interface IdentityCryptoConfig {
  readonly encryptionKey: Uint8Array;
  readonly hmacKey: Uint8Array;
  readonly keyVersion: number;
}

export interface EncryptedIdentityEnvelope {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly searchHash: string;
  readonly keyVersion: number;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Geçersiz onaltılık (hex) dizge uzunluğu.');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error('Geçersiz onaltılık (hex) karakteri.');
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function parse32ByteKey(raw: unknown, name: string): Uint8Array {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new IdentityCryptoConfigError(`${name} yapılandırması eksik veya boş.`);
  }

  const trimmed = raw.trim();

  // 1. 64-karakter Hex biçimi (32 bayt)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }

  // 2. Base64 biçimi (44 karakter, 32 bayt)
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed) || /^[A-Za-z0-9+/]{42}==$/.test(trimmed)) {
    try {
      const bin = atob(trimmed);
      if (bin.length === 32) {
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
          bytes[i] = bin.charCodeAt(i);
        }
        return bytes;
      }
    } catch {
      // Base64 çözümleme hatası
    }
  }

  // 3. 32-baytlık UTF-8 dizesi (tam 32 bayt uzunluğunda)
  const utf8Bytes = new TextEncoder().encode(trimmed);
  if (utf8Bytes.length === 32) {
    return utf8Bytes;
  }

  throw new IdentityCryptoConfigError(
    `${name} 32 baytlık (64 onaltılık karakter, 44 karakter base64 veya 32 karakterlik dize) olmalıdır.`,
  );
}

const IdentityConfigEnvSchema = z.object({
  IDENTITY_ENCRYPTION_KEY: z.string().min(1),
  IDENTITY_HMAC_KEY: z.string().min(1),
  IDENTITY_KEY_VERSION: z.coerce.number().int().min(1).default(1),
});

/**
 * Kimlik şifreleme ve HMAC yapılandırmasını ortam değişkenlerinden fail-closed olarak ayrıştırır.
 */
export function parseIdentityCryptoConfig(env: Record<string, unknown> = {}): IdentityCryptoConfig {
  const result = IdentityConfigEnvSchema.safeParse(env);
  if (!result.success) {
    throw new IdentityCryptoConfigError(
      'Kimlik şifreleme anahtarları eksik veya geçersiz yapılandırılmış.',
    );
  }

  const { IDENTITY_ENCRYPTION_KEY, IDENTITY_HMAC_KEY, IDENTITY_KEY_VERSION } = result.data;
  const encryptionKey = parse32ByteKey(IDENTITY_ENCRYPTION_KEY, 'IDENTITY_ENCRYPTION_KEY');
  const hmacKey = parse32ByteKey(IDENTITY_HMAC_KEY, 'IDENTITY_HMAC_KEY');
  let keyDifference = 0;
  for (let index = 0; index < encryptionKey.length; index += 1) {
    keyDifference |= encryptionKey[index]! ^ hmacKey[index]!;
  }
  if (keyDifference === 0) {
    throw new IdentityCryptoConfigError(
      'Şifreleme ve HMAC anahtarları birbirinden bağımsız olmalıdır.',
      'IDENTITY_KEY_REUSE_FORBIDDEN',
    );
  }

  return Object.freeze({
    encryptionKey,
    hmacKey,
    keyVersion: IDENTITY_KEY_VERSION,
  });
}

/**
 * TCKN veya VKN format biçimini sınar.
 * NOT: Format geçerliliği kimlik numarasının gerçekliğinin kanıtı değildir.
 */
export function validateIdentityFormat(type: 'TCKN' | 'VKN', value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (type === 'TCKN') {
    return /^\d{11}$/.test(trimmed);
  }
  if (type === 'VKN') {
    return /^\d{10}$/.test(trimmed);
  }
  return false;
}

/**
 * Deterministik anahtarlı HMAC-SHA-256 arama özetini hesaplar.
 */
export async function computeIdentitySearchHash(
  plaintext: string,
  config: IdentityCryptoConfig,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(config.hmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const data = new TextEncoder().encode(plaintext.trim());
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, toArrayBuffer(data));
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Düz metin kimlik numarasını AES-256-GCM ile şifreler ve arama özetini türetir.
 */
export async function encryptIdentity(
  plaintext: string,
  config: IdentityCryptoConfig,
): Promise<EncryptedIdentityEnvelope> {
  const trimmedPlaintext = plaintext.trim();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit standart GCM IV

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(config.encryptionKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const encoded = new TextEncoder().encode(trimmedPlaintext);
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: 128 },
    cryptoKey,
    toArrayBuffer(encoded),
  );

  const totalLength = encryptedBuffer.byteLength;
  const ciphertextBytes = new Uint8Array(encryptedBuffer, 0, totalLength - 16);
  const tagBytes = new Uint8Array(encryptedBuffer, totalLength - 16, 16);

  const searchHash = await computeIdentitySearchHash(trimmedPlaintext, config);

  return {
    ciphertext: bytesToHex(ciphertextBytes),
    iv: bytesToHex(iv),
    tag: bytesToHex(tagBytes),
    searchHash,
    keyVersion: config.keyVersion,
  };
}

/**
 * AES-256-GCM şifreli kimlik zarfını çözer.
 * Herhangi bir sürüm uyumsuzluğunda, doğrulama hatasında veya geçersiz veride
 * fail-closed olarak IdentityDecryptionError fırlatır; ham hata sızdırmaz.
 */
export async function decryptIdentity(
  envelope: {
    ciphertext: string;
    iv: string;
    tag: string;
    keyVersion: number;
  },
  config: IdentityCryptoConfig,
): Promise<string> {
  if (envelope.keyVersion !== config.keyVersion) {
    throw new IdentityDecryptionError('Anahtar sürümü uyuşmuyor.');
  }

  try {
    const ciphertextBytes = hexToBytes(envelope.ciphertext);
    const ivBytes = hexToBytes(envelope.iv);
    const tagBytes = hexToBytes(envelope.tag);

    if (ivBytes.length !== 12 || tagBytes.length !== 16) {
      throw new IdentityDecryptionError('Geçersiz IV veya kimlik doğrulama etiketi boyutu.');
    }

    // Web Crypto AES-GCM birleşik ciphertext + tag bekler
    const combined = new Uint8Array(ciphertextBytes.length + tagBytes.length);
    combined.set(ciphertextBytes, 0);
    combined.set(tagBytes, ciphertextBytes.length);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(config.encryptionKey),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(ivBytes), tagLength: 128 },
      cryptoKey,
      toArrayBuffer(combined),
    );

    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    if (err instanceof IdentityDecryptionError) {
      throw err;
    }
    throw new IdentityDecryptionError();
  }
}

/**
 * Güvenli ve minimal maskeli kimlik gösterimi.
 * Varlık/tip/uzunluk sızıntısını önlerken kullanıcı arayüzünü destekler.
 */
export function maskIdentity(hasIdentity: boolean): string | null {
  return hasIdentity ? '***' : null;
}
