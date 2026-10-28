type Limiter = Pick<RateLimit, 'limit'>;
export async function documentRateDecision(
  env: {
    APP_ENV?: string;
    DOCUMENT_UPLOAD_RATE_LIMITER?: Limiter;
    DOCUMENT_DOWNLOAD_RATE_LIMITER?: Limiter;
  },
  actor: { userId: string; memberships: ReadonlyArray<{ agencyId: string }> },
  kind: 'UPLOAD' | 'DOWNLOAD',
): Promise<'ALLOW' | 'LIMITED' | 'UNAVAILABLE'> {
  const limiter =
    kind === 'UPLOAD' ? env.DOCUMENT_UPLOAD_RATE_LIMITER : env.DOCUMENT_DOWNLOAD_RATE_LIMITER;
  if (!limiter) return env.APP_ENV === 'production' ? 'UNAVAILABLE' : 'ALLOW';
  try {
    const agency = actor.memberships[0]?.agencyId;
    if (!agency || !actor.userId) return 'UNAVAILABLE';
    const value = await limiter.limit({ key: `document:${kind}:${agency}:${actor.userId}` });
    return value.success === true ? 'ALLOW' : value.success === false ? 'LIMITED' : 'UNAVAILABLE';
  } catch {
    return 'UNAVAILABLE';
  }
}
