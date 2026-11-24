import { DatabaseSync, constants, type SQLInputValue } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
// @ts-expect-error Native Node decoder needs an explicit extension.
import { MAX_RAW_SQL_BYTES } from '../../src/server/d1-backup/format.ts';

// Recovery-only decoder. Never import from a Worker or pass a live binding here.
export const ORDERED_IMPORT_LIMITS = Object.freeze({
  sourceBytes: MAX_RAW_SQL_BYTES,
  derivedBytes: 144 * 1024 * 1024,
  rows: 200000,
  schemaObjects: 1000,
  tokens: 16000000,
  statementTokens: 200000,
  columns: 256,
  nesting: 64,
  schemaInspectionSteps: 1000000,
});
export class OrderedImportFailure extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'OrderedImportFailure';
  }
}
const fail = (code: string): never => {
  throw new OrderedImportFailure(code);
};
const identifier = /^[a-z][a-z0-9_]*$/u;
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Closed export lexer: full consumption, bounded tokens, no execution during preflight. */
function* statements(source: string): Generator<{ tokens: string[]; sql: string }> {
  const pattern =
    /\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[xX]'[0-9a-fA-F]*'|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-zA-Z_][a-zA-Z_0-9]*|[<>!=]=|<>|\|\||[(),;.+*/<>=!|&%~-]/gy;
  let at = 0,
    tokenCount = 0,
    depth = 0,
    start = 0;
  let current: string[] = [];
  while (at < source.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(source);
    if (!match) return fail('SOURCE_SQL_INVALID');
    at = pattern.lastIndex;
    const token = match[0];
    if (/^\s|^--|^\/\*/u.test(token)) continue;
    // x'...' must precede the string alternative (x is not a keyword).
    if (++tokenCount > ORDERED_IMPORT_LIMITS.tokens) return fail('RESOURCE_LIMIT');
    if (current.length >= ORDERED_IMPORT_LIMITS.statementTokens) return fail('RESOURCE_LIMIT');
    if (!current.length) start = match.index;
    current.push(token);
    if (current[0]?.toUpperCase() === 'CREATE' && current[1]?.toUpperCase() === 'TRIGGER') {
      if (['BEGIN', 'CASE'].includes(token.toUpperCase())) depth++;
      if (token.toUpperCase() === 'END') depth--;
    }
    if (token === ';' && depth === 0) {
      current.pop();
      yield { tokens: current, sql: source.slice(start, at) };
      current = [];
    }
    if (depth < 0) return fail('SOURCE_SQL_INVALID');
  }
  if (current.length || depth) return fail('SOURCE_SQL_TRUNCATED');
}
/** Fixture builders may inspect lexical statement boundaries without executing
 * input. Reordering and all decoder execution still have exactly one owner. */
export function splitNativeExportStatements(source: string) {
  if (Buffer.byteLength(source) > ORDERED_IMPORT_LIMITS.sourceBytes) return fail('RESOURCE_LIMIT');
  return Array.from(statements(source));
}

export function iterateDerivedRestoreStatements(source: string) {
  if (Buffer.byteLength(source) > ORDERED_IMPORT_LIMITS.derivedBytes) return fail('RESOURCE_LIMIT');
  return statements(source);
}
// Official native exports encode CR/LF in text as one or two shrinking REPLACE
// constructors. This is a closed literal grammar, not a general SQL expression.
function newlineLiteralEnd(data: readonly string[], at: number, depth = 0): number {
  if (/^'(?:''|[^'])*'$/u.test(data[at] ?? '')) return at + 1;
  if (depth >= 2 || data[at]?.toUpperCase() !== 'REPLACE' || data[at + 1] !== '(')
    return fail('SOURCE_VALUE_DENIED');
  const end = newlineLiteralEnd(data, at + 2, depth + 1);
  const code = data[end + 1] === "'\\n'" ? '10' : data[end + 1] === "'\\r'" ? '13' : null;
  if (
    code === null ||
    data[end] !== ',' ||
    data[end + 2] !== ',' ||
    data[end + 3]?.toUpperCase() !== 'CHAR' ||
    data[end + 4] !== '(' ||
    data[end + 5] !== code ||
    data[end + 6] !== ')' ||
    data[end + 7] !== ')'
  )
    return fail('SOURCE_VALUE_DENIED');
  return end + 8;
}

function preflight(source: string) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > ORDERED_IMPORT_LIMITS.sourceBytes)
    return fail('RESOURCE_LIMIT');
  if (source.includes('\0')) return fail('SOURCE_SQL_INVALID');
  const all = statements(source);
  let schemas = 0,
    rows = 0,
    postData = false;
  const names = new Set<string>();
  let inspectionSteps = 0;
  for (const { tokens: statement } of all) {
    const t = statement.map((s) => s.toUpperCase());
    let nesting = 0;
    for (const token of statement) {
      if (token === '(' && ++nesting > ORDERED_IMPORT_LIMITS.nesting) return fail('RESOURCE_LIMIT');
      if (token === ')' && --nesting < 0) return fail('SOURCE_SQL_INVALID');
    }
    if (nesting) return fail('SOURCE_SQL_INVALID');
    if (!t.length) continue;
    if (t[0] === 'PRAGMA') {
      if (
        t.length !== 4 ||
        !['FOREIGN_KEYS', 'DEFER_FOREIGN_KEYS'].includes(t[1]!) ||
        t[2] !== '=' ||
        !['ON', 'OFF', 'TRUE', 'FALSE', '0', '1'].includes(t[3]!)
      )
        return fail('SOURCE_OPERATION_DENIED');
    } else if (t[0] === 'CREATE') {
      const kind = t[1] === 'UNIQUE' ? t[2] : t[1];
      if (
        !['TABLE', 'INDEX', 'TRIGGER', 'VIEW'].includes(kind ?? '') ||
        ++schemas > ORDERED_IMPORT_LIMITS.schemaObjects
      )
        return fail('SCHEMA_INVALID');
      let offset = t[1] === 'UNIQUE' ? 3 : 2;
      if (t[offset] === 'IF' && t[offset + 1] === 'NOT' && t[offset + 2] === 'EXISTS') offset += 3;
      const name = statement[offset]?.replace(/^[`"[]|[`"\]]$/gu, '');
      if (statement[offset + 1] === '.') return fail('SCHEMA_INVALID');
      if (!name || !identifier.test(name) || name.startsWith('_cf_') || names.has(name))
        return fail('SCHEMA_INVALID');
      names.add(name);
      if (kind === 'TRIGGER' || kind === 'VIEW') postData = true;
      if (kind === 'TABLE' && (t.includes('SELECT') || t.includes('GENERATED')))
        return fail('SCHEMA_INVALID');
      if ((kind === 'TABLE' || kind === 'INDEX') && t.includes('CONFLICT'))
        return fail('SCHEMA_CONFLICT_POLICY_DENIED');
      // Stored trigger/view bodies are not evaluated while decoding. Evaluated
      // table/index expressions must not allocate via concatenation/replacement.
      if ((kind === 'TABLE' || kind === 'INDEX') && t.includes('HEX'))
        return fail('SOURCE_EXPANSION_DENIED');
      for (let i = 0; i < t.length; i++) {
        if (t[i] !== '||' || (kind !== 'TABLE' && kind !== 'INDEX')) continue;
        const smallLiteral = (s: string | undefined) =>
          s !== undefined && /^'(?:''|[^'])*'$/u.test(s) && s.length <= 34;
        const smallChar = (at: number) =>
          t[at] === 'CHAR' &&
          t[at + 1] === '(' &&
          /^\d{1,3}$/u.test(t[at + 2] ?? '') &&
          Number(t[at + 2]) <= 255 &&
          t[at + 3] === ')';
        if (
          !(smallLiteral(statement[i - 1]) || smallChar(i - 4)) ||
          !(smallLiteral(statement[i + 1]) || smallChar(i + 1))
        )
          return fail('SOURCE_EXPANSION_DENIED');
      }
      for (let i = 0; i < t.length; i++) {
        if (kind !== 'TABLE' && kind !== 'INDEX') break;
        if (t[i] !== 'REPLACE' || t[i + 1] !== '(') continue;
        let depth = 0;
        const args: string[][] = [[]];
        for (let j = i + 2; j < t.length; j++) {
          if (++inspectionSteps > ORDERED_IMPORT_LIMITS.schemaInspectionSteps)
            return fail('RESOURCE_LIMIT');
          const token = statement[j]!;
          if (token === ')' && depth === 0) break;
          if (token === ',' && depth === 0) args.push([]);
          else {
            args[args.length - 1]!.push(token);
            if (token === '(') depth++;
            if (token === ')') depth--;
          }
        }
        // Current UUID constraints remove a short literal. Never permit
        // source-controlled expanding replacement, even in nested CHECKs.
        if (
          args.length !== 3 ||
          args[1]!.length !== 1 ||
          !/^'[^']{1,32}'$/u.test(args[1]![0]!) ||
          args[2]!.length !== 1 ||
          args[2]![0] !== "''"
        )
          return fail('SOURCE_REPLACEMENT_DENIED');
      }
      if (
        t.some(
          (token, index) =>
            t[index + 1] === '(' &&
            [
              'LOAD_EXTENSION',
              'READFILE',
              'WRITEFILE',
              'RANDOMBLOB',
              'ZEROBLOB',
              'PRINTF',
              'FORMAT',
            ].includes(token),
        )
      )
        return fail('SOURCE_UNSAFE_FUNCTION_DENIED');
    } else if (t[0] === 'INSERT' && t[1] === 'INTO' && !postData) {
      // Export data is VALUES-only: no SELECT/CTE, conflict suppression, general
      // functions, concatenation, arithmetic, defaults, or mutation side effects.
      const values = t.indexOf('VALUES');
      if (values < 3) return fail('SOURCE_OPERATION_DENIED');
      const data = statement.slice(values + 1);
      let at = 0;
      while (at < data.length) {
        if (data[at++] !== '(' || ++rows > ORDERED_IMPORT_LIMITS.rows)
          return fail('RESOURCE_LIMIT');
        let columns = 0;
        do {
          if (++columns > ORDERED_IMPORT_LIMITS.columns) return fail('RESOURCE_LIMIT');
          if (data[at]?.toUpperCase() === 'REPLACE') {
            at = newlineLiteralEnd(data, at);
            continue;
          }
          if (data[at]?.toUpperCase() === 'CAST') {
            if (
              data[at + 1] !== '(' ||
              !/^[xX]'(?:[0-9a-fA-F]{2})*'$/u.test(data[at + 2] ?? '') ||
              data[at + 3]?.toUpperCase() !== 'AS' ||
              data[at + 4]?.toUpperCase() !== 'TEXT' ||
              data[at + 5] !== ')'
            )
              return fail('SOURCE_VALUE_DENIED');
            at += 6;
            continue;
          }
          if (data[at] === '+' || data[at] === '-') at++;
          const v = data[at++];
          if (
            !v ||
            !/^(?:NULL|'(?:''|[^'])*'|[xX]'(?:[0-9a-fA-F]{2})*'|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/iu.test(
              v,
            )
          )
            return fail('SOURCE_VALUE_DENIED');
        } while (data[at] === ',' && ++at);
        if (data[at++] !== ')') return fail('SOURCE_VALUE_DENIED');
        if (at < data.length && data[at++] !== ',') return fail('SOURCE_VALUE_DENIED');
      }
      if (!data.length) return fail('SOURCE_SQL_INVALID');
    } else if (t.join(' ') === 'DELETE FROM SQLITE_SEQUENCE') {
      // Native dump's sole internal sequence reset, never application-table DELETE.
    } else
      return fail(
        t[0] === 'INSERT' && postData
          ? 'SOURCE_DATA_AFTER_TRIGGER'
          : t[0] === 'DELETE'
            ? 'SOURCE_DELETE_DENIED'
            : 'SOURCE_OPERATION_DENIED',
      );
  }
  if (!schemas) return fail('SCHEMA_INVALID');
}
const safeFunctions = new Set([
  'length',
  'trim',
  'lower',
  'upper',
  'instr',
  'typeof',
  'json_valid',
  'json_type',
  'json_extract',
  'coalesce',
  'ifnull',
  'abs',
  'round',
  'substr',
  'substring',

  'unicode',
  'glob',
  'like',
  'max',
  'min',
  'strftime',
  // SQLite prepares this fixed-size builtin for schema defaults even when
  // INSERT supplies every value. Literal VALUES and complete-column checks
  // still reject runtime/default-generated source data.
  'current_timestamp',
  'unixepoch',
  'julianday',
  // Fixed SQLite calendar CHECKs and bounded financial ledger totals.
  'date',
  'sum',
  'replace',
  'char',
]);
const literal = (value: SQLInputValue): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'string')
    return value.includes('\0')
      ? `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`
      : `'${value.replaceAll("'", "''")}'`;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('VALUE_UNSUPPORTED');
    const n = String(value);
    return /[.eE]/u.test(n) ? n : `${n}.0`;
  }
  return `X'${Buffer.from(value as Uint8Array).toString('hex')}'`;
};

/** One canonical reorder primitive. Caller verifies immutable source identity first.
 * Tables/indexes precede data; trigger/view code cannot run during source decoding.
 * Output is derived transport, never a replacement backup or a restore PASS. */
function decodeOrderedD1Import(exportSql: string, stagingPath: string): string {
  preflight(exportSql);
  closeSync(openSync(stagingPath, 'wx', 0o600));
  const staging = new DatabaseSync(stagingPath, {
    enableForeignKeyConstraints: false,
    allowExtension: false,
  });
  let deniedFunction = false;
  try {
    staging.enableDefensive(true);
    // Bound disk use before running source statements, and keep journal I/O
    // proportional to the database instead of committing each INSERT.
    staging.exec('PRAGMA page_size=4096; PRAGMA max_page_count=32768; BEGIN;');
    const tableColumns = new Map<string, string[]>();
    const authorize = (
      action: number,
      arg1: string | null,
      arg2: string | null,
      database: string | null,
    ) => {
      if (database !== null && database !== 'main') return constants.SQLITE_DENY;
      if (
        [
          constants.SQLITE_ATTACH,
          constants.SQLITE_DETACH,
          constants.SQLITE_SELECT,
          constants.SQLITE_CREATE_VTABLE,
          constants.SQLITE_DROP_VTABLE,
          constants.SQLITE_ALTER_TABLE,
          constants.SQLITE_TRANSACTION,
        ].includes(action)
      )
        return constants.SQLITE_DENY;
      if (
        action === constants.SQLITE_PRAGMA &&
        !['foreign_keys', 'defer_foreign_keys'].includes(arg1 ?? '')
      )
        return constants.SQLITE_DENY;
      if (action === constants.SQLITE_FUNCTION && !safeFunctions.has((arg2 ?? '').toLowerCase())) {
        deniedFunction = true;
        return constants.SQLITE_DENY;
      }
      if (
        [constants.SQLITE_UPDATE, constants.SQLITE_DELETE].includes(action) &&
        arg1 !== 'sqlite_master' &&
        arg1 !== 'sqlite_sequence'
      )
        return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    };
    for (const { tokens: statement, sql: originalStatement } of statements(exportSql)) {
      if (!statement.length) continue;
      if (statement[0]?.toUpperCase() === 'INSERT') {
        const table = statement[2]?.replace(/^[`"[]|[`"\]]$/gu, '');
        if (!table || !identifier.test(table)) return fail('SCHEMA_INVALID');
        let columns = tableColumns.get(table);
        if (!columns) {
          staging.setAuthorizer(null);
          columns = staging
            .prepare(`PRAGMA table_info("${table}")`)
            .all()
            .map((c) => String(c.name));
          tableColumns.set(table, columns);
        }
        if (!columns.length || columns.length > ORDERED_IMPORT_LIMITS.columns)
          return fail('SCHEMA_INVALID');
        const values = statement.findIndex((s) => s.toUpperCase() === 'VALUES');
        if (values !== 3) {
          const supplied = statement
            .slice(3, values)
            .filter((s) => !['(', ')', ','].includes(s))
            .map((s) => s.replace(/^[`"[]|[`"\]]$/gu, ''));
          if (
            supplied.length !== columns.length ||
            new Set(supplied).size !== columns.length ||
            columns.some((c) => !supplied.includes(c))
          )
            return fail('SOURCE_DEFAULTS_DENIED');
        }
      }
      staging.setAuthorizer(authorize);
      staging.exec(originalStatement);
    }
    staging.setAuthorizer(null);
    staging.exec('COMMIT;');
    if (staging.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
      return fail('DB_CONSTRAINT_FAILED');
    if (staging.prepare('PRAGMA foreign_key_check').all().length)
      return fail('FOREIGN_KEY_INVALID');
    const definitions = staging
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name",
      )
      .all() as Array<{ type: string; name: string; sql: string }>;
    if (
      !definitions.length ||
      definitions.some(
        (r) => !['table', 'index', 'trigger', 'view'].includes(r.type) || !identifier.test(r.name),
      )
    )
      return fail('SCHEMA_INVALID');
    for (const view of definitions.filter((r) => r.type === 'view')) {
      // Resolve references without stepping rows or evaluating source functions.
      staging.prepare(`SELECT * FROM "${view.name}" LIMIT 0`);
    }
    const sql = ['PRAGMA defer_foreign_keys=ON;'];
    let bytes = Buffer.byteLength(sql[0]!);
    const append = (line: string) => {
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > ORDERED_IMPORT_LIMITS.derivedBytes) return fail('RESOURCE_LIMIT');
      sql.push(line);
    };
    for (const kind of ['table', 'index'])
      for (const row of definitions.filter((r) => r.type === kind)) append(`${row.sql};`);
    let count = 0;
    for (const table of definitions.filter((r) => r.type === 'table')) {
      const info = staging.prepare(`PRAGMA table_info("${table.name}")`).all();
      if (!info.some((c) => Number(c.pk) > 0)) return fail('SCHEMA_PRIMARY_KEY_REQUIRED');
      const columns = info.map((c) => String(c.name));
      if (
        columns.some((c) => !identifier.test(c)) ||
        columns.length > ORDERED_IMPORT_LIMITS.columns
      )
        return fail('SCHEMA_INVALID');
      const values = staging.prepare(
        `SELECT ${columns.map((c) => `"${c}",typeof("${c}"),CASE WHEN typeof("${c}")='text' THEN CAST("${c}" AS BLOB) ELSE NULL END`).join(',')} FROM "${table.name}"`,
      );
      values.setReadBigInts(true);
      values.setReturnArrays(true);
      const data: string[] = [];
      for (const record of values.iterate()) {
        if (++count > ORDERED_IMPORT_LIMITS.rows) return fail('RESOURCE_LIMIT');
        const row = record as unknown as SQLInputValue[];
        const literals = columns.map((_, i) => {
          if (row[i * 3 + 1] !== 'text') return literal(row[i * 3]!);
          // node:sqlite TEXT getters may truncate at embedded NUL. Read the
          // exact SQLite text bytes as BLOB; only canonical UTF-8 is supported.
          const bytes = row[i * 3 + 2] as Uint8Array;
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          } catch {
            return fail('VALUE_UNSUPPORTED');
          }
          if (!Buffer.from(text).equals(bytes)) return fail('VALUE_UNSUPPORTED');
          return literal(text);
        });
        data.push(
          `INSERT INTO "${table.name}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES(${literals.join(',')});`,
        );
      }
      data.sort(lexical);
      for (const line of data) append(line);
    }
    if (staging.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) {
      const sequence = staging.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name');
      sequence.setReadBigInts(true);
      append('DELETE FROM sqlite_sequence;');
      for (const row of sequence.iterate())
        append(
          `INSERT INTO sqlite_sequence(name,seq) VALUES(${literal(row.name!)},${literal(row.seq!)});`,
        );
    }
    for (const row of definitions.filter((r) => r.type === 'trigger' || r.type === 'view'))
      append(`${row.sql};`);
    // Compatibility reset, NOT a validation gate: SQLite OFF can clear pending
    // deferred violations. Verified decoding and mandatory final FK readback
    // protect integrity; import success/OFF alone never proves a safe restore.
    append('PRAGMA defer_foreign_keys=OFF;');
    return sql.join('\n');
  } catch (error) {
    if (error instanceof OrderedImportFailure) throw error;
    const message = error instanceof Error ? error.message : '';
    return fail(
      deniedFunction
        ? 'SOURCE_FUNCTION_DENIED'
        : /database or disk is full/iu.test(message)
          ? 'RESOURCE_LIMIT'
          : /not authorized|prohibited/iu.test(message)
            ? 'SOURCE_AUTHORIZER_DENIED'
            : /no such table/iu.test(message)
              ? 'SOURCE_MISSING_TABLE'
              : 'SOURCE_SQL_INVALID',
    );
  } finally {
    staging.close();
  }
}

/** Synchronous SQLite decoding is preempted by an OS child timeout, not an
 * AbortSignal. No source-controlled functions, extensions, files or bindings.
 * Node heap budget is not a native SQLite total-memory guarantee; source/token/
 * row/output bounds remain mandatory. Only fixed decoder code is invoked. */
export function orderedD1Import(exportSql: string): string {
  preflight(exportSql);
  const directory = mkdtempSync(join(tmpdir(), 'mayi-ordered-decoder-'));
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--max-old-space-size=256',
        fileURLToPath(import.meta.url),
        '--decode-stdin',
      ],
      {
        cwd: directory,
        input: exportSql,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: ORDERED_IMPORT_LIMITS.derivedBytes + 65536,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => !/^(?:CLOUDFLARE_|MAYI_BACKUP_|NODE_OPTIONS$)/u.test(k),
          ),
        ),
      },
    );
    if (child.error) return fail('DECODER_RESOURCE_LIMIT');
    if (child.status !== 0) {
      const code = child.stderr.trim();
      return fail(/^[A-Z_]{1,64}$/u.test(code) ? code : 'DECODER_FAILED');
    }
    if (!child.stdout || Buffer.byteLength(child.stdout) > ORDERED_IMPORT_LIMITS.derivedBytes)
      return fail('RESOURCE_LIMIT');
    return child.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--decode-stdin') process.exit(2);
  try {
    const source = readFileSync(0, 'utf8');
    process.stdout.write(decodeOrderedD1Import(source, resolve('staging.sqlite')));
  } catch (error) {
    process.stderr.write(error instanceof OrderedImportFailure ? error.message : 'DECODER_FAILED');
    process.exitCode = 1;
  }
}
