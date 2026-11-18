// ESLint flat config for the Node.js packages (contracts, worker, console server, regional app, edge router).
// The Vue app has its own config in apps/console/web, with the Vue rules.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'apps/console/web/**', 'infra/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // Workflow code runs in Temporal's deterministic sandbox: wall-clock time, randomness and timers must come from
    // the SDK (workflow time, uuid4, sleep), never from the host.
    files: ['apps/worker/src/workflows/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Use sleep() from @temporalio/workflow.' },
        { name: 'setInterval', message: 'Use a loop with sleep() from @temporalio/workflow.' },
        { name: 'fetch', message: 'Workflows do no I/O: call an activity.' },
      ],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'Workflows cannot use Node.js modules: call an activity.' },
            {
              group: ['**/activities/*', '**/adapters/*'],
              message: 'Workflows reach activities through proxies only.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/edge-router/**/*.js'],
    languageOptions: {
      globals: {
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  prettier,
);
