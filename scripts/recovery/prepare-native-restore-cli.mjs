// Recovery operator PREPARATION only. Remote execution is deliberately absent.
import { readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import process from 'node:process';
import { info as report, error as reportError } from 'node:console';
import { prepareNativeD1Restore, withPreparedRestoreFile } from './prepare-native-restore.ts';

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 && args.length !== 5) throw new Error('CLI_ARGUMENTS_INVALID');
  if (
    args[0] !== '--source' ||
    args[2] !== '--receipt' ||
    (args[4] !== undefined && args[4] !== '--local-proof')
  )
    throw new Error('REMOTE_EXECUTION_DISABLED');
  if (statSync(args[1]).size > 8 * 1024 * 1024 || statSync(args[3]).size > 65536)
    throw new Error('RESOURCE_LIMIT');
  const prepared = prepareNativeD1Restore(
    readFileSync(args[1]),
    JSON.parse(readFileSync(args[3], 'utf8')),
  );
  let localProof = 'NOT_EXECUTED';
  await withPreparedRestoreFile(prepared, async (path) => {
    if (args[4] !== '--local-proof') return;
    const target = new DatabaseSync(':memory:', { allowExtension: false });
    try {
      target.exec('BEGIN;');
      target.exec(readFileSync(path, 'utf8'));
      target.exec('COMMIT;');
      if (
        target.prepare('PRAGMA foreign_key_check').all().length ||
        target.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
      )
        throw new Error('LOCAL_TARGET_INVALID');
      localProof = 'SQLITE_ONLY_VERIFIED_SEALED_NOT_D1_PROOF';
    } catch {
      if (target.isTransaction) target.exec('ROLLBACK;');
      throw new Error('LOCAL_TARGET_INVALID');
    } finally {
      target.close();
    }
  });
  report(
    JSON.stringify({
      generation: prepared.generation,
      sourceObjectKey: prepared.sourceObjectKey,
      SOURCE_EXPORT_SHA256: prepared.sourceExportSha256,
      DERIVED_RESTORE_SHA256: prepared.derivedRestoreSha256,
      sourceBytes: prepared.sourceBytes,
      derivedBytes: prepared.derivedBytes,
      temporaryDerivedRemoved: true,
      localProof,
      remoteExecuted: false,
      productionRtoProven: false,
    }),
  );
} catch (error) {
  const code =
    error instanceof Error && /^[A-Z_]{1,64}$/u.test(error.message)
      ? error.message
      : 'PREPARATION_FAILED';
  reportError(JSON.stringify({ verdict: 'FAIL', code, remoteExecuted: false }));
  process.exitCode = 1;
}
