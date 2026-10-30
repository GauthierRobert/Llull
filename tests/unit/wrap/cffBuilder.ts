/**
 * A tiny CFF writer for the parser tests (03 WRP M4): charstrings from token lists (numbers and Type 2 operator names), name-keyed or CID-keyed fonts with local and global
 * subroutines, wrapped into an OpenType (OTTO) font by `buildFont`.
 */

import { buildFont, type FontSpec } from './fontBuilder';

export type Token = number | string | { readonly raw: readonly number[] };

const OPERATORS: Readonly<Record<string, readonly number[]>> = {
  hstem: [1],
  vstem: [3],
  vmoveto: [4],
  rlineto: [5],
  hlineto: [6],
  vlineto: [7],
  rrcurveto: [8],
  callsubr: [10],
  return: [11],
  endchar: [14],
  hstemhm: [18],
  hintmask: [19],
  cntrmask: [20],
  rmoveto: [21],
  hmoveto: [22],
  vstemhm: [23],
  rcurveline: [24],
  rlinecurve: [25],
  vvcurveto: [26],
  hhcurveto: [27],
  callgsubr: [29],
  vhcurveto: [30],
  hvcurveto: [31],
  hflex: [12, 34],
  flex: [12, 35],
  hflex1: [12, 36],
  flex1: [12, 37],
  dotsection: [12, 0],
  and: [12, 3],
  or: [12, 4],
  not: [12, 5],
  abs: [12, 9],
  add: [12, 10],
  sub: [12, 11],
  div: [12, 12],
  neg: [12, 14],
  eq: [12, 15],
  drop: [12, 18],
  put: [12, 20],
  get: [12, 21],
  ifelse: [12, 22],
  random: [12, 23],
  mul: [12, 24],
  sqrt: [12, 26],
  dup: [12, 27],
  exch: [12, 28],
  index: [12, 29],
  roll: [12, 30],
  vsindex: [15],
  blend: [16],
};

/** A charstring operand: 32..246 in one byte, larger integers as shortint (28), fractions as a 16.16 fixed number (255). */
function operand(value: number): number[] {
  if (Number.isInteger(value) && value >= -107 && value <= 107) return [value + 139];
  if (Number.isInteger(value) && value >= 108 && value <= 1131) return [247 + ((value - 108) >> 8), (value - 108) & 0xff];
  if (Number.isInteger(value) && value >= -1131 && value <= -108) return [251 + ((-value - 108) >> 8), (-value - 108) & 0xff];
  if (Number.isInteger(value) && Math.abs(value) < 32768) return [28, (value >> 8) & 0xff, value & 0xff];
  const fixed = Math.round(value * 65536);
  return [255, (fixed >>> 24) & 0xff, (fixed >>> 16) & 0xff, (fixed >>> 8) & 0xff, fixed & 0xff];
}

/** The bytes of a charstring given as tokens. */
export function charstring(tokens: readonly Token[]): number[] {
  return tokens.flatMap((token) => {
    if (typeof token === 'number') return operand(token);
    if (typeof token === 'string') {
      const op = OPERATORS[token];
      if (op === undefined) throw new Error(`unknown operator ${token}`);
      return [...op];
    }
    return [...token.raw];
  });
}

export const u16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];
export const u32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/** An INDEX with 4-byte offsets. */
function index(entries: readonly (readonly number[])[]): number[] {
  if (entries.length === 0) return u16(0);
  const out = [...u16(entries.length), 4];
  let offset = 1;
  out.push(...u32(offset));
  for (const entry of entries) {
    offset += entry.length;
    out.push(...u32(offset));
  }
  for (const entry of entries) out.push(...entry);
  return out;
}

/** A DICT integer operand in the fixed 5-byte form (so DICT sizes do not depend on the offsets they hold). */
export const dictInt = (v: number): number[] => [29, ...u32(v >>> 0)];

interface CffGlyphSpec {
  readonly tokens: readonly Token[];
}

export interface CffSpec {
  readonly glyphs: readonly CffGlyphSpec[];
  readonly globalSubrs?: readonly (readonly Token[])[];
  /** Local subroutines of the single Private DICT (name-keyed) or per font dict (CID-keyed). */
  readonly localSubrs?: readonly (readonly Token[])[];
  /** CID-keyed: a second font dict with these local subrs, used by the glyphs listed in `secondFontGlyphs`. */
  readonly cid?: {
    readonly secondLocalSubrs: readonly (readonly Token[])[];
    readonly secondFontGlyphs: readonly number[];
    readonly selectFormat?: 0 | 3;
    /** Replace the FDSelect by these raw bytes (corruption tests). */
    readonly selectBytes?: readonly number[];
  };
  /** Extra raw bytes in the name-keyed Top DICT before the CharStrings operator (operand encodings a test names). */
  readonly extraTopDict?: readonly number[];
  /** Name-keyed: no Private DICT operator in the Top DICT. */
  readonly noPrivate?: boolean;
  /** Name-keyed: string ids of glyphs 1.. in a format 0 charset (what `seac` resolves its Standard Encoding codes through); without it the predefined ISOAdobe charset. */
  readonly charset?: readonly number[];
  /** Name-keyed: the charset as raw bytes (formats 1 and 2, damaged ones). */
  readonly charsetBytes?: readonly number[];
  readonly version?: number;
  /** Replace the table by raw bytes after the header (corruption tests). */
  readonly rawTail?: readonly number[];
}

/** The bytes of the CFF table. */
function buildCff(spec: CffSpec): number[] {
  const header = [spec.version ?? 1, 0, 4, 4];
  const names = index([[...'Test'].map((c) => c.charCodeAt(0))]);
  const strings = index([]);
  const globals = index((spec.globalSubrs ?? []).map(charstring));
  const charStrings = index(spec.glyphs.map((glyph) => charstring(glyph.tokens)));
  const localIndex = (subrs: readonly (readonly Token[])[] | undefined): number[] =>
    subrs === undefined ? [] : index(subrs.map(charstring));
  const topSize = (cid: boolean): number =>
    cid
      ? 37
      : (spec.noPrivate === true ? 6 : 17) +
        (spec.extraTopDict?.length ?? 0) +
        (spec.charset === undefined && spec.charsetBytes === undefined ? 0 : 6);
  const tops = (cid: boolean): number => 2 + 1 + 4 * 2 + topSize(cid);
  const fixedHead = header.length + names.length + tops(spec.cid !== undefined) + strings.length + globals.length;
  if (spec.cid === undefined) {
    // name-keyed: CharStrings, then the Private DICT (its Subrs operand is its own size: the local Subrs follow it), then the local Subrs
    const charAt = fixedHead;
    const privateAt = charAt + charStrings.length;
    const privateBytes = spec.localSubrs === undefined ? [] : [...dictInt(6), 19];
    const charsetAt = privateAt + privateBytes.length + localIndex(spec.localSubrs).length;
    const top = [
      ...(spec.charset === undefined && spec.charsetBytes === undefined ? [] : [...dictInt(charsetAt), 15]),
      ...(spec.extraTopDict ?? []),
      ...dictInt(charAt),
      17,
      ...(spec.noPrivate === true ? [] : [...dictInt(privateBytes.length), ...dictInt(privateAt), 18]),
    ];
    const out = [
      ...header,
      ...names,
      ...index([top]),
      ...strings,
      ...globals,
      ...charStrings,
      ...privateBytes,
      ...localIndex(spec.localSubrs),
      ...(spec.charsetBytes ?? (spec.charset === undefined ? [] : [0, ...spec.charset.flatMap(u16)])),
    ];
    return spec.rawTail === undefined ? out : [...header, ...spec.rawTail];
  }
  // CID-keyed: ROS, CharStrings, FDSelect, FDArray (two font dicts), Private DICTs and local Subrs
  const first = spec.localSubrs;
  const second = spec.cid.secondLocalSubrs;
  const select =
    spec.cid.selectBytes !== undefined
      ? [...spec.cid.selectBytes]
      : spec.cid.selectFormat === 0
        ? [0, ...spec.glyphs.map((_, g) => (spec.cid?.secondFontGlyphs.includes(g) === true ? 1 : 0))]
        : (() => {
            const ranges: Array<[number, number]> = [];
            spec.glyphs.forEach((_, g) => {
              const fd = spec.cid?.secondFontGlyphs.includes(g) === true ? 1 : 0;
              if (ranges.length === 0 || (ranges[ranges.length - 1] as [number, number])[1] !== fd) ranges.push([g, fd]);
            });
            return [3, ...u16(ranges.length), ...ranges.flatMap(([g, fd]) => [...u16(g), fd]), ...u16(spec.glyphs.length)];
          })();
  const privateBytes = [
    [...dictInt(6), 19],
    [...dictInt(6), 19],
  ];
  const subrsOf = [localIndex(first ?? []), localIndex(second)];
  const charAt = fixedHead;
  const selectAt = charAt + charStrings.length;
  const arrayAt = selectAt + select.length;
  const fontDictSize = 5 + 5 + 1;
  const arrayLength = index([new Array<number>(fontDictSize).fill(0), new Array<number>(fontDictSize).fill(0)]).length;
  const privatesAt = arrayAt + arrayLength;
  const privateAt = [privatesAt, privatesAt + 6 + (subrsOf[0] as number[]).length];
  const fontDicts = [0, 1].map((k) => [...dictInt(6), ...dictInt(privateAt[k] as number), 18]);
  const top = [
    ...dictInt(391),
    ...dictInt(391),
    ...dictInt(0),
    12,
    30,
    ...dictInt(charAt),
    17,
    ...dictInt(selectAt),
    12,
    37,
    ...dictInt(arrayAt),
    12,
    36,
  ];
  return [
    ...header,
    ...names,
    ...index([top]),
    ...strings,
    ...globals,
    ...charStrings,
    ...select,
    ...index(fontDicts),
    ...(privateBytes[0] as number[]),
    ...(subrsOf[0] as number[]),
    ...(privateBytes[1] as number[]),
    ...(subrsOf[1] as number[]),
  ];
}

/** An OpenType/CFF font: placeholder glyph slots for the shared tables, the CFF table replacing glyf / loca. */
export function buildCffFont(spec: CffSpec, font: Partial<FontSpec> = {}): Uint8Array {
  const count = spec.glyphs.length;
  return buildFont({
    glyphs: Array.from({ length: count }, () => ({ kind: 'empty' as const })),
    advances: Array.from({ length: count }, () => 600),
    metrics: count,
    codePoints: Array.from({ length: count - 1 }, (_, k) => [0x41 + k, k + 1] as const),
    cmap: 'f4',
    os2: { version: 2, fsType: 0, capHeight: 700 },
    ...font,
    otto: true,
    omit: ['glyf', 'loca', ...(font.omit ?? [])],
    tables: { 'CFF ': buildCff(spec), ...(font.tables ?? {}) },
  });
}
