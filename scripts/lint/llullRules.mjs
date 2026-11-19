/**
 * Repo-specific lint rules, loaded by oxlint as an ESLint-compatible JS plugin (`.oxlintrc.json` `jsPlugins`).
 * - `no-import-meta`: server/ and desktop/ ship as CommonJS bundles (esbuild --format=cjs) but type-check with bundler resolution,
 *   so tsc does not flag ESM-only `import.meta`.
 * - `no-builtin-pow`: powers go through `pow` (fdlibm, bit-identical on every engine) or `powInt` (exact products), never `**` / Math.pow.
 * - `no-spread-call`: no spread argument list (`f(...xs)`, `f.apply(t, xs)`, `f.call(t, ...xs)`, `Reflect.apply(f, t, xs)`) into
 *   Math.max / min / hypot, `.push` / `.unshift` / `.splice`, String.fromCharCode / fromCodePoint: it passes every element as a call
 *   argument and throws RangeError above ~1.5e5 items (PERF1 row 12). Use maxOf / minOf (@lib/arrayExtrema), hypotOf (@lib/hypotOf),
 *   appendAll (@lib/appendAll), spliceAll (@lib/spliceAll), or decode char codes in chunks.
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

/** Built-ins whose arguments a spread fills one per item: Math.max / min / hypot, String.fromCharCode / fromCodePoint. */
const SPREAD_STATIC_METHODS = { Math: new Set(['max', 'min', 'hypot']), String: new Set(['fromCharCode', 'fromCodePoint']) };
/** Array methods with a rest parameter, flagged on any receiver. */
const SPREAD_ARRAY_METHODS = new Set(['push', 'unshift', 'splice']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);

/** `node` without parentheses and TS-only wrappers (`(Math)`, `Math as typeof Math`, `Math!`). */
const unwrap = (node) =>
  node.type === 'ParenthesizedExpression' ||
  node.type === 'TSAsExpression' ||
  node.type === 'TSNonNullExpression' ||
  node.type === 'TSSatisfiesExpression'
    ? unwrap(node.expression)
    : node;

/** The property name of `x.name` / `x['name']` (optional chains included), else undefined. */
const memberName = (node) => {
  if (node.type !== 'MemberExpression') return undefined;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
  return undefined;
};

/** The global `name` (`Math`), or `globalThis.Math` / `window.Math` / `self.Math`. */
const isGlobal = (node, name) => {
  const target = unwrap(node);
  if (target.type === 'Identifier') return target.name === name;
  return memberName(target) === name && unwrap(target.object).type === 'Identifier' && GLOBAL_OBJECTS.has(unwrap(target.object).name);
};

/** A function whose call throws RangeError past the engine's argument limit when a big array is spread into it. */
const isSpreadSensitive = (node) => {
  const callee = unwrap(node);
  const method = memberName(callee);
  if (method === undefined) return false;
  if (SPREAD_ARRAY_METHODS.has(method)) return true;
  return Object.entries(SPREAD_STATIC_METHODS).some(([owner, methods]) => methods.has(method) && isGlobal(callee.object, owner));
};

/** `f.apply(t, xs)` or `Reflect.apply(f, t, xs)` on a spread-sensitive f: the whole list goes in as arguments. */
const isApplyOfSensitive = (callee, args) => {
  if (memberName(callee) !== 'apply') return false;
  if (isGlobal(callee.object, 'Reflect')) return args[0] !== undefined && isSpreadSensitive(args[0]);
  return isSpreadSensitive(callee.object);
};

/** `f(…)` or `f.call(t, …)` on a spread-sensitive f. */
const spreadsInto = (callee) => isSpreadSensitive(callee) || (memberName(callee) === 'call' && isSpreadSensitive(callee.object));

const noSpreadCall = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow spread / apply argument lists in Math.max / min / hypot, push / unshift / splice, String.fromCharCode / fromCodePoint',
    },
  },
  create(context) {
    const message =
      'A spread (or apply) argument list throws RangeError above ~1.5e5 items: use maxOf / minOf from @lib/arrayExtrema, hypotOf from @lib/hypotOf, appendAll from @lib/appendAll, spliceAll from @lib/spliceAll, a chunked String.fromCharCode, or name the components of a small tuple.';
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (isApplyOfSensitive(callee, node.arguments)) context.report({ node, message });
        else if (spreadsInto(callee))
          for (const argument of node.arguments) if (argument.type === 'SpreadElement') context.report({ node: argument, message });
      },
    };
  },
};

export default {
  meta: { name: 'llull' },
  rules: { 'no-import-meta': noImportMeta, 'no-builtin-pow': noBuiltinPow, 'no-spread-call': noSpreadCall },
};
