// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('keeps quote and contact histories in natural flow and retains a bounded desktop queue', () => {
  const css = readFileSync('src/app/pages/today-work/today-work.css', 'utf8');
  const rule = (name: string) => css.match(new RegExp('\\.' + name + ' \\{([^}]+)\\}'))?.[1] ?? '';
  expect(rule('quote-history')).not.toMatch(/max-height|overflow/);
  expect(rule('interaction-timeline')).not.toMatch(/max-height|overflow/);
  expect(css).toContain('max-height: 65vh');
});
it('defines a local typography and accessible financial-workspace token foundation', () => {
  const css = readFileSync('src/app/theme.css', 'utf8');
  expect(css).toContain('--font-body:');
  expect(css).toContain('--surface-subtle:');
  expect(css).toContain('scrollbar-width: thin');
  expect(css).not.toContain('fonts.googleapis.com');
});
