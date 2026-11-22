import { z } from 'zod';
import { parseServerConfig } from '../config';

const configSchema = z.object({
  TURNSTILE_SITE_KEY: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  TURNSTILE_SECRET: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
});

export function loginTurnstileConfig(env: Record<string, unknown>) {
  const { APP_ENV, PANEL_ORIGIN } = parseServerConfig(env);
  if (
    APP_ENV !== 'production' &&
    env.TURNSTILE_SITE_KEY === undefined &&
    env.TURNSTILE_SECRET === undefined
  )
    return null;

  const result = configSchema.safeParse(env);
  if (!result.success) throw new Error('TURNSTILE_CONFIGURATION_UNAVAILABLE');
  return {
    siteKey: result.data.TURNSTILE_SITE_KEY,
    secret: result.data.TURNSTILE_SECRET,
    hostname: new URL(PANEL_ORIGIN).hostname,
  };
}

type LoginTurnstileConfig = NonNullable<ReturnType<typeof loginTurnstileConfig>>;

export async function verifyLoginTurnstile(
  config: LoginTurnstileConfig,
  token: string,
): Promise<boolean> {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: config.secret, response: token }),
    signal: AbortSignal.timeout(4_000),
    // Workers rejects the Fetch "error" mode. Manual redirects keep the secret on Siteverify.
    redirect: 'manual',
  });
  if (!response.ok) throw new Error('TURNSTILE_VERIFICATION_UNAVAILABLE');

  const result = (await response.json()) as {
    success?: unknown;
    hostname?: unknown;
    action?: unknown;
  } | null;
  if (typeof result?.success !== 'boolean') throw new Error('TURNSTILE_VERIFICATION_UNAVAILABLE');
  // Siteverify enforces the five-minute lifetime and consumes the token once.
  return result.success && result.hostname === config.hostname && result.action === 'crm_login';
}
