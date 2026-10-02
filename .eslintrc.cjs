/* eslint config — strict but pragmatic */
// MG0.3 ratchet: files still above 500 code lines; the list may only shrink (MG6.4 → 0).
const maxLinesAllowlist = require('./.eslint-max-lines-allowlist.json');

module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react-hooks'],
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  overrides: [
    {
      files: ['src/**/*.{ts,tsx}', 'server/src/**/*.ts'],
      rules: { 'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }] },
    },
    ...(maxLinesAllowlist.length > 0
      ? [{ files: maxLinesAllowlist, rules: { 'max-lines': 'off' } }]
      : []),
  ],
  ignorePatterns: ['dist', 'coverage', 'node_modules', '*.cjs'],
};
