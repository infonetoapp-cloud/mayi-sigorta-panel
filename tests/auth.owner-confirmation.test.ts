// @vitest-environment node
import { expect, it } from 'vitest';
import { prepareOwnerConfirmation } from '../src/server/auth/admin';
const cli = await import('../scripts/' + 'local-auth-admin.mjs');
const target = {
  mode: 'bootstrap' as const,
  accountId: 'a'.repeat(32),
  databaseId: '00000000-0000-4000-8000-000000000027',
  agencyId: 'synthetic-agency',
  ownerUserId: 'synthetic-owner',
  email: '  OWNER@Example.Invalid ',
  name: ' Synthetic Owner ',
  operationKey: 'synthetic-bootstrap-key',
};
it('validates and normalizes OWNER confirmation with the exact domain function', () => {
  const prepare = prepareOwnerConfirmation;
  const result = prepare(target);
  expect(JSON.parse(result.token)).toEqual({
    mode: 'bootstrap',
    accountId: target.accountId,
    databaseId: target.databaseId,
    agencyId: target.agencyId,
    ownerUserId: target.ownerUserId,
    email: 'owner@example.invalid',
    operationKey: target.operationKey,
  });
  expect(result.target.name).toBe('Synthetic Owner');
  expect(prepare({ ...target, email: 'owner@example.invalid' }).token).toBe(result.token);
  expect(cli.adminConfirmationTuple(target, prepare)).toBe(result.token);
});

it.each([
  { mode: 'break-glass' },
  { accountId: 'b'.repeat(32) },
  { databaseId: '00000000-0000-4000-8000-000000000028' },
  { agencyId: 'another-agency' },
  { ownerUserId: 'another-owner' },
  { email: 'another@example.invalid' },
  { operationKey: 'another-operation' },
])('every authority/identity/key field changes the expected token (%#)', (delta) => {
  expect(prepareOwnerConfirmation({ ...target, ...delta }).token).not.toBe(
    prepareOwnerConfirmation(target).token,
  );
});

it('JSON framing prevents separator collisions and escapes terminal control strings', () => {
  const first = prepareOwnerConfirmation({ ...target, agencyId: 'a:b', ownerUserId: 'c' });
  const second = prepareOwnerConfirmation({ ...target, agencyId: 'a', ownerUserId: 'b:c' });
  expect(first.token).not.toBe(second.token);
  const escaped = prepareOwnerConfirmation({ ...target, ownerUserId: 'owner:"\\\n' });
  expect(JSON.parse(escaped.token).ownerUserId).toBe('owner:"\\\n');
  expect(escaped.token).not.toContain('\n');
});

it('display name is trimmed/validated but not part of token; inputs are snapshotted', () => {
  const input = { ...target };
  const result = prepareOwnerConfirmation(input);
  input.email = 'another@example.invalid';
  expect(result.target.email).toBe('owner@example.invalid');
  expect(Object.isFrozen(result.target)).toBe(true);
  expect(prepareOwnerConfirmation({ ...target, name: 'Different Name' }).token).toBe(result.token);
  expect(JSON.parse(result.token)).not.toHaveProperty('name');
});

it.each([
  { email: 'invalid' },
  { name: ' ' },
  { operationKey: 'short' },
  { temporaryPassword: 'forbidden' },
  { CLOUDFLARE_API_KEY: 'forbidden' },
  { CLOUDFLARE_EMAIL: 'forbidden' },
  { CLOUDFLARE_API_TOKEN: 'forbidden' },
])('invalid identity and extra secret fields are rejected (%#)', (delta) => {
  expect(() => prepareOwnerConfirmation({ ...target, ...delta })).toThrow();
});

it('agency confirmation remains its existing tuple; OWNER callers require domain canonicalizer', () => {
  const agency = {
    mode: 'provision-agency',
    accountId: target.accountId,
    databaseId: target.databaseId,
    agencyId: target.agencyId,
    operationKey: target.operationKey,
  };
  expect(cli.adminConfirmationTuple(agency)).toBe(
    `provision-agency:${target.accountId}:${target.databaseId}:${target.agencyId}:${target.operationKey}`,
  );
  expect(cli.adminConfirmationTuple({ ...agency, operationKey: 'another-operation' })).not.toBe(
    cli.adminConfirmationTuple(agency),
  );
  expect(() => cli.adminConfirmationTuple(target)).toThrow(
    'OWNER_CONFIRMATION_CANONICALIZER_REQUIRED',
  );
  expect(Object.keys(JSON.parse(prepareOwnerConfirmation(target).token))).toEqual([
    'mode',
    'accountId',
    'databaseId',
    'agencyId',
    'ownerUserId',
    'email',
    'operationKey',
  ]);
});
