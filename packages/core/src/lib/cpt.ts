/**
 * GMT colour palette table (CPT) reader and elevation lookup. Continuous RGB tables only: slices `z0 r/g/b z1 r/g/b` (also `r g b` or a single
 * gray value), `B` / `F` / `N` lines (below / above / NaN colour; `black`, `white`, `gray` accepted as names), `#` comments, the header
 * `# RANGE = a/b` and a `[R=a/b]` range in the title. A table whose z values are normalised (all within [0, 1]) and whose header gives a RANGE
 * is scaled to that range, as `gmt makecpt -T` does. Interpolation is linear in RGB inside a slice, as GMT does for a continuous CPT.
 */

export type Rgb = readonly [number, number, number];

interface CptSlice {
  readonly z0: number;
  readonly rgb0: Rgb;
  readonly z1: number;
  readonly rgb1: Rgb;
}

export interface Cpt {
  readonly slices: readonly CptSlice[];
  /** Colour below the first slice (`B`; GMT default black). */
  readonly background: Rgb;
  /** Colour above the last slice (`F`; GMT default white). */
  readonly foreground: Rgb;
  /** Colour of a NaN value (`N`; GMT default gray 128). */
  readonly nan: Rgb;
}

export type CptParse = { readonly ok: true; readonly cpt: Cpt } | { readonly ok: false; readonly error: string };

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NAMES: Readonly<Record<string, Rgb>> = { black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], grey: [128, 128, 128] };
const byte = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));
/** Scaled z values carry no more than 9 decimals (the sources give 12 significant digits). */
const clean = (z: number): number => Math.round(z * 1e9) / 1e9;

/** The colour made of exactly `width` tokens from `at` (1: `r/g/b`, a gray value or a name; 3: `r g b`), or null when they are not that. */
function colourOf(tokens: readonly string[], at: number, width: 1 | 3): Rgb | null {
  const first = tokens[at];
  if (first === undefined) return null;
  if (width === 3) {
    const parts = tokens.slice(at, at + 3);
    return parts.length === 3 && parts.every((part) => NUMBER.test(part))
      ? [byte(Number(parts[0])), byte(Number(parts[1])), byte(Number(parts[2]))]
      : null;
  }
  const named = NAMES[first.toLowerCase()];
  if (named !== undefined) return named;
  if (first.includes('/')) {
    const parts = first.split('/');
    return parts.length === 3 && parts.every((part) => NUMBER.test(part))
      ? [byte(Number(parts[0])), byte(Number(parts[1])), byte(Number(parts[2]))]
      : null;
  }
  if (!NUMBER.test(first)) return null;
  const gray = byte(Number(first));
  return [gray, gray, gray];
}

/** Colour of a `B` / `F` / `N` line: the rest of the line after the tag is exactly one colour. */
function tagColour(tokens: readonly string[]): Rgb | null {
  return tokens.length === 4 ? colourOf(tokens, 1, 3) : tokens.length === 2 ? colourOf(tokens, 1, 1) : null;
}

const WIDTHS: ReadonlyArray<readonly [1 | 3, 1 | 3]> = [
  [1, 1],
  [3, 3],
  [1, 3],
  [3, 1],
];

/**
 * `z0 colour z1 colour [annotation]`: each colour is 1 token (`r/g/b`, gray, name) or 3 (`r g b`); the layout is the one that uses every numeric
 * token (`0 0 10 255` is gray, `0 0 0 0 10 255 255 255` is r g b). The annotation (`L`, `U`, `B`, a label) is non-numeric and ignored.
 */
function parseSlice(tokens: readonly string[]): CptSlice | null {
  if (!NUMBER.test(tokens[0] ?? '')) return null;
  for (const [w0, w1] of WIDTHS) {
    const z1 = tokens[1 + w0];
    const rest = tokens.slice(2 + w0 + w1);
    if (z1 === undefined || !NUMBER.test(z1) || rest.some((token) => NUMBER.test(token) || token.includes('/'))) continue;
    const rgb0 = colourOf(tokens, 1, w0);
    const rgb1 = colourOf(tokens, 2 + w0, w1);
    if (rgb0 === null || rgb1 === null) continue;
    return { z0: Number(tokens[0]), rgb0, z1: Number(z1), rgb1 };
  }
  return null;
}

/** `[a, b]` of a `RANGE = a/b` header line or an `R=a/b` title tag; null when there is none; a string when it is unreadable or not finite. */
function headerRange(lines: readonly string[]): readonly [number, number] | null | string {
  for (const line of lines) {
    if (!line.startsWith('#')) continue;
    const match = /(?:RANGE\s*=\s*|\bR=)([^/\s,\]]+)\/([^/\s,\]]+)/.exec(line);
    if (match === null) continue;
    const low = match[1] ?? '';
    const high = match[2] ?? '';
    if (!NUMBER.test(low) || !NUMBER.test(high)) return `RANGE ${low}/${high} is not numeric`;
    if (!Number.isFinite(Number(low)) || !Number.isFinite(Number(high))) return `RANGE ${low}/${high} is not finite`;
    return [Number(low), Number(high)];
  }
  return null;
}

/** Slices rescaled linearly from their own z extent onto `range`. */
function scaled(slices: readonly CptSlice[], range: readonly [number, number]): CptSlice[] {
  const low = slices[0]?.z0 ?? 0;
  const high = slices[slices.length - 1]?.z1 ?? 1;
  const map = (z: number): number => clean(range[0] + ((z - low) / (high - low)) * (range[1] - range[0]));
  return slices.map((slice) => ({ ...slice, z0: map(slice.z0), z1: map(slice.z1) }));
}

/**
 * Parses CPT text. Refuses (never throws) a table it cannot read exactly: a colour model other than RGB, a HARD_HINGE / SOFT_HINGE table, non-finite z or RANGE, other
 * colour names, patterns, an empty or decreasing z axis.
 * @pure
 */
export function parseCpt(text: string): CptParse {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const model = lines.map((line) => /^#\s*COLOR_MODEL\s*=\s*(\S+)/.exec(line)?.[1]).find((value) => value !== undefined);
  if (model !== undefined && model.toUpperCase() !== 'RGB') return { ok: false, error: `COLOR_MODEL ${model} is not supported (RGB only)` };
  const hinge = lines.map((line) => /^#\s*(HARD|SOFT)_HINGE/.exec(line)?.[1]).find((value) => value !== undefined);
  if (hinge !== undefined) return { ok: false, error: `${hinge}_HINGE tables are not supported` };
  let background: Rgb = [0, 0, 0];
  let foreground: Rgb = [255, 255, 255];
  let nan: Rgb = [128, 128, 128];
  const slices: CptSlice[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === '' || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    const tag = tokens[0];
    if (tag === 'B' || tag === 'F' || tag === 'N') {
      const colour = tagColour(tokens);
      if (colour === null) return { ok: false, error: `line ${index + 1}: unreadable ${tag} colour` };
      if (tag === 'B') background = colour;
      else if (tag === 'F') foreground = colour;
      else nan = colour;
      continue;
    }
    const slice = parseSlice(tokens);
    if (slice === null) return { ok: false, error: `line ${index + 1}: not a "z0 colour z1 colour" slice` };
    if (!Number.isFinite(slice.z0) || !Number.isFinite(slice.z1)) return { ok: false, error: `line ${index + 1}: z value is not finite` };
    slices.push(slice);
  }
  if (slices.length === 0) return { ok: false, error: 'no colour slices' };
  if (slices.some((slice, k) => slice.z1 < slice.z0 || (k > 0 && slice.z0 < (slices[k - 1] as CptSlice).z1)))
    return { ok: false, error: 'slice z values must not decrease' };
  const range = headerRange(lines);
  if (typeof range === 'string') return { ok: false, error: range };
  const normalised = slices.every((slice) => slice.z0 >= 0 && slice.z1 <= 1);
  if (range !== null && normalised) {
    if (range[1] <= range[0] || slices[0]?.z0 === slices[slices.length - 1]?.z1)
      return { ok: false, error: 'RANGE must increase over a non-empty table' };
    return { ok: true, cpt: { slices: scaled(slices, range), background, foreground, nan } };
  }
  return { ok: true, cpt: { slices, background, foreground, nan } };
}

/**
 * The colour GMT gives `z`: `background` below the first slice, `foreground` above the last, `nan` for NaN, else linear RGB interpolation in the
 * slice holding `z` (a shared boundary belongs to the upper slice), rounded to whole bytes.
 * @pure
 */
export function cptColour(cpt: Cpt, z: number): Rgb {
  if (Number.isNaN(z)) return cpt.nan;
  const first = cpt.slices[0];
  const last = cpt.slices[cpt.slices.length - 1];
  if (first === undefined || last === undefined) return cpt.nan;
  if (z < first.z0) return cpt.background;
  if (z > last.z1) return cpt.foreground;
  const slice = cpt.slices.find((candidate) => z < candidate.z1) ?? last;
  const width = slice.z1 - slice.z0;
  const t = width > 0 ? (z - slice.z0) / width : 0;
  const channel = (k: 0 | 1 | 2): number => byte(slice.rgb0[k] + t * (slice.rgb1[k] - slice.rgb0[k]));
  return [channel(0), channel(1), channel(2)];
}
