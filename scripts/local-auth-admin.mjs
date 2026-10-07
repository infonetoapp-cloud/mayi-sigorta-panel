#!/usr/bin/env node
import { parseArgs } from 'node:util';
import process from 'node:process';
import { Buffer } from 'node:buffer';

import { createInterface } from 'node:readline/promises';
import { build } from 'esbuild';
import { getPlatformProxy, unstable_readConfig } from 'wrangler';
const { fetch } = globalThis;

// No password/token command argument, dotenv file, persistence of plaintext or public endpoint.
async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      account: { type: 'string' },
      d1: { type: 'string' },
      agency: { type: 'string' },
      owner: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      key: { type: 'string' },
      remote: { type: 'boolean' },
      local: { type: 'boolean' },
      config: { type: 'string' },
      'persist-to': { type: 'string' },
    },
    strict: true,
  });
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('TRUSTED_INTERACTIVE_TERMINAL_REQUIRED');
  if (Boolean(values.local) === Boolean(values.remote))
    throw new Error('EXPLICIT_LOCAL_OR_REMOTE_REQUIRED');
  const bundle = await build({
    entryPoints: ['src/server/auth/admin.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    write: false,
  });
  const { adminTargetSchema, administerLocalOwner, assertLocalAdminBinding } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const target = adminTargetSchema.parse({
    mode: values.mode,
    accountId: values.account,
    databaseId: values.d1,
    agencyId: values.agency,
    ownerUserId: values.owner,
    email: values.email,
    name: values.name,
    operationKey: values.key,
  });
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `Tam hedefi ve Cloudflare administrative MFA kontrolünü doğrulayın. ${target.mode}:${target.accountId}:${target.databaseId}:${target.agencyId}:${target.ownerUserId} yazın: `,
    );
    if (
      answer !==
      `${target.mode}:${target.accountId}:${target.databaseId}:${target.agencyId}:${target.ownerUserId}`
    )
      throw new Error('OPERATOR_CONFIRMATION_REQUIRED');
  } finally {
    prompt.close();
  }
  let db, dispose;
  if (values.local) {
    if (!values.config || !values['persist-to'])
      throw new Error('EXACT_LOCAL_CONFIG_AND_STATE_REQUIRED');
    assertLocalAdminBinding(unstable_readConfig({ config: values.config }), target);
    const platform = await getPlatformProxy({
      configPath: values.config,
      envFiles: [],
      persist: { path: values['persist-to'] },
      remoteBindings: false,
    });
    db = platform.env.DB;
    dispose = platform.dispose;
    if (!db) throw new Error('EXACT_D1_BINDING_REQUIRED');
  } else {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) throw new Error('ADMINISTRATIVE_CREDENTIAL_REQUIRED');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const base = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}`;
    const metadata = await fetch(base, { headers, redirect: 'error' });
    const details = await metadata.json();
    if (!metadata.ok || !details.success || details.result?.uuid !== target.databaseId)
      throw new Error('EXACT_REMOTE_D1_REQUIRED');
    const mfaResponse = await fetch('https://api.cloudflare.com/client/v4/user', {
      headers,
      redirect: 'error',
    });
    const mfa = await mfaResponse.json();
    if (
      !mfaResponse.ok ||
      !mfa.success ||
      mfa.result?.two_factor_authentication_enabled !== true ||
      mfa.result?.two_factor_authentication_locked !== true
    )
      throw new Error('ADMINISTRATIVE_MFA_REQUIRED');
    async function query(body) {
      const response = await fetch(`${base}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
      });
      const data = await response.json();
      if (
        !response.ok ||
        data.success !== true ||
        !Array.isArray(data.result) ||
        data.result.some((r) => r.success !== true)
      )
        throw new Error('REMOTE_D1_OPERATION_FAILED');
      return data.result;
    }
    db = {
      prepare(sql) {
        let params = [];
        return {
          sql,
          get params() {
            return params;
          },
          bind(...bound) {
            params = bound;
            return this;
          },
          async first() {
            return (await query({ sql, params }))[0].results?.[0] ?? null;
          },
          async all() {
            return (await query({ sql, params }))[0];
          },
          async run() {
            return (await query({ sql, params }))[0];
          },
        };
      },
      async batch(statements) {
        return query({ batch: statements.map((s) => ({ sql: s.sql, params: s.params })) });
      },
    };
  }
  try {
    const result = await administerLocalOwner(db, target);
    // Exactly one successful trusted-terminal display; never receipt/retrieval/log/file output.
    process.stdout.write(
      `Geçici şifre (yalnız bir kez): ${result.temporaryPassword}\nSon kullanım: ${result.expiresAt}\nİlk girişte yeni şifre belirlenmelidir. Kaybolursa yeni işlem anahtarıyla break-glass kullanın.\n`,
    );
  } finally {
    await dispose?.();
  }
}
main().catch(() => {
  process.stderr.write(
    'Yönetim işlemi reddedildi veya tamamlanamadı. Ayrıntı/secret loglanmadı.\n',
  );
  process.exitCode = 1;
});
