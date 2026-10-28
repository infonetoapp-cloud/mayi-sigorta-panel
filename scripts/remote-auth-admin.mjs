// Controlled operator composition only; never imported by the public Worker.
export const REMOTE_PROVIDER_ATOMICITY_STATUS = 'REMOTE_PROVIDER_ATOMICITY_PROOF_OPEN';

export function selectAdminAuthentication(env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const email = env.CLOUDFLARE_EMAIL;
  const key = env.CLOUDFLARE_API_KEY;
  const present = (value) => value !== undefined && value !== '';
  if (present(email) !== present(key)) throw new Error('PARTIAL_ADMIN_CREDENTIALS');
  if (present(token) && present(key)) throw new Error('AMBIGUOUS_ADMIN_CREDENTIALS');
  const valid = (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (present(token)) {
    if (!valid(token)) throw new Error('INVALID_ADMIN_CREDENTIALS');
    return Object.freeze({ Authorization: `Bearer ${token}` });
  }
  if (present(key)) {
    if (!valid(email) || !valid(key)) throw new Error('INVALID_ADMIN_CREDENTIALS');
    return Object.freeze({ 'X-Auth-Email': email, 'X-Auth-Key': key });
  }
  throw new Error('ADMINISTRATIVE_CREDENTIAL_REQUIRED');
}

/** Closed official origin and snapshotted exact target; no retry or auth fallback. */
export async function openRemoteAdminDatabase(
  target,
  env,
  fetch = (url, init) => globalThis.fetch(url, init),
) {
  const { accountId, databaseId } = target;
  if (
    typeof accountId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(accountId) ||
    typeof databaseId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(databaseId)
  )
    throw new Error('EXACT_REMOTE_TARGET_REQUIRED');
  const headers = Object.freeze({
    ...selectAdminAuthentication(env),
    'Content-Type': 'application/json',
  });
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
  async function request(url, method, body) {
    try {
      const response = await fetch(url, {
        method,
        headers: { ...headers },
        redirect: 'manual',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status >= 300 && response.status < 400)
        throw new Error('REMOTE_ADMIN_REDIRECT_REJECTED');
      if (!response.ok) throw new Error('REMOTE_ADMIN_REQUEST_FAILED');
      const data = await response.json();
      if (!data || data.success !== true) throw new Error('REMOTE_ADMIN_REQUEST_FAILED');
      return data.result;
    } catch (error) {
      // Never expose provider body, fetch exception, URL, headers or credentials.
      if (error?.message === 'REMOTE_ADMIN_REDIRECT_REJECTED')
        // eslint-disable-next-line preserve-caught-error -- provider causes may contain credentials
        throw new Error('REMOTE_ADMIN_REDIRECT_REJECTED');
      // eslint-disable-next-line preserve-caught-error -- deliberately discard secret-bearing causes
      throw new Error('REMOTE_ADMIN_REQUEST_FAILED');
    }
  }
  const metadata = await request(base, 'GET');
  if (!metadata || metadata.uuid !== databaseId) throw new Error('EXACT_REMOTE_D1_REQUIRED');
  const mfa = await request('https://api.cloudflare.com/client/v4/user', 'GET');
  if (
    !mfa ||
    mfa.two_factor_authentication_enabled !== true ||
    mfa.two_factor_authentication_locked !== true
  )
    throw new Error('ADMINISTRATIVE_MFA_REQUIRED');

  async function query(body, count) {
    const results = await request(`${base}/query`, 'POST', body);
    if (
      !Array.isArray(results) ||
      results.length !== count ||
      results.some((result) => !result || result.success !== true || !Array.isArray(result.results))
    )
      throw new Error('REMOTE_D1_OPERATION_FAILED');
    return results;
  }
  // Ownership and snapshots prevent foreign adapter statements or mutated bind arrays.
  const prepared = new WeakMap();
  function statement(sql, params = []) {
    if (typeof sql !== 'string' || !sql.trim()) throw new Error('INVALID_ADMIN_STATEMENT');
    const value = Object.freeze({
      bind(...bound) {
        if (
          bound.some(
            (p) =>
              p !== null && typeof p !== 'string' && (typeof p !== 'number' || !Number.isFinite(p)),
          )
        )
          throw new Error('INVALID_ADMIN_BINDING');
        return statement(sql, bound);
      },
      async first(column) {
        const row = (await query({ sql, params }, 1))[0].results[0] ?? null;
        if (column === undefined || row === null) return row;
        if (!Object.hasOwn(row, column)) throw new Error('ADMIN_COLUMN_NOT_FOUND');
        return row[column];
      },
      async all() {
        return (await query({ sql, params }, 1))[0];
      },
      async run() {
        return (await query({ sql, params }, 1))[0];
      },
    });
    prepared.set(value, Object.freeze({ sql, params: Object.freeze([...params]) }));
    return value;
  }
  return Object.freeze({
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      if (!Array.isArray(statements) || statements.length === 0)
        throw new Error('INVALID_ADMIN_BATCH');
      const batch = Array.from(statements, (stmt) => {
        const preparedStatement = prepared.get(stmt);
        if (!preparedStatement) throw new Error('INVALID_ADMIN_BATCH');
        return preparedStatement;
      });
      return query({ batch }, batch.length);
    },
  });
}
