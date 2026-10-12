/* ESLint flat config — strict but pragmatic. */
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Isolated agent worktrees hold full repo copies; never lint them twice.
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.cjs',
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': ['warn', { additionalHooks: '(useDisposable)' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports', disallowTypeAnnotations: false },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts', 'server/src/**/*.ts'],
    rules: { 'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }] },
  },
  {
    // Plain-JS Node scripts (quality/*.mjs) cannot declare return types.
    files: ['**/*.mjs', '**/*.js'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },
);
