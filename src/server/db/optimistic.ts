export class OptimisticConcurrencyError extends Error {
  readonly code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';

  constructor(changes: number) {
    super(`OPTIMISTIC_CONCURRENCY_CONFLICT:${changes}`);
    this.name = 'OptimisticConcurrencyError';
  }
}

/**
 * Runs a conditional D1 mutation whose WHERE clause includes the expected version.
 * D1 treats a zero-row UPDATE as a successful statement, so callers must convert
 * any result other than exactly one changed row into a conflict.
 */
export async function runExactlyOneVersionedMutation(
  statement: D1PreparedStatement,
): Promise<D1Result<unknown>> {
  const result = await statement.run();
  if (!result.success) {
    throw new Error('D1_MUTATION_FAILED');
  }
  if (result.meta.changes !== 1) {
    throw new OptimisticConcurrencyError(result.meta.changes);
  }
  return result;
}
