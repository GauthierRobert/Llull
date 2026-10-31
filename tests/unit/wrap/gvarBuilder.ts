/**
 * A `gvar` / `avar` 2 / `MVAR` writer for the variable TrueType tests (03 WRP, TECHNICAL_SPEC §14.14): glyph variation data from tuples with embedded or shared peaks, intermediate
 * regions, private or shared packed point numbers and packed deltas (zero / byte / word runs), so every expected outline follows from numbers written in the test.
 */

import { u16, u32 } from './cffBuilder';
import { buildStore, type StoreSpec } from './cff2Builder';

const i16 = (v: number): number[] => u16(v & 0xffff);
const f2dot14 = (v: number): number[] => i16(Math.round(v * 16384));

export interface TupleSpec {
  /** An embedded peak (one value per axis), else `shared` names a shared tuple. */
  readonly peak?: readonly number[];
  readonly shared?: number;
  /** An intermediate region: start and end per axis. */
  readonly region?: { readonly start: readonly number[]; readonly end: readonly number[] };
  /** Private point numbers ('all' = every point), else the glyph's shared ones apply. */
  readonly points?: readonly number[] | 'all';
  /** One delta per named point (per point of the glyph for 'all'). */
  readonly dx: readonly number[];
  readonly dy: readonly number[];
}

interface GlyphVarSpec {
  readonly tuples: readonly TupleSpec[];
  /** Shared point numbers of the glyph's tuples ('all' = every point). */
  readonly sharedPoints?: readonly number[] | 'all';
}

export interface GvarSpec {
  readonly axisCount: number;
  readonly shared?: readonly (readonly number[])[];
  /** One entry per glyph (null: no variation data). */
  readonly glyphs: readonly (GlyphVarSpec | null)[];
  readonly long?: boolean;
  /** Written as the glyph count (default: glyphs.length). */
  readonly glyphCount?: number;
}

/** Packed point numbers: 'all' is one zero byte; otherwise the count and runs of up to 128 deltas, bytes unless a step is above 255. */
export function packPoints(points: readonly number[] | 'all'): number[] {
  if (points === 'all') return [0];
  const out = points.length < 128 ? [points.length] : [0x80 | (points.length >> 8), points.length & 0xff];
  let previous = 0;
  for (let at = 0; at < points.length; ) {
    const run = points.slice(at, at + 128);
    const steps = run.map((p, k) => p - (k === 0 ? previous : (run[k - 1] as number)));
    const words = steps.some((step) => step > 255);
    out.push((words ? 0x80 : 0) | (run.length - 1));
    for (const step of steps) out.push(...(words ? u16(step) : [step]));
    previous = run[run.length - 1] as number;
    at += run.length;
  }
  return out;
}

/** Packed deltas: runs (of at most 64) of zeros, bytes and words. */
export function packDeltas(deltas: readonly number[]): number[] {
  const out: number[] = [];
  const kind = (v: number): 0 | 1 | 2 => (v === 0 ? 0 : v >= -128 && v <= 127 ? 1 : 2);
  let at = 0;
  while (at < deltas.length) {
    const first = kind(deltas[at] as number);
    let end = at;
    while (end < deltas.length && end - at < 64 && kind(deltas[end] as number) === first) end++;
    const run = deltas.slice(at, end);
    if (first === 0) out.push(0x80 | (run.length - 1));
    else if (first === 1) out.push(run.length - 1, ...run.map((v) => v & 0xff));
    else out.push(0x40 | (run.length - 1), ...run.flatMap((v) => i16(v)));
    at = end;
  }
  return out;
}

function glyphData(glyph: GlyphVarSpec, axisCount: number): number[] {
  const hasShared = glyph.sharedPoints !== undefined;
  const headers: number[] = [];
  const bodies: number[] = [];
  for (const tuple of glyph.tuples) {
    const body = [...(tuple.points !== undefined ? packPoints(tuple.points) : []), ...packDeltas(tuple.dx), ...packDeltas(tuple.dy)];
    let index = tuple.shared ?? 0;
    if (tuple.peak !== undefined) index |= 0x8000;
    if (tuple.region !== undefined) index |= 0x4000;
    if (tuple.points !== undefined) index |= 0x2000;
    headers.push(
      ...u16(body.length),
      ...u16(index),
      ...(tuple.peak === undefined ? [] : tuple.peak.flatMap(f2dot14)),
      ...(tuple.region === undefined ? [] : [...tuple.region.start, ...tuple.region.end].flatMap(f2dot14)),
    );
    bodies.push(...body);
  }
  void axisCount;
  const sharedBytes = hasShared ? packPoints(glyph.sharedPoints as readonly number[] | 'all') : [];
  const head = 4 + headers.length;
  return [...u16(glyph.tuples.length | (hasShared ? 0x8000 : 0)), ...u16(head), ...headers, ...sharedBytes, ...bodies];
}

/** The bytes of a `gvar` table. */
export function buildGvar(spec: GvarSpec): number[] {
  const data = spec.glyphs.map((glyph) => (glyph === null ? [] : glyphData(glyph, spec.axisCount)));
  const shared = (spec.shared ?? []).flatMap((tuple) => tuple.flatMap(f2dot14));
  const offsets: number[] = [0];
  const blob: number[] = [];
  for (const bytes of data) {
    blob.push(...bytes);
    while (blob.length % 2 !== 0) blob.push(0);
    offsets.push(blob.length);
  }
  const offsetBytes = spec.long === true ? offsets.flatMap(u32) : offsets.flatMap((o) => u16(o / 2));
  const headerSize = 20 + offsetBytes.length;
  const sharedAt = headerSize;
  const dataAt = sharedAt + shared.length;
  return [
    ...u16(1),
    ...u16(0),
    ...u16(spec.axisCount),
    ...u16(spec.shared?.length ?? 0),
    ...u32(sharedAt),
    ...u16(spec.glyphCount ?? spec.glyphs.length),
    ...u16(spec.long === true ? 1 : 0),
    ...u32(dataAt),
    ...offsetBytes,
    ...shared,
    ...blob,
  ];
}

/** A DeltaSetIndexMap (format 0): one-byte entries, 2 inner bits per entry (outer = entry >> 2). */
function indexMap(entries: readonly number[]): number[] {
  return [0, 0x01, ...u16(entries.length), ...entries];
}

/** An `avar` version 2 table: the segment maps, then the offsets of the axis index map and the delta store. */
export function buildAvar2(
  maps: readonly (readonly (readonly [number, number])[])[],
  options: { readonly store?: StoreSpec; readonly map?: readonly number[] } = {},
): number[] {
  const segments = maps.flatMap((pairs) => [...u16(pairs.length), ...pairs.flatMap(([from, to]) => [...f2dot14(from), ...f2dot14(to)])]);
  const headerSize = 8 + segments.length + 8;
  const mapBytes = options.map === undefined ? [] : indexMap(options.map);
  const storeBytes = options.store === undefined ? [] : buildStore(options.store);
  return [
    ...u16(2),
    ...u16(0),
    ...u16(0),
    ...u16(maps.length),
    ...segments,
    ...u32(options.map === undefined ? 0 : headerSize),
    ...u32(options.store === undefined ? 0 : headerSize + mapBytes.length),
    ...mapBytes,
    ...storeBytes,
  ];
}

/** An `MVAR` table: value records (tag, outer, inner) over `store`. */
export function buildMvar(records: ReadonlyArray<readonly [string, number, number]>, store: StoreSpec, recordSize = 8): number[] {
  const bytes = buildStore(store);
  const storeAt = 12 + records.length * recordSize;
  return [
    ...u16(1),
    ...u16(0),
    ...u16(0),
    ...u16(recordSize),
    ...u16(records.length),
    ...u16(storeAt),
    ...records.flatMap(([tag, outer, inner]) => [
      ...[...tag].map((c) => c.charCodeAt(0)),
      ...u16(outer),
      ...u16(inner),
      ...new Array<number>(recordSize - 8).fill(0),
    ]),
    ...bytes,
  ];
}
