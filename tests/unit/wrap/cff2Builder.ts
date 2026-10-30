/**
 * A CFF2 / variable-font writer for the parser tests (03 WRP M4, TECHNICAL_SPEC §5.5): charstrings from the same tokens as `cffBuilder` (plus vsindex / blend), the CFF2
 * Top DICT / FDArray / FDSelect / Private DICT layout, an ItemVariationStore, and the `fvar` / `avar` / `HVAR` tables, wrapped into an OpenType font by `buildFont`.
 */

import { charstring, dictInt, u16, u32, type Token } from './cffBuilder';
import { buildFont, type FontSpec } from './fontBuilder';

const i16 = (v: number): number[] => u16(v & 0xffff);
const f2dot14 = (v: number): number[] => i16(Math.round(v * 16384));
const fixed = (v: number): number[] => u32(Math.round(v * 65536) >>> 0);

/** An INDEX with 4-byte counts and 4-byte offsets (CFF2). */
function wideIndex(entries: readonly (readonly number[])[]): number[] {
  if (entries.length === 0) return u32(0);
  const out = [...u32(entries.length), 4];
  let offset = 1;
  out.push(...u32(offset));
  for (const entry of entries) {
    offset += entry.length;
    out.push(...u32(offset));
  }
  for (const entry of entries) out.push(...entry);
  return out;
}

interface DataSpec {
  readonly regionIndexes: readonly number[];
  /** Rows of deltas (one per item), for HVAR; CFF2 only needs the region indexes. */
  readonly rows?: readonly (readonly number[])[];
  /** Leading deltas written as words (the rest as bytes); default all. */
  readonly wordCount?: number;
  readonly long?: boolean;
}

export interface StoreSpec {
  readonly axisCount: number;
  /** regions[r][axis] = [start, peak, end]. */
  readonly regions: readonly (readonly (readonly [number, number, number])[])[];
  readonly data: readonly DataSpec[];
}

/** The bytes of an ItemVariationStore (format 1). */
function buildStore(spec: StoreSpec): number[] {
  const listAt = 8 + 4 * spec.data.length;
  const list = [
    ...u16(spec.axisCount),
    ...u16(spec.regions.length),
    ...spec.regions.flatMap((region) => region.flatMap((axis) => axis.flatMap(f2dot14))),
  ];
  const subtables = spec.data.map((data) => {
    const words = data.wordCount ?? data.regionIndexes.length;
    const rows = data.rows ?? [];
    const out = [
      ...u16(rows.length),
      ...u16(words | (data.long === true ? 0x8000 : 0)),
      ...u16(data.regionIndexes.length),
      ...data.regionIndexes.flatMap(u16),
    ];
    for (const row of rows)
      row.forEach((value, k) => {
        const wide = k < words;
        if (data.long === true) out.push(...(wide ? u32(value >>> 0) : i16(value)));
        else out.push(...(wide ? i16(value) : [value & 0xff]));
      });
    return out;
  });
  const offsets: number[] = [];
  let at = listAt + list.length;
  for (const subtable of subtables) {
    offsets.push(at);
    at += subtable.length;
  }
  return [...u16(1), ...u32(listAt), ...u16(spec.data.length), ...offsets.flatMap(u32), ...list, ...subtables.flat()];
}

interface FontDictSpec {
  readonly localSubrs?: readonly (readonly Token[])[];
  readonly vsindex?: number;
}

export interface Cff2Spec {
  readonly glyphs: readonly { readonly tokens: readonly Token[] }[];
  readonly globalSubrs?: readonly (readonly Token[])[];
  /** Font dicts (default one, no subroutines, vsindex 0). */
  readonly fonts?: readonly FontDictSpec[];
  /** Font dict of each glyph; written as FDSelect format `selectFormat` (default 0). Omitted: no FDSelect. */
  readonly select?: readonly number[];
  readonly selectFormat?: 0 | 3 | 4;
  readonly store?: StoreSpec | null;
  /** The variation store as raw bytes (aliased or oversized stores). */
  readonly storeBytes?: readonly number[];
  /** Replace the FDSelect by these raw bytes. */
  readonly selectBytes?: readonly number[];
  /** Extra raw bytes in the Top DICT (an unknown operator, ...). */
  readonly extraTop?: readonly number[];
  /** Bytes of the Private DICT before its operators (a blend operator with dropped operands, ...). */
  readonly extraPrivate?: readonly number[];
  /** Replace everything after the 5-byte header (corruption tests). */
  readonly rawTail?: readonly number[];
  readonly noFdArray?: boolean;
}

function selectBytes(spec: Cff2Spec): number[] {
  const per = spec.select ?? [];
  if (spec.selectBytes !== undefined) return [...spec.selectBytes];
  const format = spec.selectFormat ?? 0;
  if (format === 0) return [0, ...per];
  const runs: Array<[number, number]> = [];
  per.forEach((fd, glyph) => {
    if (runs.length === 0 || (runs[runs.length - 1] as [number, number])[1] !== fd) runs.push([glyph, fd]);
  });
  if (format === 3) return [3, ...u16(runs.length), ...runs.flatMap(([first, fd]) => [...u16(first), fd]), ...u16(per.length)];
  return [4, ...u32(runs.length), ...runs.flatMap(([first, fd]) => [...u32(first), ...u16(fd)]), ...u32(per.length)];
}

/** The bytes of the CFF2 table. */
export function buildCff2(spec: Cff2Spec): number[] {
  const fonts = spec.fonts ?? [{}];
  const globals = wideIndex((spec.globalSubrs ?? []).map(charstring));
  const charStrings = wideIndex(spec.glyphs.map((glyph) => charstring(glyph.tokens)));
  const store =
    spec.storeBytes !== undefined ? [...spec.storeBytes] : spec.store === undefined || spec.store === null ? null : buildStore(spec.store);
  const storeBlock = store === null ? [] : [...u16(store.length), ...store];
  const select = spec.select === undefined && spec.selectBytes === undefined ? null : selectBytes(spec);
  const extraTop = spec.extraTop ?? [];
  const topLength = 6 + (spec.noFdArray === true ? 0 : 7) + (store === null ? 0 : 6) + (select === null ? 0 : 7) + extraTop.length;
  const globalsAt = 5 + topLength;
  const charAt = globalsAt + globals.length;
  const storeAt = charAt + charStrings.length;
  const arrayAt = storeAt + storeBlock.length;
  const fontDictSize = 11;
  const arrayLength = wideIndex(fonts.map(() => new Array<number>(fontDictSize).fill(0))).length;
  const privates: number[][] = fonts.map((font) => [
    ...(font.localSubrs === undefined ? [] : [...dictInt(0), 19]),
    ...(font.vsindex === undefined ? [] : [...dictInt(font.vsindex), 22]),
    ...(spec.extraPrivate ?? []),
  ]);
  const withSubrs = privates.map((bytes, k) => {
    const font = fonts[k] as FontDictSpec;
    if (font.localSubrs === undefined) return { bytes, subrs: [] as number[] };
    const subrs = wideIndex(font.localSubrs.map(charstring));
    // the Subrs operand is the distance from the Private DICT start to its local subroutines: the Private DICT length
    const patched = [...dictInt(bytes.length), 19, ...bytes.slice(6)];
    return { bytes: patched, subrs };
  });
  let privateAt = arrayAt + arrayLength;
  const fontDicts: number[][] = [];
  const privateBlocks: number[] = [];
  for (const { bytes, subrs } of withSubrs) {
    fontDicts.push([...dictInt(bytes.length), ...dictInt(privateAt), 18]);
    privateBlocks.push(...bytes, ...subrs);
    privateAt += bytes.length + subrs.length;
  }
  const selectAt = privateAt;
  const top = [
    ...dictInt(charAt),
    17,
    ...(spec.noFdArray === true ? [] : [...dictInt(arrayAt), 12, 36]),
    ...(store === null ? [] : [...dictInt(storeAt), 24]),
    ...(select === null ? [] : [...dictInt(selectAt), 12, 37]),
    ...extraTop,
  ];
  const header = [2, 0, 5, ...u16(top.length)];
  if (spec.rawTail !== undefined) return [...header, ...spec.rawTail];
  return [...header, ...top, ...globals, ...charStrings, ...storeBlock, ...wideIndex(fontDicts), ...privateBlocks, ...(select ?? [])];
}

export interface AxisSpec {
  readonly tag: string;
  readonly min: number;
  readonly default: number;
  readonly max: number;
}

export function buildFvar(axes: readonly AxisSpec[]): number[] {
  const out = [...u16(1), ...u16(0), ...u16(16), ...u16(2), ...u16(axes.length), ...u16(20), ...u16(0), ...u16(0)];
  axes.forEach((axis, k) =>
    out.push(
      ...[...axis.tag].map((c) => c.charCodeAt(0)),
      ...fixed(axis.min),
      ...fixed(axis.default),
      ...fixed(axis.max),
      ...u16(0),
      ...u16(256 + k),
    ),
  );
  return out;
}

/** An `avar` version 1 table: one list of [from, to] pairs per axis. */
export function buildAvar(maps: readonly (readonly (readonly [number, number])[])[], major = 1): number[] {
  return [
    ...u16(major),
    ...u16(0),
    ...u16(0),
    ...u16(maps.length),
    ...maps.flatMap((pairs) => [...u16(pairs.length), ...pairs.flatMap(([from, to]) => [...f2dot14(from), ...f2dot14(to)])]),
  ];
}

/** An `HVAR` table: advance deltas from `store`, optionally through a DeltaSetIndexMap of one-byte entries (format 0, 2 inner bits). */
export function buildHvar(store: StoreSpec, map?: readonly number[]): number[] {
  const bytes = buildStore(store);
  const mapBytes = map === undefined ? [] : [0, 0x01, ...u16(map.length), ...map];
  return [...u16(1), ...u16(0), ...u32(20), ...u32(map === undefined ? 0 : 20 + bytes.length), ...u32(0), ...u32(0), ...bytes, ...mapBytes];
}

export interface VariableFontSpec {
  readonly cff2: Cff2Spec;
  readonly axes?: readonly AxisSpec[];
  readonly avar?: readonly number[];
  readonly hvar?: readonly number[];
  readonly font?: Partial<FontSpec>;
  /** Raw CFF2 table bytes instead of `cff2`. */
  readonly cff2Bytes?: readonly number[];
}

/** An OpenType font with a CFF2 table (OTTO), `fvar` for `axes`, and the optional `avar` / `HVAR`. */
export function buildCff2Font(spec: VariableFontSpec): Uint8Array {
  const count = spec.cff2.glyphs.length;
  return buildFont({
    glyphs: Array.from({ length: count }, () => ({ kind: 'empty' as const })),
    advances: Array.from({ length: count }, () => 600),
    metrics: count,
    codePoints: Array.from({ length: count - 1 }, (_, k) => [0x41 + k, k + 1] as const),
    cmap: 'f4',
    os2: { version: 2, fsType: 0, capHeight: 700 },
    ...spec.font,
    otto: true,
    omit: ['glyf', 'loca', ...(spec.font?.omit ?? [])],
    tables: {
      CFF2: spec.cff2Bytes ?? buildCff2(spec.cff2),
      ...(spec.axes === undefined ? {} : { fvar: buildFvar(spec.axes) }),
      ...(spec.avar === undefined ? {} : { avar: spec.avar }),
      ...(spec.hvar === undefined ? {} : { HVAR: spec.hvar }),
      ...spec.font?.tables,
    },
  });
}
