/**
 * Repo-specific lint rules, loaded by oxlint as an ESLint-compatible JS plugin (`.oxlintrc.json` `jsPlugins`).
 * - `no-import-meta`: server/ and desktop/ ship as CommonJS bundles (esbuild --format=cjs) but type-check with bundler resolution,
 *   so tsc does not flag ESM-only `import.meta`.
 * - `no-builtin-pow`: powers go through `pow` (fdlibm, bit-identical on every engine) or `powInt` (exact products), never `**` / Math.pow.
 */
const noImportMeta = {
  meta: { type: 'problem', docs: { description: 'Disallow import.meta in CommonJS-bundled sources' } },
  create(context) {
    return {
      MetaProperty(node) {
        if (node.meta.name === 'import')
          context.report({ node, message: 'import.meta does not exist in the CommonJS server/desktop bundles.' });
      },
    };
  },
};

/** A numeric literal, or a negated one. */
const isNumberLiteral = (node) => {
  const literal = node.type === 'UnaryExpression' && node.operator === '-' ? node.argument : node;
  return literal.type === 'Literal' && typeof literal.value === 'number';
};

const noBuiltinPow = {
  meta: { type: 'problem', docs: { description: 'Use pow / powInt: the built-in power is not bit-identical across V8 versions' } },
  create(context) {
    const message =
      'Use pow(x, y) from @lib/pow (or powInt(x, n) for a small integer n): `x ** y` / Math.pow is not bit-identical across V8 versions (Node 22 vs 24, Electron). `x ** 2` and literal constants such as 2 ** 32 are exact and allowed.';
    return {
      BinaryExpression(node) {
        if (node.operator !== '**') return;
        const square = node.right.type === 'Literal' && node.right.value === 2;
        const constant = isNumberLiteral(node.left) && isNumberLiteral(node.right);
        if (!square && !constant) context.report({ node, message });
      },
      CallExpression(node) {
        const callee = node.callee;
        const isMathPow =
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'Math' &&
          callee.property.name === 'pow';
        if (isMathPow) context.report({ node, message });
      },
    };
  },
};

export default { meta: { name: 'llull' }, rules: { 'no-import-meta': noImportMeta, 'no-builtin-pow': noBuiltinPow } };
