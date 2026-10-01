/**
 * Source identifiers for generated code: collision-free names that are legal in Python, OpenSCAD
 * and FreeCAD, and translation of llull expressions onto those names.
 *
 * @layer core/codegen
 * @pure
 */

/** Identifiers that must never be used for a parameter or a variable in any target language. */
const RESERVED = new Set([
  // Python keywords + builtins the generated code relies on
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  'match',
  'case',
  'print',
  'range',
  'len',
  'min',
  'max',
  'abs',
  'round',
  'float',
  'int',
  'list',
  'tuple',
  'dict',
  'str',
  'math',
  'pi',
  'cq',
  'bd',
  'App',
  'Part',
  'Base',
  'FreeCAD',
  'doc',
  'result',
  // OpenSCAD keywords
  'module',
  'function',
  'let',
  'each',
  'true',
  'false',
  'undef',
  'include',
  'use',
  // llull runtime helpers emitted in generated code
  'param',
  'box',
  'cylinder',
  'sphere',
  'cone',
  'torus',
  'wedge',
  'pyramid',
  'extrude',
  'revolve',
  'mesh',
  'union',
  'cut',
  'intersect',
  'translate',
  'remove',
  'label',
  'finish',
  'custom',
  'show',
  'show_object',
  'export_step',
  'Param',
  'Solid',
  'FreeCADGui',
  'LLULL_TRACE',
  'LLULL_LIVE',
  'LLULL_UNITS',
]);

/** Allocates unique, language-safe identifiers. */
export class Namer {
  private readonly used = new Set<string>();

  take(preferred: string): string {
    let base = preferred.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
    if (base === '' || base === '_') base = 'item';
    // Leading digit is illegal; leading underscore would collide with the runtime's `_helpers`.
    if (!/^[A-Za-z]/.test(base)) base = `n_${base}`;
    // A reserved word (e.g. the helper `box`) is numbered from 1: box_1, box_2, ...
    const numbered = RESERVED.has(base);
    let candidate = numbered ? `${base}_1` : base;
    for (let n = 2; this.used.has(candidate); n++) candidate = `${base}_${n}`;
    this.used.add(candidate);
    return candidate;
  }
}

/**
 * Rewrite a llull expression into target-language source: identifiers mapped, grammar unchanged
 * (`+ - * /`, parentheses, decimal numbers are valid Python, OpenSCAD and FreeCAD Python).
 * @returns null when the expression contains anything outside the grammar or an unknown name.
 */
export function translateExpression(
  expression: string,
  identifiers: ReadonlyMap<string, string>,
): string | null {
  const token =
    /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_]\w*)|([-+*/()]))/y;
  const parts: string[] = [];
  let index = 0;
  const source = expression.trim();
  while (index < source.length) {
    token.lastIndex = index;
    const match = token.exec(source);
    if (!match) return null;
    index = token.lastIndex;
    const [, number, name, operator] = match;
    if (number !== undefined) parts.push(number);
    else if (name !== undefined) {
      const mapped = identifiers.get(name);
      if (mapped === undefined) return null;
      parts.push(mapped);
    } else if (operator !== undefined) parts.push(operator);
  }
  if (parts.length === 0) return null;
  return parts.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')');
}
