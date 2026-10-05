/* eslint config — strict but pragmatic */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react-hooks'],
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
  overrides: [
    {
      files: ['src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts', 'server/src/**/*.ts'],
      rules: { 'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }] },
    },
    {
      // Plain-JS Node scripts (quality/*.mjs) cannot declare return types.
      files: ['*.mjs'],
      rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
    },
  ],
  ignorePatterns: ['dist', 'coverage', 'node_modules', '*.cjs'],
};
