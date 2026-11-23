import type { DatabaseSync } from 'node:sqlite';
import { iterateDerivedRestoreStatements, ORDERED_IMPORT_LIMITS } from './ordered-d1-import';
const ident = /^[a-z][a-z0-9_]*$/u;
const unquote = (s: string) => s.replace(/^[`"[]|[`"\]]$/gu, '');
export interface ForeignKeyEdge {
  child: string;
  parent: string;
  id: number;
  from: string[];
  to: Array<string | null>;
  onDelete: string;
  onUpdate: string;
}
/** Canonical schema/read-only aggregate queries only. No row values in this report. */
export function inspectForeignKeyGraph(db: DatabaseSync, materialized = false) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name",
    )
    .all()
    .map((r) => String(r.name));
  if (tables.length > 256 || tables.some((t) => !ident.test(t)))
    throw new Error('GRAPH_SCHEMA_INVALID');
  const edges: ForeignKeyEdge[] = [];
  const rowCounts: Record<string, number> = {};
  for (const child of tables) {
    const rows = db.prepare(`PRAGMA foreign_key_list("${child}")`).all();
    if (rows.length > 1000) throw new Error('GRAPH_RESOURCE_LIMIT');
    const groups = new Map<number, typeof rows>();
    for (const row of rows) {
      const id = Number(row.id);
      const list = groups.get(id) ?? [];
      list.push(row);
      groups.set(id, list);
    }
    rowCounts[child] = Number(db.prepare(`SELECT count(*) AS n FROM "${child}"`).get()!.n);
    for (const [id, list] of groups) {
      list.sort((a, b) => Number(a.seq) - Number(b.seq));
      const r = list[0]!;
      const from = list.map((r) => String(r.from));
      if (from.some((c) => !ident.test(c)) || !tables.includes(String(r.table)))
        throw new Error('GRAPH_SCHEMA_INVALID');
      if (materialized) {
        const n = Number(
          db
            .prepare(
              `SELECT count(*) AS n FROM "${child}" WHERE ${from.map((c) => `"${c}" IS NOT NULL`).join(' AND ')}`,
            )
            .get()!.n,
        );
        if (n === 0) continue;
      }
      edges.push({
        child,
        parent: String(r.table),
        id,
        from,
        to: list.map((r) => (r.to === null ? null : String(r.to))),
        onDelete: String(r.on_delete),
        onUpdate: String(r.on_update),
      });
    }
  }
  edges.sort(
    (a, b) =>
      a.child.localeCompare(b.child, 'en') || a.parent.localeCompare(b.parent, 'en') || a.id - b.id,
  );
  const nodes = materialized ? tables.filter((t) => rowCounts[t]! > 0) : tables;
  const parents = new Map(
    nodes.map((n) => [
      n,
      Array.from(new Set(edges.filter((e) => e.child === n).map((e) => e.parent))).sort(),
    ]),
  );
  let next = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    active = new Set<string>(),
    components: string[][] = [];
  function visit(n: string) {
    indices.set(n, next);
    low.set(n, next++);
    stack.push(n);
    active.add(n);
    for (const p of parents.get(n) ?? []) {
      if (!nodes.includes(p)) throw new Error('GRAPH_DATA_PARENT_MISSING');
      if (!indices.has(p)) {
        visit(p);
        low.set(n, Math.min(low.get(n)!, low.get(p)!));
      } else if (active.has(p)) low.set(n, Math.min(low.get(n)!, indices.get(p)!));
    }
    if (low.get(n) === indices.get(n)) {
      const component: string[] = [];
      let v: string;
      do {
        v = stack.pop()!;
        active.delete(v);
        component.push(v);
      } while (v !== n);
      components.push(component.sort());
    }
  }
  for (const n of nodes) if (!indices.has(n)) visit(n);
  const cycles = components
    .filter((c) => c.length > 1 || edges.some((e) => e.child === c[0] && e.parent === c[0]))
    .sort((a, b) => a.join(',').localeCompare(b.join(','), 'en'));
  const ordered: string[] = [];
  const visited = new Set<string>();
  function order(n: string) {
    if (visited.has(n)) return;
    visited.add(n);
    for (const p of parents.get(n) ?? []) order(p);
    ordered.push(n);
  }
  if (!cycles.length) for (const n of nodes) order(n);
  return {
    scope: materialized ? 'NON_NULL_ROW_DEPENDENCIES' : 'CANONICAL_SCHEMA',
    tables: nodes,
    foreignKeyConstraints: edges.length,
    edges,
    cycles,
    parentFirstOrder: cycles.length ? null : ordered,
    restrictConstraints: edges.filter((e) => e.onDelete === 'RESTRICT' || e.onUpdate === 'RESTRICT')
      .length,
    rowCounts,
  };
}
export function describeOrderedImport(sql: string) {
  if (Buffer.byteLength(sql) > ORDERED_IMPORT_LIMITS.derivedBytes)
    throw new Error('STRUCTURE_RESOURCE_LIMIT');
  let totalStatements = 0,
    createTables = 0,
    createIndexes = 0,
    insertStatements = 0,
    triggers = 0,
    views = 0,
    maxStatementBytes = 0,
    firstData = Infinity,
    lastData = -1,
    firstTrigger = Infinity;
  const pragmas: string[] = [],
    definitions = new Map<string, number>();
  let sqliteSequencePresent = false;
  const viewEntries: Array<{ tokens: string[]; index: number }> = [];
  for (const statement of iterateDerivedRestoreStatements(sql)) {
    const index = totalStatements++;
    const t = statement.tokens.map((x) => x.toUpperCase());
    maxStatementBytes = Math.max(maxStatementBytes, Buffer.byteLength(statement.sql));
    if (t[0] === 'PRAGMA') pragmas.push(t.join(' '));
    if (t[0] === 'CREATE') {
      const kind = t[1] === 'UNIQUE' ? t[2] : t[1];
      let at = t[1] === 'UNIQUE' ? 3 : 2;
      if (t[at] === 'IF') at += 3;
      definitions.set(unquote(statement.tokens[at]!), index);
      if (kind === 'TABLE') createTables++;
      if (kind === 'INDEX') createIndexes++;
      if (kind === 'TRIGGER') {
        triggers++;
        firstTrigger = Math.min(firstTrigger, index);
      }
      if (kind === 'VIEW') {
        views++;
        viewEntries.push({ tokens: statement.tokens, index });
      }
    }
    if (t[0] === 'INSERT') {
      insertStatements++;
      firstData = Math.min(firstData, index);
      lastData = index;
    }
    if (statement.tokens.some((x) => unquote(x) === 'sqlite_sequence'))
      sqliteSequencePresent = true;
  }
  let viewsReferenceLaterCreatedObjects = false;
  for (const v of viewEntries)
    for (let i = 0; i < v.tokens.length - 1; i++)
      if (['FROM', 'JOIN'].includes(v.tokens[i]!.toUpperCase())) {
        const index = definitions.get(unquote(v.tokens[i + 1]!));
        if (index !== undefined && index > v.index) viewsReferenceLaterCreatedObjects = true;
      }
  return {
    scope: 'SAFE_STRUCTURAL_METADATA_ONLY',
    totalStatements,
    createTables,
    createIndexes,
    insertStatements,
    triggers,
    views,
    pragmaSequence: pragmas,
    largestStatementBytes: maxStatementBytes,
    totalDerivedBytes: Buffer.byteLength(sql),
    sqliteSequencePresent,
    triggerDuringDataLoad: firstTrigger < lastData && firstData !== Infinity,
    viewsReferenceLaterCreatedObjects,
  };
}
