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

export const ServerConfigSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  CF_ACCESS_TEAM_DOMAIN: z.string().min(1).default('mayisigorta.cloudflareaccess.com'),
  CF_ACCESS_AUDIENCE: z.string().min(1).default('synthetic-access-audience-placeholder'),
  CF_ACCESS_SECURE_AUDIENCE: z.string().min(1).default('synthetic-secure-audience-placeholder'),
  SYNTHETIC_SECRET_KEY: z.string().min(1).default(SYNTHETIC_SERVER_SECRET_MARKER),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function parseServerConfig(env: Record<string, unknown> = {}): ServerConfig {
  const result = ServerConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`[Geçersiz Sunucu Yapılandırması] ${JSON.stringify(result.error.format())}`);
  }
  return result.data;
}
