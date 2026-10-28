import { describe, expect, it, vi } from 'vitest';
import {
  OptimisticConcurrencyError,
  runExactlyOneVersionedMutation,
} from '../src/server/db/optimistic';

function statementWithChanges(changes: number, success = true): D1PreparedStatement {
  return {
    run: vi.fn().mockResolvedValue({
      success,
      meta: { changes },
      results: [],
    }),
  } as unknown as D1PreparedStatement;
}

describe('M1-T03 optimistic concurrency sonucu', () => {
  it('tek satır değişen conditional mutation başarılıdır', async () => {
    await expect(runExactlyOneVersionedMutation(statementWithChanges(1))).resolves.toBeDefined();
  });

  it('stale version nedeniyle sıfır satır değişmesi conflict üretir', async () => {
    await expect(runExactlyOneVersionedMutation(statementWithChanges(0))).rejects.toBeInstanceOf(
      OptimisticConcurrencyError,
    );
  });

  it('birden fazla satır değişmesi de invariant ihlalidir', async () => {
    await expect(runExactlyOneVersionedMutation(statementWithChanges(2))).rejects.toBeInstanceOf(
      OptimisticConcurrencyError,
    );
  });

  it('D1 başarısız sonucu başarılı mutation olarak kabul edilmez', async () => {
    await expect(runExactlyOneVersionedMutation(statementWithChanges(1, false))).rejects.toThrow(
      'D1_MUTATION_FAILED',
    );
  });
});
