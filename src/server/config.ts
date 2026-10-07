import { z } from 'zod';

/**
 * Sunucu-Özel Yapılandırma Sınırı (Server-Only Configuration Boundary).
 *
 * KRİTİK GÜVENLİK KURALI:
 * Bu modül YALNIZCA sunucu çalışma zamanında (Cloudflare Worker) içe aktarılabilir.
 * `src/app` veya `src/shared` altından içe aktarılması mimari sınır ihlalidir ve
 * otomatik denetim mekanizmaları (scripts/verify-boundaries.mjs ve vite.config.ts)
 * tarafından derleme ve test aşamasında engellenir.
 */

// Sınır ve izolasyon denetimlerinde istemci demetine (client bundle) sızmadığını
// doğrulamak amacıyla kullanılan sentetik gizli işaretçi:
export const SYNTHETIC_SERVER_SECRET_MARKER =
  'SYNTHETIC_SERVER_SECRET_MARKER_DO_NOT_LEAK_INTO_CLIENT_BUNDLE' as const;

function isValidCanonicalHttpsOrigin(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  if (!value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '' || url.pathname === '/') &&
      !value.endsWith('/') &&
      url.search === '' &&
      url.hash === '' &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

export const ServerConfigSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  SYNTHETIC_SECRET_KEY: z.string().min(1).default(SYNTHETIC_SERVER_SECRET_MARKER),
  PANEL_ORIGIN: z
    .string()
    .refine(
      isValidCanonicalHttpsOrigin,
      'PANEL_ORIGIN geçerli ve kanonik bir HTTPS origin olmalıdır (yol, sorgu veya kimlik bilgisi içeremez).',
    )
    .default('https://panel.mayisigorta.com'),
});

export const CsrfConfigSchema = z.object({
  CSRF_SECRET: z.string().min(32),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type CsrfConfig = z.infer<typeof CsrfConfigSchema>;

export function parseServerConfig(env: Record<string, unknown> = {}): ServerConfig {
  const result = ServerConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`[Geçersiz Sunucu Yapılandırması] ${JSON.stringify(result.error.format())}`);
  }
  return result.data;
}

export function parseCsrfConfig(env: Record<string, unknown> = {}): CsrfConfig {
  const result = CsrfConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error('[Geçersiz CSRF Yapılandırması] CSRF secret eksik veya geçersiz.');
  }
  return result.data;
}

// F-27: no Access configuration is part of the active Worker configuration contract.
