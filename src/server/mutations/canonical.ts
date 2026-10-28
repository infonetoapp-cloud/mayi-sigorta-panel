/**
 * Mayı Sigorta CRM — Kanonik Payload & Parmak İzi Yardımcısı (M1-T09)
 *
 * Deterministik JSON serileştirme ve SHA-256 hash hesaplama.
 * Nesne anahtarları alfabetik olarak sıralanır; dizi eleman sırası korunur.
 */

const MAX_DEPTH = 16;
const MAX_PAYLOAD_BYTES = 65536;

function sortValue(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (depth > MAX_DEPTH) {
    throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
  }

  if (value === undefined) {
    throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
    }
    return value;
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
  }

  if (typeof value === 'object') {
    if (ancestors.has(value)) {
      throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
    }

    if (Array.isArray(value)) {
      ancestors.add(value);
      try {
        const len = value.length;
        const result: unknown[] = new Array(len);
        for (let i = 0; i < len; i++) {
          if (!(i in value)) {
            throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
          }
          const desc = Object.getOwnPropertyDescriptor(value, String(i));
          if (desc && (desc.get || desc.set)) {
            throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
          }
          result[i] = sortValue(value[i], depth + 1, ancestors);
        }
        return result;
      } finally {
        ancestors.delete(value);
      }
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
    }

    ancestors.add(value);
    try {
      const symbolKeys = Object.getOwnPropertySymbols(value);
      if (symbolKeys.length > 0) {
        throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
      }

      const stringKeys = Object.getOwnPropertyNames(value).sort();
      const sortedObj: Record<string, unknown> = {};

      for (const key of stringKeys) {
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc) {
          throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
        }
        if (desc.get || desc.set) {
          throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
        }
        if (
          desc.value === undefined ||
          typeof desc.value === 'function' ||
          typeof desc.value === 'symbol'
        ) {
          throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
        }
        sortedObj[key] = sortValue(desc.value, depth + 1, ancestors);
      }
      return sortedObj;
    } finally {
      ancestors.delete(value);
    }
  }

  throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
}

export function canonicalizePayload(payload: unknown): string {
  const ancestors = new Set<object>();
  const sorted = sortValue(payload, 0, ancestors);
  const serialized = JSON.stringify(sorted);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error('CANONICAL_PAYLOAD_TOO_LARGE');
  }
  return serialized;
}

export async function computePayloadHash(payload: unknown): Promise<string> {
  const canonicalString = canonicalizePayload(payload);
  const data = new TextEncoder().encode(canonicalString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
