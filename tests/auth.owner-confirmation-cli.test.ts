// @vitest-environment node
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Test-only loader substitutes execution effects, not validation/confirmation/domain normalizer.
// No real owner/password/KDF/network: the actual CLI reaches an instrumented domain seam.
function run(mode: string, remote: boolean, correct: boolean) {
  const cli = resolve('scripts/local-auth-admin.mjs');
  const domainStub =
    "\nadministerLocalOwner = async(db,target)=>{globalThis.__domainCalls++;globalThis.__capturedTarget=target;return {temporaryPassword:'SYNTHETIC-NO-PASSWORD-GENERATED',expiresAt:'2099-01-01T00:00:00Z'}};";
  const buildReplacement =
    "import { build as actualBuild } from 'esbuild'; async function build(options){const result=await actualBuild(options); result.outputFiles[0]={text:result.outputFiles[0].text+" +
    JSON.stringify(domainStub) +
    '};return result;}';
  const script = `
    import {registerHooks} from 'node:module';
    import {readFileSync} from 'node:fs';
    let domainCalls=0, opens=0, requests=0, promptText='', capturedTarget=null;
    registerHooks({load(url,ctx,next){
      const result=next(url,ctx);
      if(url===${JSON.stringify(pathToFileURL(cli).href)}){
        let source=String(result.source);
        source=source.replace("import { build } from 'esbuild';", ${JSON.stringify(buildReplacement)});
        source=source.replace("import { getPlatformProxy, unstable_readConfig } from 'wrangler';", \
          "const unstable_readConfig=()=>({account_id:'a'.repeat(32),d1_databases:[{binding:'DB',database_id:'00000000-0000-4000-8000-000000000027',remote:false}]});const getPlatformProxy=async()=>{globalThis.__opens++;return{env:{DB:{}},dispose:async()=>{}}};");
        source=source.replace('main().catch(() => {','main().catch((error) => {globalThis.__fixtureError=error.message;');
        return {...result,source};
      }
      return result;
    }});
    globalThis.__domainCalls=0;globalThis.__opens=0;
    globalThis.fetch=async(url,init)=>{requests++;if(init.method!=='GET')throw Error('NO_MUTATIONS');return Response.json({success:true,result:url.endsWith('/user')?{two_factor_authentication_enabled:true,two_factor_authentication_locked:true}:{uuid:'00000000-0000-4000-8000-000000000027'}})};
    Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stdout,'isTTY',{value:true});
    const write=process.stdout.write.bind(process.stdout);
    process.stdout.write=(chunk,...args)=>{const r=write(chunk,...args);if(String(chunk).includes(' yazın: ')) {promptText=String(chunk);const expected=JSON.stringify({mode:${JSON.stringify(mode)},accountId:'a'.repeat(32),databaseId:'00000000-0000-4000-8000-000000000027',agencyId:'synthetic-agency',ownerUserId:'synthetic-owner',email:'owner@example.invalid',operationKey:'synthetic-owner-key'});queueMicrotask(()=>process.stdin.emit('data',(${correct} ? expected : 'WRONG')+'\\n'));} return r};
    process.argv=[process.execPath,${JSON.stringify(cli)},'--mode',${JSON.stringify(mode)},${JSON.stringify(remote ? '--remote' : '--local')},'--account','a'.repeat(32),'--d1','00000000-0000-4000-8000-000000000027','--agency','synthetic-agency','--owner','synthetic-owner','--email',' OWNER@Example.Invalid ','--name','  Synthetic Owner  ','--key','synthetic-owner-key',...(${remote} ? [] : ['--config','synthetic.json','--persist-to','synthetic-state'])];
    process.on('exit',()=>{write('\\nRESULT:'+JSON.stringify({domainCalls:globalThis.__domainCalls,opens:globalThis.__opens,requests,promptText,target:globalThis.__capturedTarget??null,fixtureError:globalThis.__fixtureError})+'\\n')});
    await import(${JSON.stringify(pathToFileURL(cli).href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: '',
      CLOUDFLARE_EMAIL: 'synthetic-cloud@example.invalid',
      CLOUDFLARE_API_KEY: 'synthetic-cloud-key',
    },
  });
  const line = result.stdout.split('\n').find((line) => line.startsWith('RESULT:'));
  return { ...result, report: line ? JSON.parse(line.slice(7)) : null };
}

it.each(
  ['bootstrap', 'break-glass'].flatMap((mode) => [false, true].map((remote) => ({ mode, remote }))),
)(
  'correct confirmation reaches the domain seam with canonical target ($mode remote=$remote)',
  ({ mode, remote }) => {
    const result = run(mode, remote, true);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.report.domainCalls).toBe(1);
    expect(result.report.target.email).toBe('owner@example.invalid');
    expect(result.report.target.name).toBe('Synthetic Owner');
    expect(result.report.promptText).toContain('Owner display name: "Synthetic Owner"');
    expect(result.report.promptText).not.toContain('SYNTHETIC-NO-PASSWORD-GENERATED');
    expect(result.report.promptText).not.toContain('synthetic-cloud-key');
    expect(result.report.promptText).not.toContain('synthetic-cloud@example.invalid');
    expect(result.report.requests).toBe(remote ? 2 : 0);
  },
);
it.each(
  ['bootstrap', 'break-glass'].flatMap((mode) => [false, true].map((remote) => ({ mode, remote }))),
)(
  'wrong confirmation blocks before opening target or domain ($mode remote=$remote)',
  ({ mode, remote }) => {
    const result = run(mode, remote, false);
    expect(result.status, result.stderr).toBe(1);
    expect(result.report.domainCalls).toBe(0);
    expect(result.report.opens).toBe(0);
    expect(result.report.requests).toBe(0);
    expect(result.stderr).toContain('Yönetim işlemi reddedildi');
    expect(result.stdout).not.toContain('Geçici şifre');
  },
);
