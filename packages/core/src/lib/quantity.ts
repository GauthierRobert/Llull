/**
 * Physical unit grammar: parse a unit string into a scale, an affine offset and a dimension vector, and convert values between units.
 * Grammar: factors joined by `*`, `·` or `/`, each `symbol[^exponent]`, a prefixed symbol (`mm`, `GPa`, `kJ`), a number (`1e-5`) or a
 * parenthesised group; `/` divides by the single factor that follows. Dimensionless tags: `1`, `-`, `%`, `ppm`.
 * Absolute temperatures (`degC`, `degF`) are affine only when they are the whole unit; inside a compound unit they are intervals.
 */

/** Exponents of M L T Θ N I J (mass, length, time, temperature, amount, current, luminous intensity). */
export type Dimension = readonly [number, number, number, number, number, number, number];

export interface ParsedUnit {
  readonly scale: number; // SI value of one unit
  readonly offset: number; // SI = scale · value + offset (absolute temperatures only)
  readonly dimension: Dimension;
}

export type UnitFailure = { readonly code: 'MAT_UNIT_INVALID' | 'MAT_UNIT_DIMENSION'; readonly message: string };

const NONE: Dimension = [0, 0, 0, 0, 0, 0, 0];
const dim = (m: number, l: number, t: number, theta = 0, n = 0, i = 0): Dimension => [m, l, t, theta, n, i, 0];

interface UnitDef {
  readonly scale: number;
  readonly dimension: Dimension;
  readonly prefixable: boolean;
  readonly offset?: number;
}

const unit = (scale: number, dimension: Dimension, prefixable = false, offset?: number): UnitDef =>
  offset === undefined ? { scale, dimension, prefixable } : { scale, dimension, prefixable, offset };

const LBF = 4.4482216152605;
const INCH = 0.0254;

const UNITS: Readonly<Record<string, UnitDef>> = {
  m: unit(1, dim(0, 1, 0), true),
  g: unit(1e-3, dim(1, 0, 0), true),
  s: unit(1, dim(0, 0, 1), true),
  K: unit(1, dim(0, 0, 0, 1), true),
  mol: unit(1, dim(0, 0, 0, 0, 1), true),
  A: unit(1, dim(0, 0, 0, 0, 0, 1), true),
  N: unit(1, dim(1, 1, -2), true),
  Pa: unit(1, dim(1, -1, -2), true),
  J: unit(1, dim(1, 2, -2), true),
  W: unit(1, dim(1, 2, -3), true),
  Hz: unit(1, dim(0, 0, -1), true),
  V: unit(1, dim(1, 2, -3, 0, 0, -1), true),
  ohm: unit(1, dim(1, 2, -3, 0, 0, -2), true),
  L: unit(1e-3, dim(0, 3, 0), true),
  bar: unit(1e5, dim(1, -1, -2), true),
  t: unit(1000, dim(1, 0, 0)),
  min: unit(60, dim(0, 0, 1)),
  h: unit(3600, dim(0, 0, 1)),
  d: unit(86400, dim(0, 0, 1)),
  in: unit(INCH, dim(0, 1, 0)),
  ft: unit(0.3048, dim(0, 1, 0)),
  lb: unit(0.45359237, dim(1, 0, 0)),
  lbf: unit(LBF, dim(1, 1, -2)),
  psi: unit(LBF / (INCH * INCH), dim(1, -1, -2)),
  ksi: unit((1000 * LBF) / (INCH * INCH), dim(1, -1, -2)),
  Msi: unit((1e6 * LBF) / (INCH * INCH), dim(1, -1, -2)),
  degC: unit(1, dim(0, 0, 0, 1), false, 273.15),
  degF: unit(5 / 9, dim(0, 0, 0, 1), false, 273.15 - (32 * 5) / 9),
  degR: unit(5 / 9, dim(0, 0, 0, 1)),
  rad: unit(1, NONE),
  deg: unit(Math.PI / 180, NONE),
  '%': unit(0.01, NONE),
  ppm: unit(1e-6, NONE),
  '1': unit(1, NONE),
  '-': unit(1, NONE),
};

const PREFIXES: Readonly<Record<string, number>> = {
  T: 1e12,
  G: 1e9,
  M: 1e6,
  k: 1e3,
  h: 1e2,
  c: 1e-2,
  d: 1e-1,
  m: 1e-3,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  n: 1e-9,
  p: 1e-12,
};

const lookupSymbol = (symbol: string): UnitDef | undefined => {
  const direct = UNITS[symbol];
  if (direct !== undefined) return direct;
  const prefix = PREFIXES[symbol.slice(0, 1)];
  const base = UNITS[symbol.slice(1)];
  if (prefix === undefined || base === undefined || !base.prefixable) return undefined;
  return unit(prefix * base.scale, base.dimension);
};

interface Term {
  readonly scale: number;
  readonly dimension: Dimension;
  readonly offset?: number;
}

const power = (term: Term, exponent: number): Term => ({
  scale: term.scale ** exponent,
  dimension: term.dimension.map((d) => d * exponent) as unknown as Dimension,
});

const times = (a: Term, b: Term): Term => ({
  scale: a.scale * b.scale,
  dimension: a.dimension.map((d, k) => d + (b.dimension[k] ?? 0)) as unknown as Dimension,
});

const TOKEN = /\s*(\(|\)|\*|·|\/|\^-?\d+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?![A-Za-zµμ%])|[A-Za-zµμ%][A-Za-zµμ%]*|-)\s*/y;

const tokenize = (text: string): string[] | null => {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text);
    if (match === null || match[1] === undefined) return null;
    tokens.push(match[1]);
  }
  return tokens;
};

/** Recursive-descent parser over the token list; returns null on any syntax error or unknown symbol. */
const parseTokens = (tokens: readonly string[]): Term | null => {
  let position = 0;
  const factor = (): Term | null => {
    const token = tokens[position];
    if (token === undefined) return null;
    position += 1;
    let term: Term | null;
    if (token === '(') {
      term = product();
      if (tokens[position] !== ')') return null;
      position += 1;
    } else if (/^[+-]?\d/.test(token)) {
      term = { scale: Number(token), dimension: NONE };
    } else {
      const def = lookupSymbol(token);
      term = def === undefined ? null : def;
    }
    const next = tokens[position];
    if (term !== null && next !== undefined && next.startsWith('^')) {
      position += 1;
      term = power(term, Number(next.slice(1)));
    }
    return term;
  };
  const product = (): Term | null => {
    let term = factor();
    while (term !== null) {
      const op = tokens[position];
      if (op !== '*' && op !== '·' && op !== '/') break;
      position += 1;
      const right = factor();
      if (right === null) return null;
      term = times(term, op === '/' ? power(right, -1) : right);
    }
    return term;
  };
  const result = product();
  return result !== null && position === tokens.length ? result : null;
};

/** Reads the shorthand exponents `m3`, `cm²`, `s2` as `m^3`, `cm^2`, `s^2`; a number's own `1e5` is left alone. */
const withCarets = (text: string): string =>
  text
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/(?<![\d.])([A-Za-zµμ]+)(\d+)(?![\d.])/g, '$1^$2');

/** Parse a unit; an absolute temperature (`degC`, `degF`) alone keeps its affine offset. */
export function parseUnit(text: string): ParsedUnit | UnitFailure {
  const trimmed = text.trim();
  const whole = UNITS[trimmed];
  if (whole !== undefined) return { scale: whole.scale, offset: whole.offset ?? 0, dimension: whole.dimension };
  const tokens = tokenize(withCarets(trimmed));
  const term = tokens === null || tokens.length === 0 ? null : parseTokens(tokens);
  if (term === null || !Number.isFinite(term.scale) || !(term.scale > 0)) {
    return { code: 'MAT_UNIT_INVALID', message: `unit '${text}' is not understood (e.g. 'MPa', 'W/(m*K)', 'J/(kg*K)', 'degC', '1e-5')` };
  }
  return { scale: term.scale, offset: 0, dimension: term.dimension };
}

export const isUnitFailure = <T extends object>(value: T | UnitFailure): value is UnitFailure => 'code' in value;

export const sameDimension = (a: Dimension, b: Dimension): boolean => a.every((d, k) => Math.abs(d - (b[k] ?? 0)) < 1e-12);

/** Convert `value` from one unit to another of the same dimension (affine for absolute temperatures). */
export function convertValue(value: number, from: string, to: string): { readonly value: number } | UnitFailure {
  if (from.trim() === to.trim()) return { value };
  const source = parseUnit(from);
  if (isUnitFailure(source)) return source;
  const target = parseUnit(to);
  if (isUnitFailure(target)) return target;
  if (!sameDimension(source.dimension, target.dimension)) {
    return { code: 'MAT_UNIT_DIMENSION', message: `cannot convert '${from}' to '${to}': different dimensions` };
  }
  return { value: (value * source.scale + source.offset - target.offset) / target.scale };
}
