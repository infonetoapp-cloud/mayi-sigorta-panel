import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.wrangler/**',
      '_archive/**',
      'MayiSigorta_CRM_Planning_Pack_v2/**',
      'AGENTS.md',
      'v4-evidence/**',
      'customer360-evidence/**',
      'portfolio-evidence/**',
      'dashboard-evidence/**',
      'functional-evidence/**',
      'personnel-evidence/**',
      'catalog-evidence/**',
      'ux003-evidence/**',
      'v4-checkpoint-evidence/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
);
