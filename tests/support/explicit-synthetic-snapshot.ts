import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitNativeExportStatements } from '../../scripts/recovery/ordered-d1-import';

type Column = { name: string; dflt_value: string | null };
let schema: Map<string, Column[]> | undefined;
function referenceColumns() {
  if (schema) return schema;
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    // Trusted checked-in schema only. No recovery/source SQL is executed here.
    for (const file of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.+\.sql$/u.test(n))
      .sort())
      db.exec(readFileSync(resolve('db/migrations', file), 'utf8'));
    schema = new Map();
    for (const row of db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'")
      .all()) {
      const name = String(row.name);
      if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new Error('SYNTHETIC_SCHEMA_INVALID');
      schema.set(name, db.prepare(`PRAGMA table_info("${name}")`).all() as unknown as Column[]);
    }
    return schema;
  } finally {
    db.close();
  }
}
/** Historical tests inject rows with partial INSERTs, unlike native exports.
 * Make those trusted SYNTHETIC variants explicit before computing their source
 * hash. Never run nondeterministic schema defaults inside the recovery decoder.
 * This is a test builder, not a second reorder or a production repair facility. */
export function explicitSyntheticSnapshotRows(source: string, snapshotTime: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(snapshotTime))
    throw new Error('SYNTHETIC_TIME_INVALID');
  const columns = referenceColumns();
  let output = source;
  for (const { tokens, sql } of splitNativeExportStatements(source)) {
    if (
      tokens[0]?.toUpperCase() !== 'INSERT' ||
      tokens[1]?.toUpperCase() !== 'INTO' ||
      tokens[3] !== '('
    )
      continue;
    const table = tokens[2]!.replace(/^[`"[]|[`"\]]$/gu, '');
    const info = columns.get(table);
    if (!info) continue;
    const values = tokens.findIndex((t) => t.toUpperCase() === 'VALUES');
    const supplied = tokens
      .slice(3, values)
      .filter((t) => !['(', ')', ','].includes(t))
      .map((t) => t.replace(/^[`"[]|[`"\]]$/gu, ''));
    const missing = info.filter((c) => !supplied.includes(c.name));
    if (!missing.length) continue; // Exact native/full-row bytes remain untouched.
    const defaults = missing.map((c) => {
      if (c.dflt_value === null) return 'NULL';
      const v = c.dflt_value;
      if (/^(?:NULL|[-+]?\d+(?:\.\d+)?|'(?:''|[^'])*')$/iu.test(v)) return v;
      if (/strftime|CURRENT_TIMESTAMP/iu.test(v)) return `'${snapshotTime}'`;
      throw new Error('SYNTHETIC_DEFAULT_UNSUPPORTED');
    });
    const valueWord = sql.indexOf('VALUES'),
      headerEnd = sql.lastIndexOf(')', valueWord),
      rowEnd = sql.lastIndexOf(')');
    if (valueWord < 0 || headerEnd < 0 || rowEnd < headerEnd)
      throw new Error('SYNTHETIC_INSERT_INVALID');
    const expanded =
      sql.slice(0, headerEnd) +
      ',' +
      missing.map((c) => `"${c.name}"`).join(',') +
      sql.slice(headerEnd, rowEnd) +
      ',' +
      defaults.join(',') +
      sql.slice(rowEnd);
    output = output.replace(sql, expanded);
  }
  return output;
}
