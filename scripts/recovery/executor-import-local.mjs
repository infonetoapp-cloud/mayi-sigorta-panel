// Child process: bounded local SQLite transport only. No network/config/client.
import { DatabaseSync, constants } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
try {
  if (
    process.argv.length !== 3 ||
    basename(process.argv[2]) !== 'target.sqlite' ||
    existsSync(process.argv[2])
  )
    throw Error('LOCAL_TARGET_FILE_DENIED');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (
    typeof input.sql !== 'string' ||
    Buffer.byteLength(input.sql) > 16 * 1024 * 1024 ||
    !['none', 'partialImport', 'corruptMoney', 'importTimeout'].includes(input.fault)
  )
    throw Error('LOCAL_IMPORT_DENIED');
  if (input.fault === 'importTimeout')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  const db = new DatabaseSync(process.argv[2], { allowExtension: false });
  db.enableDefensive(true);
  db.setAuthorizer((action) =>
    [constants.SQLITE_ATTACH, constants.SQLITE_DETACH, constants.SQLITE_CREATE_VTABLE].includes(
      action,
    )
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  try {
    if (input.fault === 'partialImport') {
      // An explicitly incomplete import simulation; no caller-selected file/DDL.
      db.exec('CREATE TABLE synthetic_partial(id TEXT PRIMARY KEY)');
    } else {
      // Native D1 file import has a transaction boundary. Without it, SQLite
      // autocommit ends deferral after each row and breaks parent/child restores.
      db.exec('BEGIN');
      try {
        db.exec(input.sql);
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    }
    if (input.fault === 'corruptMoney')
      db.exec(
        "UPDATE policies SET gross_premium_minor=gross_premium_minor+1,version=version+1 WHERE id='synthetic-policy-00'",
      );
  } finally {
    db.close();
  }
  process.stdout.write(JSON.stringify({ code: 'LOCAL_IMPORT_COMPLETE' }));
} catch {
  // Never propagate SQLite SQL, row values, runtime errors or raw stderr.
  process.stdout.write(JSON.stringify({ code: 'LOCAL_IMPORT_FAILED' }));
  process.exitCode = 1;
}
