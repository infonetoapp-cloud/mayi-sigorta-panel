// @vitest-environment node
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
interface Scope {
  vars: {
    DOCUMENTS_ENABLED: string;
    DOCUMENT_JOBS_ENABLED?: string;
    DOCUMENT_CRON_ENABLED?: string;
  };
  r2_buckets: Array<{ binding: string }>;
  services?: unknown[];
  queues: { consumers: unknown[] };
  triggers: { crons: unknown[] };
  workers_dev: boolean;
  preview_urls: boolean;
}
function config(text = readFileSync('wrangler.jsonc', 'utf8')) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gmu, '').replace(/,\s*([}\]])/gu, '$1')) as Scope & {
    env: { production: Scope; foundation: Scope };
  };
}
it('closed production changes only narrow service plus false runtime vars; no raw recovery R2 fallback', () => {
  const c = config();
  for (const env of [c, c.env.production, c.env.foundation]) {
    expect(env.vars.DOCUMENTS_ENABLED).toBe('false');
    expect(env.r2_buckets.map((b: { binding: string }) => b.binding)).toEqual(['DOCS_QUARANTINE']);
    expect(env.services ?? []).toEqual(
      env === c.env.production
        ? [
            {
              binding: 'DOCUMENT_BACKUP_CAPABILITY',
              service: 'mayisigorta-document-backup',
              entrypoint: 'DocumentBackupCapability',
            },
          ]
        : [],
    );
    expect(env.vars.DOCUMENT_JOBS_ENABLED ?? 'false').toBe('false');
    expect(env.vars.DOCUMENT_CRON_ENABLED ?? 'false').toBe('false');
  }
  expect(c.env.production.queues.consumers).toEqual([]);
  expect(c.env.production.triggers.crons).toEqual([]);
  expect(c.env.production.workers_dev).toBe(false);
  expect(c.env.production.preview_urls).toBe(false);
  const prior = config(
    execFileSync('git', ['show', 'e2ebff2dcd2f4a54a0e8db022b27185547f3c965:wrangler.jsonc'], {
      encoding: 'utf8',
    }),
  );
  const unchanged = structuredClone(c);
  delete unchanged.env.production.services;
  delete unchanged.env.production.vars.DOCUMENT_JOBS_ENABLED;
  delete unchanged.env.production.vars.DOCUMENT_CRON_ENABLED;
  expect(unchanged).toEqual(prior);
  expect(
    readFileSync('wrangler.backup.json', 'utf8').replace(/\r\n/gu, '\n') ===
      execFileSync(
        'git',
        ['show', '9c0fb032375a14611d6f945d2ce4fc6ca29ecd50:wrangler.backup.json'],
        { encoding: 'utf8' },
      ),
  ).toBe(true);
});
it('production leaf has one EU document recovery binding and no additional authority or exposure', () => {
  const leaf = config(readFileSync('wrangler.document-backup.jsonc', 'utf8'));
  expect(leaf).toEqual({
    $schema: 'node_modules/wrangler/config-schema.json',
    name: 'mayisigorta-document-backup',
    account_id: 'af9fc98cb8d5f5508d58057bc794d863',
    main: 'src/server/documents/private-backup-worker.ts',
    compatibility_date: '2026-09-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    routes: [],
    triggers: { crons: [] },
    r2_buckets: [
      {
        binding: 'DOCUMENT_BACKUP_STORAGE',
        bucket_name: 'mayisigorta-documents-recovery',
        jurisdiction: 'eu',
      },
    ],
  });
});
it('private leaf exposes only create/observation/denied fetch; CRM cannot import/re-export its raw storage authority', () => {
  const file = ts.createSourceFile(
    'leaf.ts',
    readFileSync('src/server/documents/private-backup-worker.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names: string[] = [];
  const found = file.statements.find(
    (s) => ts.isClassDeclaration(s) && s.name?.text === 'DocumentBackupCapability',
  );
  expect(found !== undefined).toBe(true);
  if (found && ts.isClassDeclaration(found))
    for (const member of found.members)
      if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name))
        names.push(member.name.text);
  expect(names.sort()).toEqual(['createAndVerify', 'fetch', 'observeBackup']);
  const entry = readFileSync('src/server/worker.ts', 'utf8');
  expect(entry.includes('private-backup-worker')).toBe(false);
  const composition = readFileSync('src/server/documents/private-capabilities.ts', 'utf8');
  expect(composition.includes('private-backup-worker')).toBe(false);
  expect(composition.includes('DOCUMENT_BACKUP_STORAGE')).toBe(false);
  expect(composition.includes('createR2DocumentBackupAdapter')).toBe(false);
});
