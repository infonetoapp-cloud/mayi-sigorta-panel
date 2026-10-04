// Offline snapshot verification; no authority, database mutation or application import.
export interface RestoreHistoryEdge {
  id: string;
  from_state: string | null;
  to_state: string;
  actor_kind: string;
  reason_code: string;
  created_at: string;
}
const open = new Set([
  'CONTACT_PENDING',
  'CONTACTED',
  'QUOTE_PREPARING',
  'QUOTE_SENT',
  'AWAITING_RESPONSE',
]);
const terminal = new Set(['WON', 'LOST', 'VOIDED']);
const reject: () => never = () => {
  throw new Error('DB_DOMAIN_FAILED');
};

// Timestamp buckets are ordered; equal-millisecond edges are ordered by their
// causal endpoints, not UUIDs. Expanded terminal vertices remember the closed
// open state, so a reopen cannot resume an unrelated stage. Euler traversal is
// linear in edges (bounded by the harness row cap), not factorial permutation.
export function verifyHistoryChain<T extends RestoreHistoryEdge>(
  history: readonly T[],
  currentState: string,
): readonly T[] {
  for (const edge of history) {
    const timestamp = Date.parse(edge.created_at);
    if (
      edge.created_at.length !== 24 ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString() !== edge.created_at
    )
      reject();
  }
  const initial = history.filter((e) => e.from_state === null);
  if (initial.length !== 1) reject();
  const first = initial[0]!;
  if (
    first.to_state !== 'CONTACT_PENDING' ||
    first.actor_kind !== 'SYSTEM' ||
    first.reason_code !== 'POLICY_EXPIRING'
  )
    reject();
  const groups = new Map<string, Array<{ from: string; to: string }>>();
  for (const e of history) {
    if (e === first) continue;
    const from = e.from_state;
    if (
      from === null ||
      e.actor_kind !== 'USER' ||
      from === e.to_state ||
      e.created_at < first.created_at
    )
      reject();
    if (
      (!open.has(from) && !terminal.has(from)) ||
      (!open.has(e.to_state) && !terminal.has(e.to_state))
    )
      reject();
    if (terminal.has(from)) {
      if (!open.has(e.to_state) || e.reason_code !== (from === 'WON' ? 'WON_CORRECTED' : 'REOPEN'))
        reject();
    }
    if (terminal.has(e.to_state)) {
      if (
        !open.has(from) ||
        (e.to_state === 'WON' && e.reason_code !== 'WON') ||
        (e.to_state === 'LOST' && e.reason_code !== 'LOST')
      )
        reject();
    }
    const expandedFrom = terminal.has(from) ? `${from}@${e.to_state}` : from;
    const expandedTo = terminal.has(e.to_state) ? `${e.to_state}@${from}` : e.to_state;
    const bucket = groups.get(e.created_at) ?? [];
    bucket.push({ from: expandedFrom, to: expandedTo });
    groups.set(e.created_at, bucket);
  }
  let cursor = 'CONTACT_PENDING';
  let lastTime = first.created_at;
  for (const time of [...groups.keys()].sort()) {
    lastTime = time;
    const bucket = groups.get(time)!;
    const outgoing = new Map<string, Array<{ from: string; to: string }>>();
    for (const edge of bucket) {
      const edges = outgoing.get(edge.from) ?? [];
      edges.push(edge);
      outgoing.set(edge.from, edges);
    }
    const vertices = [cursor],
      traversed: Array<{ from: string; to: string }> = [],
      result: Array<{ from: string; to: string }> = [];
    while (vertices.length) {
      const edge = outgoing.get(vertices[vertices.length - 1]!)?.pop();
      if (edge) {
        vertices.push(edge.to);
        traversed.push(edge);
      } else {
        vertices.pop();
        const finished = traversed.pop();
        if (finished) result.push(finished);
      }
    }
    if (result.length !== bucket.length) reject();
    for (const edge of result.reverse()) {
      if (edge.from !== cursor) reject();
      cursor = edge.to;
    }
  }
  if (cursor.split('@')[0] !== currentState) reject();
  if (!terminal.has(currentState)) return [];
  // Only incoming edges to the final expanded vertex can be the last closure.
  // Parallel edges into that vertex have identical endpoints and are interchangeable;
  // return all of them so persisted closure evidence can select a coherent ending
  // without relying on insertion/UUID order or exponential path enumeration.
  return history.filter(
    (e) =>
      e.created_at === lastTime &&
      e.to_state === currentState &&
      e.from_state === cursor.split('@')[1],
  );
}
