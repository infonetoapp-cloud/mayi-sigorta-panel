import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import miniflare from 'miniflare';
import { z } from 'zod';
import { canonicalizePayload } from '../../src/server/mutations/canonical';
import { RESTORE_LIMITS } from './local-restore-proof';
import { orderedD1Import, OrderedImportFailure } from './ordered-d1-import';

// Offline SYNTHETIC proof only: no caller-supplied target, account, remote binding or credentials.
export const AUTH_RESTORE_SCHEMA_HASH =
  '335c292d19625658f789a09b9657730bb95a7db26bc5ac8b11f076d356a90a6f';
const SOURCE_ID = 'synthetic-local-auth-source';
const ISO = '2026-09-01T00:00:00.000Z';
export const SYNTHETIC_AUTH_TIME = Date.parse(ISO);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);
const scalar = z.union([z.string(), z.number().int().safe(), z.null()]);
const definition = z.strictObject({
  type: z.enum(['table', 'index', 'trigger', 'view']),
  name: z.string(),
  tbl_name: z.string(),
  sql: z.string().nullable(),
});
const artifactSchema = z.strictObject({
  format: z.literal('mayi-synthetic-auth-export-v1'),
  sourceId: z.literal(SOURCE_ID),
  schema: z.array(definition).max(1000),
  data: z.record(identifier, z.array(z.record(identifier, scalar)).max(1000)),
});
type Artifact = z.infer<typeof artifactSchema>;
export type AuthBackupArtifact = Artifact;
const manifestSchema = z.strictObject({
  format: z.literal('mayi-local-auth-manifest-v1'),
  classification: z.literal('SYNTHETIC/LOCAL'),
  createdBy: z.literal('local-auth-restore-proof'),
  sourceId: z.literal(SOURCE_ID),
  appVersion: z.literal('0.1.0'),
  createdAt: z.literal(ISO),
  bookmark: z.literal('synthetic-paused-native-export'),
  schemaVersion: z.literal('0020'),
  highestMigration: z.literal('0020_local_authentication.sql'),
  history: z
    .array(z.strictObject({ id: z.number().int(), name: z.string(), sourceSha256: digest }))
    .length(21),
  counts: z.strictObject({
    table: z.literal(44),
    index: z.literal(171),
    trigger: z.literal(176),
    view: z.literal(3),
  }),
  schemaHash: digest,
  rowCounts: z.record(identifier, z.number().int().nonnegative()),
  fingerprints: z.record(identifier, digest),
  artifactSha256: digest,
  completion: z.literal('COMPLETE'),
});
export type AuthRestoreManifest = z.infer<typeof manifestSchema>;
export interface SyntheticAuthBackup {
  artifactJson: string;
  manifest: AuthRestoreManifest;
  manifestSha256: string;
}
const SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND name<>'sqlite_sequence' ORDER BY type,name";
const files = () =>
  readdirSync('db/migrations')
    .filter((n) => /^\d{4}_.+\.sql$/.test(n))
    .sort();
const migrations = () =>
  files().map((name, i) => ({
    id: i + 1,
    name,
    sourceSha256: sha(readFileSync(resolve('db/migrations', name), 'utf8')),
  }));

// Same narrowly scoped lexical canonicalization as the accepted transport-equivalence proof:
// whitespace/comments and SELECT (CASE ... END) grouping only; identifiers/literals retained.
function sqlTokens(sql: string) {
  const ts =
    sql
      .match(
        /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\S/g,
      )
      ?.filter((t) => !t.startsWith('--') && !t.startsWith('/*')) ?? [];
  const remove = new Set<number>();
  for (let i = 0; i < ts.length; i++) {
    if (
      ts[i]!.toUpperCase() !== 'SELECT' ||
      ts[i + 1] !== '(' ||
      ts[i + 2]?.toUpperCase() !== 'CASE'
    )
      continue;
    let depth = 1,
      j = i + 3;
    for (; j < ts.length; j++) {
      if (ts[j]!.toUpperCase() === 'CASE') depth++;
      else if (ts[j]!.toUpperCase() === 'END' && --depth === 0) break;
    }
    if (ts[j + 1] === ')') {
      remove.add(i + 1);
      remove.add(j + 1);
    }
  }
  return ts.filter((_, i) => !remove.has(i));
}
export function authSchemaHash(schema: Artifact['schema']) {
  const rows = schema
    .filter((r) => r.tbl_name !== 'd1_migrations')
    .map((r) => [r.type, r.name, r.tbl_name, r.sql === null ? null : sqlTokens(r.sql)] as const);
  rows.sort((a, b) => lexical(a[0], b[0]) || lexical(a[1], b[1]));
  return sha(JSON.stringify(rows));
}
function referenceSchema() {
  const ref = new DatabaseSync(':memory:');
  try {
    for (const name of files()) ref.exec(readFileSync(resolve('db/migrations', name), 'utf8'));
    // Exact installed official runner ledger; it is recovery history, not an application migration.
    ref.exec(
      'CREATE TABLE IF NOT EXISTS "d1_migrations"(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n);',
    );
    return ref.prepare(SCHEMA_SQL).all() as Artifact['schema'];
  } finally {
    ref.close();
  }
}
function orderedRows(rows: Artifact['data'][string]) {
  return rows
    .map((row) => JSON.parse(canonicalizePayload(row)) as typeof row)
    .sort((a, b) => lexical(canonicalizePayload(a), canonicalizePayload(b)));
}
function encode(artifact: Artifact) {
  const data: Artifact['data'] = {};
  for (const name of Object.keys(artifact.data).sort())
    data[name] = orderedRows(artifact.data[name]!);
  return JSON.stringify({
    format: artifact.format,
    sourceId: artifact.sourceId,
    schema: [...artifact.schema].sort((a, b) => lexical(a.type, b.type) || lexical(a.name, b.name)),
    data,
  });
}
function summary(artifact: Artifact) {
  const rowCounts: Record<string, number> = {},
    fingerprints: Record<string, string> = {};
  for (const name of Object.keys(artifact.data).sort()) {
    rowCounts[name] = artifact.data[name]!.length;
    fingerprints[name] = sha(JSON.stringify(orderedRows(artifact.data[name]!)));
  }
  return { rowCounts, fingerprints };
}
function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function manifestFor(artifact: Artifact, artifactJson: string): AuthRestoreManifest {
  return {
    format: 'mayi-local-auth-manifest-v1',
    classification: 'SYNTHETIC/LOCAL',
    createdBy: 'local-auth-restore-proof',
    sourceId: SOURCE_ID,
    appVersion: '0.1.0',
    createdAt: ISO,
    bookmark: 'synthetic-paused-native-export',
    schemaVersion: '0020',
    highestMigration: '0020_local_authentication.sql',
    history: migrations(),
    counts: { table: 44, index: 171, trigger: 176, view: 3 },
    schemaHash: authSchemaHash(artifact.schema),
    ...summary(artifact),
    artifactSha256: sha(artifactJson),
    completion: 'COMPLETE',
  };
}
const literal = (v: z.infer<typeof scalar>) =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`;
function sqlFor(artifact: Artifact) {
  const sql = ['PRAGMA defer_foreign_keys=ON;'];
  for (const kind of ['table', 'index'] as const)
    for (const row of artifact.schema.filter((r) => r.type === kind && r.sql !== null))
      sql.push(`${row.sql};`);
  for (const [table, rows] of Object.entries(artifact.data))
    for (const row of rows) {
      assert(
        identifier.safeParse(table).success &&
          Object.keys(row).every((k) => identifier.safeParse(k).success),
        'EXPORT_FIELD_INVALID',
      );
      sql.push(
        `INSERT INTO "${table}" (${Object.keys(row)
          .map((k) => `"${k}"`)
          .join(',')}) VALUES(${Object.values(row).map(literal).join(',')});`,
      );
    }
  for (const row of artifact.schema.filter((r) => r.type === 'trigger' || r.type === 'view'))
    sql.push(`${row.sql};`);
  return sql.join('\n');
}
function localCommand(directory: string, args: string[]) {
  // Closed local-only CLI, temp cwd/config; do not inherit any Cloudflare credential.
  assert(!args.includes('--remote'), 'REMOTE_FORBIDDEN');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CLOUDFLARE_')),
  );
  const persistence =
    args[1] === 'export' ? [] : ['--persist-to', join(directory, '.wrangler', 'state')];
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      ...args,
      '--local',
      '--config',
      join(directory, 'local.json'),
      ...persistence,
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...env,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
        WRANGLER_LOG_PATH: join(directory, 'logs'),
      },
    },
  );
  assert(result.status === 0, 'LOCAL_D1_COMMAND_FAILED');
}
async function openLocal(directory: string) {
  const { Miniflare, convertV4MiniflareOptions } = miniflare;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {}',
      cf: false,
      d1Databases: { DB: '00000000-0000-4000-8000-000000000321' },
      resourcePersistencePath: join(directory, '.wrangler', 'state', 'v3'),
    }),
  );
  try {
    return { db: await mf.getD1Database('DB'), dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
function directoryFor(role: 'source' | 'target') {
  const directory = mkdtempSync(join(tmpdir(), `mayi-auth-${role}-`));
  writeFileSync(
    join(directory, 'local.json'),
    JSON.stringify({
      name: `synthetic-auth-${role}`,
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: `synthetic-${role}`,
          database_id: '00000000-0000-4000-8000-000000000321',
          migrations_dir: resolve('db/migrations'),
        },
      ],
    }),
  );
  return directory;
}
async function readArtifact(db: D1Database): Promise<Artifact> {
  const schema = (await db.prepare(SCHEMA_SQL).all()).results as Artifact['schema'];
  const data: Artifact['data'] = {};
  for (const row of schema.filter((r) => r.type === 'table')) {
    assert(identifier.safeParse(row.name).success, 'TABLE_INVALID');
    data[row.name] = orderedRows(
      (await db.prepare(`SELECT * FROM "${row.name}"`).all()).results as Artifact['data'][string],
    );
  }
  return { format: 'mayi-synthetic-auth-export-v1', sourceId: SOURCE_ID, schema, data };
}
async function seed(db: D1Database) {
  const n = SYNTHETIC_AUTH_TIME;
  await db.prepare('UPDATE d1_migrations SET applied_at=?').bind(ISO).run();
  await db
    .prepare(
      "INSERT INTO agencies(id,status,created_at,updated_at) VALUES('synthetic-auth-agency','PROVISIONING',?,?)",
    )
    .bind(ISO, ISO)
    .run();
  for (const [id, type, temp] of [
    ['temporary', 'OWNER', true],
    ['permanent', 'MEMBER', false],
  ] as const) {
    await db
      .prepare('INSERT INTO users(id,status,created_at,updated_at) VALUES(?,?,?,?)')
      .bind(`synthetic-${id}`, 'ACTIVE', ISO, ISO)
      .run();
    await db
      .prepare(
        "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,email_provenance,bound_at,created_at,updated_at) VALUES(?,?,'urn:mayisigorta:local-auth:v1',?,?,'OWNER_PROVISIONED',?,?,?)",
      )
      .bind(
        `synthetic-identity-${id}`,
        `synthetic-${id}`,
        `synthetic-subject-${id}`,
        `${id}@example.invalid`,
        ISO,
        ISO,
        ISO,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at,created_at,updated_at) VALUES(?,'synthetic-auth-agency',?,?,'INVITED',2,?,'2099-01-01T00:00:00.000Z',?,?)",
      )
      .bind(
        `synthetic-membership-${id}`,
        `synthetic-${id}`,
        type,
        `${id}@example.invalid`,
        ISO,
        ISO,
      )
      .run();
    await db
      .prepare(
        "UPDATE agency_memberships SET status='ACTIVE',activated_at=?,version=2,permission_version=3 WHERE id=?",
      )
      .bind(ISO, `synthetic-membership-${id}`)
      .run();
    await db
      .prepare(
        'INSERT INTO local_credentials(user_id,identity_id,login_email,verifier,credential_version,must_change_password,temporary_expires_at,updated_at) VALUES(?,?,?,?,7,?,?,?)',
      )
      .bind(
        `synthetic-${id}`,
        `synthetic-identity-${id}`,
        `${id}@example.invalid`,
        `synthetic-verifier-${id}`,
        temp ? 1 : 0,
        temp ? n + 86400000 : null,
        n,
      )
      .run();
    if (type === 'OWNER')
      await db
        .prepare(
          "UPDATE agencies SET status='ACTIVE',bootstrap_completed_at=?,activated_at=?,version=2 WHERE id='synthetic-auth-agency'",
        )
        .bind(ISO, ISO)
        .run();
  }
  for (const [id, kind, hash, revoked] of [
    ['temporary', 'ACTIVATION', 'a', false],
    ['permanent', 'NORMAL', 'b', false],
    ['permanent', 'NORMAL', 'c', true],
  ] as const) {
    await db
      .prepare(
        'INSERT INTO local_sessions(token_hash,user_id,identity_id,membership_id,credential_version,permission_version,kind,created_at,expires_at,last_seen_at,recent_password_at,revoked_at) VALUES(?,?,?,?,7,3,?,?,?,?,?,?)',
      )
      .bind(
        hash.repeat(64),
        `synthetic-${id}`,
        `synthetic-identity-${id}`,
        `synthetic-membership-${id}`,
        kind,
        n,
        n + (kind === 'ACTIVATION' ? 900000 : 43200000),
        n,
        kind === 'NORMAL' ? n : null,
        revoked ? n + 1 : null,
      )
      .run();
  }
  for (const [id, action, target] of [
    ['provision', 'provision-agency', 'synthetic-auth-agency'],
    ['bootstrap', 'bootstrap', 'synthetic-temporary'],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO system_audit_events(id,agency_id,system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,outcome,reason_code,metadata_json,created_at) VALUES(?,'synthetic-auth-agency','LOCAL_AUTH_OPERATOR',?,'synthetic-auth',?,?,?,'SUCCESS','OPERATOR_CONFIRMED','{}',?)",
      )
      .bind(
        `synthetic-audit-${id}`,
        `auth.admin.${action}`,
        target,
        `synthetic-correlation-${id}`,
        `synthetic-key-${id}`,
        ISO,
      )
      .run();
  }
  await db
    .prepare(
      "INSERT INTO credential_operation_receipts(id,actor_user_id,agency_id,operation_key,fingerprint,actor_membership_id,safe_response_json,target_user_id,created_at) VALUES('synthetic-receipt','synthetic-temporary','synthetic-auth-agency','synthetic-operation',?,'synthetic-membership-temporary','{}','synthetic-permanent',?)",
    )
    .bind('d'.repeat(64), n)
    .run();
}
/** Optional explicit test-only seed remains confined to the freshly created local source. */
export async function createSyntheticAuthBackup(seedLocal?: (db: D1Database) => Promise<void>) {
  const directory = directoryFor('source');
  let platform: Awaited<ReturnType<typeof openLocal>> | undefined;
  try {
    localCommand(directory, ['d1', 'migrations', 'apply', 'DB']);
    platform = await openLocal(directory);
    if (seedLocal) await seedLocal(platform.db);
    else await seed(platform.db);
    // Source is offline/quiescent. Native export is the consistent snapshot boundary, not row-by-row live reads.
    await platform.dispose();
    platform = undefined;
    const start = performance.now(),
      dump = join(directory, 'native.sql');
    localCommand(directory, ['d1', 'export', 'DB', '--output', dump]);
    const native = readFileSync(dump, 'utf8');
    const decoded = new DatabaseSync(':memory:', {
      enableForeignKeyConstraints: false,
      allowExtension: false,
    });
    let artifact: Artifact;
    try {
      decoded.exec(orderedD1Import(native));
      const schema = decoded.prepare(SCHEMA_SQL).all() as Artifact['schema'];
      const data: Artifact['data'] = {};
      for (const row of schema.filter((r) => r.type === 'table'))
        data[row.name] = orderedRows(
          decoded.prepare(`SELECT * FROM "${row.name}"`).all() as Artifact['data'][string],
        );
      artifact = { format: 'mayi-synthetic-auth-export-v1', sourceId: SOURCE_ID, schema, data };
    } finally {
      decoded.close();
    }
    const artifactJson = encode(artifact),
      manifest = manifestFor(artifact, artifactJson);
    const backup = { artifactJson, manifest, manifestSha256: sha(canonicalizePayload(manifest)) };
    const exportElapsedMs = performance.now() - start;
    platform = await openLocal(directory);
    assert(encode(await readArtifact(platform.db)) === artifactJson, 'SOURCE_EXPORT_MISMATCH');
    const source = platform;
    return {
      backup,
      // SYNTHETIC bytes only, retained for same-source native transport regression.
      nativeExportSql: native,
      db: source.db,
      exportElapsedMs,
      async dispose() {
        await source.dispose();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await platform?.dispose();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function restoreSyntheticAuthBackup(input: SyntheticAuthBackup) {
  const verificationStart = performance.now();
  input = z
    .strictObject({
      artifactJson: z.string().max(RESTORE_LIMITS.exportBytes),
      manifest: manifestSchema,
      manifestSha256: digest,
    })
    .parse(input);
  const manifest = manifestSchema.parse(input.manifest);
  assert(sha(canonicalizePayload(manifest)) === input.manifestSha256, 'MANIFEST_HASH_MISMATCH');
  assert(Buffer.byteLength(input.artifactJson) <= RESTORE_LIMITS.exportBytes, 'EXPORT_LIMIT');
  assert(sha(input.artifactJson) === manifest.artifactSha256, 'ARTIFACT_HASH_MISMATCH');
  const artifact = artifactSchema.parse(JSON.parse(input.artifactJson));
  assert(encode(artifact) === input.artifactJson, 'EXPORT_NOT_CANONICAL');
  const reference = referenceSchema();
  assert(authSchemaHash(reference) === AUTH_RESTORE_SCHEMA_HASH, 'LOCAL_REFERENCE_DRIFT');
  assert(
    authSchemaHash(artifact.schema) === AUTH_RESTORE_SCHEMA_HASH &&
      manifest.schemaHash === AUTH_RESTORE_SCHEMA_HASH,
    'SCHEMA_MISMATCH',
  );
  const schemaIdentity = (rows: Artifact['schema']) =>
    JSON.stringify(
      rows.map((r) => [r.type, r.name, r.tbl_name, r.sql === null ? null : sqlTokens(r.sql)]),
    );
  assert(schemaIdentity(artifact.schema) === schemaIdentity(reference), 'SCHEMA_MISMATCH');
  assert(
    canonicalizePayload(manifest.history) === canonicalizePayload(migrations()),
    'MIGRATION_HISTORY_MISMATCH',
  );
  const ledger = artifact.data.d1_migrations;
  assert(
    ledger &&
      canonicalizePayload(
        ledger.map((r) => ({ id: r.id, name: r.name })).sort((a, b) => Number(a.id) - Number(b.id)),
      ) === canonicalizePayload(migrations().map(({ id, name }) => ({ id, name }))),
    'MIGRATION_HISTORY_MISMATCH',
  );
  const expectedTables = reference
    .filter((r) => r.type === 'table')
    .map((r) => r.name)
    .sort();
  assert(
    JSON.stringify(Object.keys(artifact.data).sort()) === JSON.stringify(expectedTables),
    'TABLE_SET_MISMATCH',
  );
  const totals = { table: 0, index: 0, trigger: 0, view: 0 };
  for (const row of artifact.schema) if (row.tbl_name !== 'd1_migrations') totals[row.type]++;
  assert(
    canonicalizePayload(totals) === canonicalizePayload(manifest.counts),
    'SCHEMA_COUNTS_MISMATCH',
  );
  const actual = summary(artifact);
  assert(
    canonicalizePayload(actual.rowCounts) === canonicalizePayload(manifest.rowCounts) &&
      canonicalizePayload(actual.fingerprints) === canonicalizePayload(manifest.fingerprints),
    'DATA_FINGERPRINT_MISMATCH',
  );
  let sql: string;
  try {
    sql = orderedD1Import(sqlFor(artifact));
  } catch (error) {
    // Preserve this accepted synthetic harness's error contract while the shared
    // decoder now detects FK violations earlier, before any target is created.
    if (error instanceof OrderedImportFailure && error.message === 'FOREIGN_KEY_INVALID')
      throw new Error('DB_FK_FAILED', { cause: error });
    throw error;
  }
  const pre = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  try {
    pre.exec(sql);
    assert(pre.prepare('PRAGMA foreign_key_check').all().length === 0, 'DB_FK_FAILED');
    // Restoring before triggers is necessary for faithful historical state; validate local auth bindings retrospectively.
    assert(
      pre
        .prepare(
          "SELECT c.user_id FROM local_credentials c JOIN auth_identities i ON i.id=c.identity_id WHERE c.user_id<>i.user_id OR i.issuer<>'urn:mayisigorta:local-auth:v1' OR i.email_provenance<>'OWNER_PROVISIONED' OR c.login_email<>i.verified_email",
        )
        .all().length === 0,
      'AUTH_RELATION_MISMATCH',
    );
    assert(
      pre
        .prepare(
          "SELECT s.token_hash FROM local_sessions s WHERE NOT EXISTS(SELECT 1 FROM local_credentials c JOIN agency_memberships m ON m.id=s.membership_id JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=c.user_id JOIN users u ON u.id=c.user_id JOIN agencies a ON a.id=m.agency_id WHERE c.user_id=s.user_id AND c.identity_id=s.identity_id AND m.user_id=s.user_id AND (s.revoked_at IS NOT NULL OR (s.credential_version=c.credential_version AND s.permission_version=m.permission_version AND c.login_enabled=1 AND i.status='ACTIVE' AND u.status='ACTIVE' AND m.status='ACTIVE' AND a.status='ACTIVE' AND ((s.kind='NORMAL' AND c.must_change_password=0) OR (s.kind='ACTIVATION' AND c.must_change_password=1 AND c.temporary_expires_at>s.created_at AND s.expires_at<=c.temporary_expires_at)))))",
        )
        .all().length === 0,
      'AUTH_RELATION_MISMATCH',
    );
    assert(
      pre
        .prepare(
          'SELECT r.id FROM credential_operation_receipts r WHERE r.actor_membership_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agency_memberships m WHERE m.id=r.actor_membership_id AND m.user_id=r.actor_user_id AND m.agency_id=r.agency_id)',
        )
        .all().length === 0,
      'AUTH_RELATION_MISMATCH',
    );
    // Every principal in this populated synthetic F-27 proof needs its complete local graph.
    assert(
      pre
        .prepare(
          'SELECT u.id FROM users u WHERE NOT EXISTS(SELECT 1 FROM local_credentials c JOIN auth_identities i ON i.id=c.identity_id JOIN agency_memberships m ON m.user_id=u.id WHERE c.user_id=u.id AND i.user_id=u.id)',
        )
        .all().length === 0,
      'AUTH_RELATION_MISMATCH',
    );
  } finally {
    pre.close();
  }
  const preverificationMs = performance.now() - verificationStart;
  const directory = directoryFor('target');
  let platform: Awaited<ReturnType<typeof openLocal>> | undefined;
  try {
    const path = join(directory, 'restore.sql');
    writeFileSync(path, sql);
    const restoreStart = performance.now();
    localCommand(directory, ['d1', 'execute', 'DB', '--file', path, '--yes']);
    platform = await openLocal(directory);
    const restoreElapsedMs = performance.now() - restoreStart;
    const verifyStart = performance.now(),
      restored = await readArtifact(platform.db);
    assert(encode(restored) === input.artifactJson, 'RESTORED_STATE_MISMATCH');
    const foreignKeys = (await platform.db.prepare('PRAGMA foreign_key_check').all()).results;
    assert(foreignKeys.length === 0, 'DB_FK_FAILED');
    const report = {
      code: 'VERIFIED_SEALED' as const,
      publication: 'SEALED_EXTERNAL_CONTROL_PLANE_PENDING' as const,
      schemaHash: authSchemaHash(restored.schema),
      fingerprints: summary(restored).fingerprints,
      foreignKeys: foreignKeys.length,
      restoreElapsedMs,
      verificationElapsedMs: preverificationMs + performance.now() - verifyStart,
      reconciliationRequired: [
        'current-offboarding',
        'current-permissions',
        'deletion-tombstones',
        'session-revocation',
        'recent-password-assurance',
        'sensitive-action-grants',
      ],
    };
    const target = platform;
    return {
      db: target.db,
      report,
      assertPublication() {
        throw new Error('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
      },
      async dispose() {
        await target.dispose();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await platform?.dispose();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
