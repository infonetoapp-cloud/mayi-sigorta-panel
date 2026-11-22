import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeMigrationEvidence(filename: string, result: unknown): void {
  const directory = 'audit-evidence/ux-review-2026-11-17';
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, filename), JSON.stringify(result, null, 2));
}
