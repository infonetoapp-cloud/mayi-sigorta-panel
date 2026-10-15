// @vitest-environment node
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
it('adds only the closed production SQLite upload runtime while retaining KDF migration history', () => {
  const config = JSON.parse(
    readFileSync('wrangler.jsonc', 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1'),
  );
  const p = config.env.production;
  expect(p.vars.DOCUMENTS_ENABLED).toBe('false');
  expect(p.durable_objects.bindings).toContainEqual({
    name: 'DOCUMENT_UPLOAD_RUNTIME',
    class_name: 'DocumentUploadDurableObject',
  });
  expect(p.migrations).toEqual([
    ...config.migrations,
    { tag: 'document-upload-v1', new_sqlite_classes: ['DocumentUploadDurableObject'] },
  ]);
  expect(p.limits).toBeUndefined();
  expect(p.d1_databases).toEqual(config.env.foundation.d1_databases);
});
