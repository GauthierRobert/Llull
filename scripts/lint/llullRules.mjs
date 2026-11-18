/**
 * Repo-specific lint rules, loaded by oxlint as an ESLint-compatible JS plugin (`.oxlintrc.json` `jsPlugins`).
 * - `no-import-meta`: server/ and desktop/ ship as CommonJS bundles (esbuild --format=cjs) but type-check with bundler resolution,
 *   so tsc does not flag ESM-only `import.meta`.
 * - `no-integer-pow`: small integer powers go through `powInt` (exact IEEE products) so results do not depend on the V8 version.
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

/** The integer value of a numeric literal or a negated one, else null. */
function integerLiteral(node) {
  const literal = node.type === 'UnaryExpression' && node.operator === '-' ? node.argument : node;
  if (literal.type !== 'Literal' || typeof literal.value !== 'number' || !Number.isInteger(literal.value)) return null;
  return node === literal ? literal.value : -literal.value;
}

/** Exponents the rule covers: |n| from 3 to 8. `x ** 2` is exact everywhere; larger literals are powers of two written as constants. */
const smallIntegerPower = (node) => {
  const n = integerLiteral(node);
  return n !== null && Math.abs(n) >= 3 && Math.abs(n) <= 8;
};

const noIntegerPow = {
  meta: {
    type: 'problem',
    docs: { description: 'Use powInt for small integer powers: `x ** n` / Math.pow is not bit-identical across V8 versions' },
  },
  create(context) {
    const message =
      'Use powInt(x, n) from @lib/powInt: `x ** n` / Math.pow(x, n) is not bit-identical across V8 versions (Node 22 vs 24, Electron).';
    return {
      BinaryExpression(node) {
        if (node.operator === '**' && smallIntegerPower(node.right)) context.report({ node, message });
      },
      CallExpression(node) {
        const callee = node.callee;
        const isMathPow =
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'Math' &&
          callee.property.name === 'pow';
        if (isMathPow && node.arguments.length === 2 && smallIntegerPower(node.arguments[1])) context.report({ node, message });
      },
    };
  },
};

export default { meta: { name: 'llull' }, rules: { 'no-import-meta': noImportMeta, 'no-integer-pow': noIntegerPow } };
