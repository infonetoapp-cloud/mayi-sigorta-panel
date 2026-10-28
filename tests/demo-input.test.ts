// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const modulePath = '../scripts/demo/input.mjs';
const helpers = (await import(modulePath)) as {
  parseDemoArguments(args: string[]): { visibleInput: boolean };
  readDemoPasswords(
    users: Array<{ name: string; email: string }>,
    options: {
      visibleInput: boolean;
      input: PassThrough;
      output: PassThrough;
      masked: (prompt: string) => Promise<string>;
    },
  ): Promise<string[]>;
};
const users = ['Sahip', 'Ahmet', 'Ayşe'].map((name) => ({ name, email: name + '@demo.invalid' }));
const secret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
it('accepts only the explicit visible flag; masked is default and credential arguments deny', () => {
  expect(helpers.parseDemoArguments([])).toEqual({ visibleInput: false });
  expect(helpers.parseDemoArguments(['--visible-input'])).toEqual({ visibleInput: true });
  for (const args of [
    ['--password', secret()],
    ['--visible-input=' + secret()],
    ['--visible-input', secret()],
    ['--visible-input', '--visible-input'],
    ['--unknown'],
  ])
    expect(() => helpers.parseDemoArguments(args)).toThrow('DEMO_ARGUMENTS_INVALID');
});
it('zero-input CLI rejects obsolete manual-input flags and unknown options without echoing arguments', () => {
  for (const [args, expected] of [
    [['--visible-input'], 'Yerel demo başlatılamadı'],
    [['--unknown'], 'Yerel demo başlatılamadı'],
  ] as const) {
    const child = spawnSync(process.execPath, [resolve('scripts/demo/start.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(expected);
    expect(child.stdout).toBe('');
  }
});
async function collect(values: string[], visibleInput = true) {
  const input = new PassThrough(),
    output = new PassThrough();
  const raw = vi.fn(() => {
    throw new Error('RAW_MODE_FORBIDDEN');
  });
  Object.assign(input, { isTTY: true, setRawMode: raw });
  const masked = vi.fn(async () => values.shift()!);
  let prompts = 0,
    transcript = '';
  output.on('data', (chunk) => {
    transcript += String(chunk);
    if (String(chunk).includes('parolası:') || String(chunk) === 'Tekrar: ') {
      const value = values[prompts++];
      if (value === undefined) setImmediate(() => input.end());
      else setImmediate(() => input.write(value + '\r\n'));
    }
  });
  const result = await helpers.readDemoPasswords(users, { visibleInput, input, output, masked });
  return { result, raw, masked, transcript };
}
it('reads three confirmed lines including pasted Unicode and CRLF without raw mode or custom masked input', async () => {
  const values = [secret(), secret() + 'İı ş', secret()];
  const result = await collect(values.flatMap((value) => [value, value]));
  expect(result.result).toEqual(values);
  expect(result.raw).not.toHaveBeenCalled();
  expect(result.masked).not.toHaveBeenCalled();
  expect(result.transcript).toMatch(/GÖRÜNÜR/);
  for (const value of values) expect(result.transcript).not.toContain(value);
});
it('keeps masked collection as default without a visible warning', async () => {
  const values = [secret(), secret(), secret()];
  const result = await collect(
    values.flatMap((value) => [value, value]),
    false,
  );
  expect(result.result).toEqual(values);
  expect(result.masked).toHaveBeenCalledTimes(6);
  expect(result.transcript).not.toContain('GÖRÜNÜR');
});
it.each(['confirmation', 'minimum', 'distinct', 'EOF'])(
  'rejects invalid %s input instead of starting the demo',
  async (kind) => {
    const a = secret(),
      b = secret(),
      c = secret();
    const values =
      kind === 'confirmation'
        ? [a, b]
        : kind === 'minimum'
          ? ['short', 'short']
          : kind === 'distinct'
            ? [a, a, a, a, c, c]
            : [];
    await expect(collect(values)).rejects.toThrow(
      kind === 'confirmation'
        ? 'Parolalar eşleşmedi'
        : kind === 'minimum'
          ? '15–128'
          : kind === 'distinct'
            ? 'Üç farklı'
            : 'iptal',
    );
  },
);
