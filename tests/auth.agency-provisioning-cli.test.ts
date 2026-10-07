// @vitest-environment node
import { expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parse(args: string[]) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    const { parseAdminArguments } = await import('./scripts/local-auth-admin.mjs');
    try { console.log(JSON.stringify({ values: parseAdminArguments(${JSON.stringify(args)}) })); }
    catch (error) { console.log(JSON.stringify({ error: error.message })); }
  `,
      ],
      { encoding: 'utf8' },
    ),
  );
}
it('provisioning CLI parser accepts explicit local mode and rejects remote/OWNER/unknown fields', () => {
  expect(parse(['--mode', 'provision-agency', '--local']).values.mode).toBe('provision-agency');
  for (const args of [
    ['--mode', 'provision-agency', '--remote'],
    ['--mode', 'provision-agency', '--local', '--owner', 'synthetic-owner'],
    ['--mode', 'provision-agency', '--local', '--email', 'synthetic@example.invalid'],
    ['--mode', 'provision-agency', '--local', '--name', 'Synthetic Owner'],
    ['--mode', 'provision-agency', '--local', '--password', 'not-a-credential'],
    ['--mode', 'provision-agency'],
    ['--mode', 'provision-agency', '--local', '--remote'],
  ])
    expect(parse(args).error).toBeTruthy();
});
it('non-TTY direct execution fails without provisioning or credential output', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/local-auth-admin.mjs', '--mode', 'provision-agency', '--local'],
    { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: '' } },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Yönetim işlemi reddedildi');
});
it('provisioning confirmation tuple binds account, database, agency and operation key exactly', () => {
  const tuple = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { adminConfirmationTuple } = await import('./scripts/local-auth-admin.mjs');
    console.log(adminConfirmationTuple({mode:'provision-agency',accountId:'a'.repeat(32),databaseId:'00000000-0000-4000-8000-000000000027',agencyId:'synthetic-agency',operationKey:'synthetic-operation'}));
  `,
    ],
    { encoding: 'utf8' },
  ).trim();
  expect(tuple).toBe(
    'provision-agency:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:00000000-0000-4000-8000-000000000027:synthetic-agency:synthetic-operation',
  );
});
it('administrative composition is absent from the public Worker import graph', async () => {
  const bundle = await build({
    entryPoints: ['src/server/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    metafile: true,
  });
  expect(
    Object.keys(bundle.metafile!.inputs).some((path) =>
      path.replaceAll('\\', '/').endsWith('/auth/admin.ts'),
    ),
  ).toBe(false);
  expect(bundle.outputFiles[0]!.text).not.toContain('auth.admin.provision-agency');
});
it('real CLI composition rejects wrong confirmation and exact-target mismatch; exact local success/retry has no secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-agency-cli-state-'));
  const configPath = join(directory, 'local.json');
  const harness = join(directory, 'cli-fixture.mjs');
  const accountId = 'a'.repeat(32),
    databaseId = '00000000-0000-4000-8000-000000000027';
  const cli = resolve('scripts/local-auth-admin.mjs');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'synthetic-local',
      account_id: accountId,
      compatibility_date: '2026-09-01',
      d1_databases: [{ binding: 'DB', database_id: databaseId, database_name: 'synthetic-local' }],
    }),
  );
  // Test-only simulated terminal IO. Production still requires genuine stdin/stdout TTY.
  writeFileSync(
    harness,
    `
    import {createRequire} from 'node:module';
    import {readFileSync,readdirSync} from 'node:fs';
    const require=createRequire(${JSON.stringify(resolve('package.json'))});
    const fs=require('node:fs');
    const originalRead=fs.readFileSync;
    let observing=false, dotenvReads=0;
    fs.readFileSync=(path,...args)=>{
      if(observing && /(?:^|[\\\\/])(?:\\.dev\\.vars|\\.env)(?:\\.|$)/.test(String(path))) {
        dotenvReads++;
        return 'SYNTHETIC_DOTENV_MARKER=sentinel-not-a-secret';
      }
      return originalRead(path,...args);
    };
    process.on('exit',()=>{if(dotenvReads!==0)process.exitCode=2});
    const {getPlatformProxy}=require('wrangler');
    const configPath=${JSON.stringify(configPath)}, state=${JSON.stringify(join(directory, 'state'))};
    const mode=process.argv[2];
    const p=await getPlatformProxy({configPath,envFiles:[],persist:{path:state},remoteBindings:false});
    if(mode==='init') {
      for(const file of readdirSync('db/migrations').filter(n=>/^\\d{4}_.*\\.sql$/.test(n)).sort())
        for(const stmt of readFileSync('db/migrations/'+file,'utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean)) await p.env.DB.prepare(stmt).run();
      await p.dispose();
    } else if(mode==='verify') {
      const tables=['agencies','system_audit_events','users','agency_memberships','auth_identities','local_credentials','local_sessions'];
      const counts={}; for(const table of tables) counts[table]=(await p.env.DB.prepare('SELECT count(*) n FROM '+table).first()).n;
      console.log(JSON.stringify(counts)); await p.dispose();
    } else {
      await p.dispose();
      observing=true;
      globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN')};
      Object.defineProperty(process.stdin,'isTTY',{value:true});
      Object.defineProperty(process.stdout,'isTTY',{value:true});
      const original=process.stdout.write.bind(process.stdout);
      const answerAccount=mode==='mismatch'?'b'.repeat(32):${JSON.stringify(accountId)};
      process.stdout.write=(chunk,...args)=>{const r=original(chunk,...args);if(String(chunk).includes(' yazın: '))queueMicrotask(()=>process.stdin.emit('data',(mode==='wrong'?'WRONG':'provision-agency:'+answerAccount+':${databaseId}:synthetic-cli-agency:synthetic-cli-operation')+'\\n'));return r};
      process.argv=[process.execPath,${JSON.stringify(cli)},'--mode','provision-agency','--local','--account',mode==='mismatch'?'b'.repeat(32):${JSON.stringify(accountId)},'--d1',${JSON.stringify(databaseId)},'--agency','synthetic-cli-agency','--key','synthetic-cli-operation','--config',configPath,'--persist-to',state];
      await import(${JSON.stringify(pathToFileURL(cli).href)});
    }
  `,
  );
  const run = (mode: string) =>
    spawnSync(process.execPath, [harness, mode], {
      encoding: 'utf8',
      timeout: 90000,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: '' },
    });
  try {
    expect(run('init').status).toBe(0);
    expect(run('wrong').status).toBe(1);
    expect(run('mismatch').status).toBe(1);
    expect(JSON.parse(run('verify').stdout)).toEqual({
      agencies: 0,
      system_audit_events: 0,
      users: 0,
      agency_memberships: 0,
      auth_identities: 0,
      local_credentials: 0,
      local_sessions: 0,
    });
    const first = run('success');
    expect(first.status, first.stderr).toBe(0);
    const retry = run('success');
    expect(retry.status, retry.stderr).toBe(0);
    expect(first.stdout).toBe(retry.stdout);
    expect(first.stdout).toContain('Acente PROVISIONING: synthetic-cli-agency');
    expect(first.stdout).not.toContain('Geçici şifre (yalnız bir kez)');
    expect(JSON.parse(run('verify').stdout)).toEqual({
      agencies: 1,
      system_audit_events: 1,
      users: 0,
      agency_memberships: 0,
      auth_identities: 0,
      local_credentials: 0,
      local_sessions: 0,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180000);
