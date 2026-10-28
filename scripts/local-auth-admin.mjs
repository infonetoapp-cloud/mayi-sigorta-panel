#!/usr/bin/env node
import { parseArgs } from 'node:util';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { createInterface } from 'node:readline/promises';
import { build } from 'esbuild';
import { getPlatformProxy, unstable_readConfig } from 'wrangler';
import miniflare from 'miniflare';
import { openRemoteAdminDatabase } from './remote-auth-admin.mjs';

// No password/token command argument or public endpoint. Agency-only mode loads no dotenv.
export function parseAdminArguments(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
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
  if (Boolean(values.local) === Boolean(values.remote))
    throw new Error('EXPLICIT_LOCAL_OR_REMOTE_REQUIRED');
  if (values.mode === 'provision-agency') {
    if (values.owner !== undefined || values.email !== undefined || values.name !== undefined)
      throw new Error('AGENCY_PROVISIONING_NO_OWNER_INPUT');
  }
  return values;
}

export function adminConfirmationTuple(target, prepareOwnerConfirmation) {
  if (target.mode === 'provision-agency')
    return `${target.mode}:${target.accountId}:${target.databaseId}:${target.agencyId}:${target.operationKey}`;
  if (typeof prepareOwnerConfirmation !== 'function')
    throw new Error('OWNER_CONFIRMATION_CANONICALIZER_REQUIRED');
  return prepareOwnerConfirmation(target).token;
}

// Agency-only D1 composition uses the accepted native local test/runtime pattern.
// Never loads Wrangler dev vars, cf metadata or unrelated resource bindings.
async function openLocalAgencyDatabase(databaseId, persistTo) {
  const { Miniflare, convertV4MiniflareOptions } = miniflare;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {}',
      cf: false,
      d1Databases: { DB: databaseId },
      resourcePersistencePath: persistTo,
    }),
  );
  try {
    return { db: await mf.getD1Database('DB'), dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('TRUSTED_INTERACTIVE_TERMINAL_REQUIRED');
  const values = parseAdminArguments();
  const bundle = await build({
    entryPoints: ['src/server/auth/admin.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    write: false,
  });
  const {
    adminTargetSchema,
    initialAgencyTargetSchema,
    provisionInitialAgency,
    administerLocalOwner,
    assertLocalAdminBinding,
    prepareOwnerConfirmation,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const agencyOnly = values.mode === 'provision-agency';
  const common = {
    mode: values.mode,
    accountId: values.account,
    databaseId: values.d1,
    agencyId: values.agency,
    operationKey: values.key,
  };
  const inputTarget = agencyOnly
    ? initialAgencyTargetSchema.parse(common)
    : adminTargetSchema.parse({
        ...common,
        ownerUserId: values.owner,
        email: values.email,
        name: values.name,
      });
  const target = agencyOnly ? inputTarget : prepareOwnerConfirmation(inputTarget).target;
  const expectedConfirmation = adminConfirmationTuple(target, prepareOwnerConfirmation);
  const ownerReview = agencyOnly ? '' : `Owner display name: ${JSON.stringify(target.name)}\n`;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `${ownerReview}Tam hedefi ve Cloudflare administrative MFA kontrolünü doğrulayın. ${expectedConfirmation} yazın: `,
    );
    if (answer !== expectedConfirmation) throw new Error('OPERATOR_CONFIRMATION_REQUIRED');
  } finally {
    prompt.close();
  }
  let db, dispose;
  if (values.local) {
    if (!values.config || !values['persist-to'])
      throw new Error('EXACT_LOCAL_CONFIG_AND_STATE_REQUIRED');
    assertLocalAdminBinding(unstable_readConfig({ config: values.config }), target);
    if (agencyOnly) {
      ({ db, dispose } = await openLocalAgencyDatabase(target.databaseId, values['persist-to']));
    } else {
      const platform = await getPlatformProxy({
        configPath: values.config,
        envFiles: [],
        persist: { path: values['persist-to'] },
        remoteBindings: false,
      });
      db = platform.env.DB;
      dispose = platform.dispose;
    }
    if (!db) throw new Error('EXACT_D1_BINDING_REQUIRED');
  } else {
    db = await openRemoteAdminDatabase(target, process.env);
  }
  try {
    if (agencyOnly) {
      const result = await provisionInitialAgency(db, target);
      process.stdout.write(
        `Acente PROVISIONING: ${result.agencyId}; işlem ${result.outcome}; correlation ${result.correlationId}. OWNER veya şifre oluşturulmadı.\n`,
      );
      return;
    }
    const result = await administerLocalOwner(db, target);
    // Exactly one successful trusted-terminal display; never receipt/retrieval/log/file output.
    process.stdout.write(
      `Geçici şifre (yalnız bir kez): ${result.temporaryPassword}\nSon kullanım: ${result.expiresAt}\nİlk girişte yeni şifre belirlenmelidir. Kaybolursa yeni işlem anahtarıyla break-glass kullanın.\n`,
    );
  } finally {
    await dispose?.();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    process.stderr.write(
      'Yönetim işlemi reddedildi veya tamamlanamadı. Ayrıntı/secret loglanmadı.\n',
    );
    process.exitCode = 1;
  });
