// @vitest-environment node
import { expect, it } from 'vitest';
import { evaluateBackupWindow, interpretFreshnessScalar } from '../scripts/canary/backup-alert';
const now = 18000000;
it.each([
  ['healthy', [now - 1], 'NO_ALERT'],
  ['empty', [], 'ALERT'],
  ['just inside', [now - 2700000 + 1], 'NO_ALERT'],
  ['exact inclusive cutoff', [now - 2700000], 'NO_ALERT'],
  ['just outside', [now - 2700000 - 1], 'ALERT'],
  ['multiple', [now - 2700000 + 1, now - 1], 'NO_ALERT'],
  ['duplicate', [now - 1, now - 1], 'NO_ALERT'],
  ['no-data', null, 'DIAGNOSTIC'],
  ['query-error', { error: true }, 'DIAGNOSTIC'],
] as const)(
  'logical45m missingness %s is never silently healthy on unknown input',
  (_name, events, verdict) => {
    expect(evaluateBackupWindow(events, now)).toBe(verdict);
  },
);
it('fractional provider evaluation cannot be accepted as exact Boolean missingness', () => {
  for (const value of [0.2, 0.25, 0.4, NaN, null, { error: true }])
    expect(interpretFreshnessScalar(value)).toBe('DIAGNOSTIC');
});
