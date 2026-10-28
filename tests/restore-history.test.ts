// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  verifyHistoryChain,
  type RestoreHistoryEdge,
} from '../scripts/recovery/renewal-history-proof';
const initial: RestoreHistoryEdge = {
  id: 'initial',
  from_state: null,
  to_state: 'CONTACT_PENDING',
  actor_kind: 'SYSTEM',
  reason_code: 'POLICY_EXPIRING',
  created_at: '2026-10-02T00:00:00.000Z',
};
const edge = (
  from: string,
  to: string,
  time = '2026-10-02T00:00:01.000Z',
  reason = 'STATE_CHANGE',
): RestoreHistoryEdge => ({
  id: crypto.randomUUID(),
  from_state: from,
  to_state: to,
  actor_kind: 'USER',
  reason_code: reason,
  created_at: time,
});
describe('restore renewal history causal chain', () => {
  it('returns only closures into the final expanded causal vertex in one timestamp bucket', () => {
    const first = edge('CONTACT_PENDING', 'WON', undefined, 'WON');
    const reopen = edge('WON', 'CONTACT_PENDING', undefined, 'WON_CORRECTED');
    const progress = edge('CONTACT_PENDING', 'QUOTE_PREPARING');
    const final = edge('QUOTE_PREPARING', 'WON', undefined, 'WON');
    for (const history of [
      [initial, first, reopen, progress, final],
      [final, progress, reopen, first, initial],
    ]) {
      expect(verifyHistoryChain(history, 'WON')).toEqual([final]);
    }
  });
  it('preserves interchangeable parallel final-stage closures without UUID ordering', () => {
    const first = edge('CONTACT_PENDING', 'WON', undefined, 'WON');
    const reopen = edge('WON', 'CONTACT_PENDING', undefined, 'WON_CORRECTED');
    const final = edge('CONTACT_PENDING', 'WON', undefined, 'WON');
    for (const history of [
      [initial, first, reopen, final],
      [final, reopen, first, initial],
    ]) {
      expect(verifyHistoryChain(history, 'WON')).toEqual(expect.arrayContaining([first, final]));
      expect(verifyHistoryChain(history, 'WON')).toHaveLength(2);
    }
  });
  it.each([
    'not-a-time',
    '2026-02-30T00:00:00.000Z',
    '2026-10-02T00:00:00Z',
    '2026-10-02T03:00:00.000+03:00',
  ])('rejects noncanonical initial timestamp %s', (created_at) => {
    expect(() => verifyHistoryChain([{ ...initial, created_at }], 'CONTACT_PENDING')).toThrow(
      'DB_DOMAIN_FAILED',
    );
  });
  it('rejects noncanonical timestamp in a later edge', () => {
    expect(() =>
      verifyHistoryChain(
        [initial, edge('CONTACT_PENDING', 'CONTACTED', 'not-a-time')],
        'CONTACTED',
      ),
    ).toThrow('DB_DOMAIN_FAILED');
  });
  it('requires canonical initial history', () => {
    expect(() => verifyHistoryChain([{ ...initial, to_state: 'CONTACTED' }], 'CONTACTED')).toThrow(
      'DB_DOMAIN_FAILED',
    );
  });
  it('rejects an unreachable terminal reopen', () => {
    expect(() =>
      verifyHistoryChain(
        [initial, edge('WON', 'CONTACT_PENDING', undefined, 'WON_CORRECTED')],
        'CONTACT_PENDING',
      ),
    ).toThrow('DB_DOMAIN_FAILED');
  });
  it('orders same-millisecond edges causally, never by random ID', () => {
    const a = edge('CONTACT_PENDING', 'CONTACTED'),
      b = edge('CONTACTED', 'QUOTE_PREPARING');
    expect(() => verifyHistoryChain([b, initial, a], 'QUOTE_PREPARING')).not.toThrow();
  });
  it('rejects disconnected edges even if the most recent edge ends at current state', () => {
    expect(() =>
      verifyHistoryChain([initial, edge('QUOTE_SENT', 'CONTACT_PENDING')], 'CONTACT_PENDING'),
    ).toThrow('DB_DOMAIN_FAILED');
  });
  it('does not reorder different timestamp buckets', () => {
    const a = edge('CONTACT_PENDING', 'CONTACTED', '2026-10-02T00:00:02.000Z');
    const b = edge('CONTACTED', 'QUOTE_PREPARING', '2026-10-02T00:00:01.000Z');
    expect(() => verifyHistoryChain([initial, a, b], 'QUOTE_PREPARING')).toThrow(
      'DB_DOMAIN_FAILED',
    );
  });
  it('accepts closure and exact previous-state reopen within one millisecond', () => {
    expect(() =>
      verifyHistoryChain(
        [
          edge('LOST', 'CONTACT_PENDING', undefined, 'REOPEN'),
          initial,
          edge('CONTACT_PENDING', 'LOST', undefined, 'LOST'),
        ],
        'CONTACT_PENDING',
      ),
    ).not.toThrow();
  });
  it('rejects reopen into a different state', () => {
    expect(() =>
      verifyHistoryChain(
        [
          initial,
          edge('CONTACT_PENDING', 'WON', undefined, 'WON'),
          edge('WON', 'CONTACTED', undefined, 'WON_CORRECTED'),
        ],
        'CONTACTED',
      ),
    ).toThrow('DB_DOMAIN_FAILED');
  });
  it('rejects SYSTEM terminal reopen even when the state chain could be joined', () => {
    expect(() =>
      verifyHistoryChain(
        [
          initial,
          edge('CONTACT_PENDING', 'WON', undefined, 'WON'),
          { ...edge('WON', 'CONTACT_PENDING', undefined, 'WON_CORRECTED'), actor_kind: 'SYSTEM' },
        ],
        'CONTACT_PENDING',
      ),
    ).toThrow('DB_DOMAIN_FAILED');
  });
  it('rejects wrong terminal reopen reason', () => {
    expect(() =>
      verifyHistoryChain(
        [
          initial,
          edge('CONTACT_PENDING', 'WON', undefined, 'WON'),
          edge('WON', 'CONTACT_PENDING', undefined, 'REOPEN'),
        ],
        'CONTACT_PENDING',
      ),
    ).toThrow('DB_DOMAIN_FAILED');
  });
  it('requires the whole chain to end at actual current state', () => {
    expect(() =>
      verifyHistoryChain([initial, edge('CONTACT_PENDING', 'CONTACTED')], 'QUOTE_PREPARING'),
    ).toThrow('DB_DOMAIN_FAILED');
  });
});
