import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      '**/routeTree.gen.ts',
      '**/worker-configuration.d.ts',
      'apps/api/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // packages/core must stay framework-free and portable: browser, Node, and Workers.
  {
    files: ['packages/core/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'crypto', 'stream'],
              message: 'packages/core must not depend on Node built-ins.',
            },
            {
              group: ['@skysa/web', '@skysa/api', '**/apps/**'],
              message: 'packages/core must not import from apps/*.',
            },
          ],
        },
      ],
    },
  },
  // Only worker.ts may read the Workers env.
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/worker.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message: 'apps/api reads env only in src/worker.ts; take config via createApp(options).',
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['**/*.config.{js,ts}', '**/vitest.config.ts', 'apps/api/drizzle.config.ts'],
    languageOptions: { globals: globals.node },
  },
  prettier,
)
