import { globalIgnores } from 'eslint/config';
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript';
import pluginVue from 'eslint-plugin-vue';
import skipFormatting from 'eslint-config-prettier/flat';

export default defineConfigWithVueTs(
  { name: 'app/files-to-lint', files: ['**/*.{vue,ts,mts}'] },
  globalIgnores(['**/dist/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**']),
  // eslint-plugin-vue's flat "recommended" set is the Vue 3 recommended ruleset (formerly plugin:vue/vue3-recommended).
  ...pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  {
    name: 'app/project-conventions',
    rules: {
      'vue/block-lang': ['error', { script: { lang: 'ts' } }],
      'vue/component-api-style': ['error', ['script-setup']],
      'vue/define-props-declaration': ['error', 'type-based'],
      'vue/define-emits-declaration': ['error', 'type-based'],
      'vue/component-name-in-template-casing': ['error', 'PascalCase'],
      'vue/require-explicit-emits': 'error',
      'vue/prefer-use-template-ref': 'error',
      // Raw HTML is an XSS risk; interpolation escapes everything.
      'vue/no-v-html': 'error',
      // Optional props are typed `T | undefined`; placeholder defaults would add nothing.
      'vue/require-default-prop': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  skipFormatting,
);
