import { execFileSync } from 'node:child_process';
import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/** Pin exact committed SQL bytes AND reject semantic worktree drift.
 * Git's configured checkout filter may legitimately materialize CRLF on Windows;
 * do not rewrite SQL, replace historical pins, or normalize arbitrary source here.
 */
export function historicalMigrationHash(
  root: string,
  filename: string,
  readGit?: (args: string[]) => Buffer,
): string {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(filename)) throw Error('MIGRATION_FILENAME_DENIED');
  return createHash('sha256')
    .update(historicalMigrationBytes(root, `db/migrations/${filename}`, readGit))
    .digest('hex');
}

export function historicalMigrationBytes(
  root: string,
  path: string,
  readGit?: (args: string[]) => Buffer,
): Buffer {
  if (!/^db\/migrations\/(?:\d{4}_[a-z0-9_]+\.sql|meta\/\d{4}_snapshot\.json)$/.test(path))
    throw Error('MIGRATION_FILENAME_DENIED');
  const git = readGit ?? ((args: string[]) => execFileSync('git', args, { cwd: root }));
  const committed = new TextDecoder().decode(git(['rev-parse', `HEAD:${path}`])).trim();
  const checkout = new TextDecoder().decode(git(['hash-object', `--path=${path}`, path])).trim();
  if (!/^[a-f0-9]{40}$/.test(committed) || checkout !== committed)
    throw Error('HISTORICAL_MIGRATION_WORKTREE_DRIFT');
  return git(['cat-file', 'blob', committed]);
}
