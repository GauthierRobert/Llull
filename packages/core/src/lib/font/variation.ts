/**
 * OpenType font variations (03 WRP M4, TECHNICAL_SPEC §5.5): the `fvar` axes, the `avar` segment maps, the ItemVariationStore (CFF2 `vstore`, `HVAR`) and the
 * `HVAR` advance deltas. A requested instance is a value per axis tag in design units; it becomes normalised coordinates in [-1, 1] rounded to 2.14 fixed point.
 * @invariant at most 64 axes, 4096 regions and 4096 variation data subtables; every offset is checked by `ByteView`; the same bytes and values give the same coordinates
 * `avar` version 2 follows the segment maps: an ItemVariationStore of per-axis deltas (2.14 fixed) evaluated at the segment-mapped coordinates of all axes, through an optional axis index map.
 * @failure an unknown axis tag, a value outside the axis range, a font without axes -> WRP_FONT_VARIATION; damaged tables -> WRP_FONT_PARSE
 */

import { type ByteView, FontError, parseError } from './reader';

const MAX_AXES = 64;
const MAX_REGIONS = 4096;
const MAX_DATA = 4096;
const MAX_REGION_INDEXES = 65_536;

export interface VariationAxis {
  readonly tag: string;
  readonly min: number;
  readonly default: number;
  readonly max: number;
}

export type AxisValues = Readonly<Record<string, number>>;

const f2dot14 = (value: number): number => value / 16384;
const toF2dot14 = (value: number): number => Math.round(value * 16384) / 16384;
const fixed = (view: ByteView, at: number): number => (view.u32(at) | 0) / 65536;

/** A named instance of `fvar`: name ids into the `name` table and the design value of every axis. */
interface NamedInstanceRecord {
  readonly subfamilyNameId: number;
  /** The PostScript name id, null when the instance records are the short form. */
  readonly postScriptNameId: number | null;
  readonly coordinates: Readonly<Record<string, number>>;
}

/** A variable font's axes and the map from design values to normalised coordinates. */
export interface VariationSpace {
  readonly axes: readonly VariationAxis[];
  /** The named instances of `fvar` (at most 4096). */
  readonly instances: readonly NamedInstanceRecord[];
  /** Normalised coordinates (one per axis, `fvar` order, `avar` applied) of `values`; axes without a value take their default. @failure -> WRP_FONT_VARIATION */
  readonly coordinates: (values: AxisValues) => number[];
  /** The axes of `values` that differ from their default, as a plain record in tag order: the canonical name of an instance. */
  readonly instance: (values: AxisValues) => Record<string, number>;
}

interface SegmentMaps {
  readonly maps: Array<ReadonlyArray<readonly [number, number]>>;
  /** avar version 2: the per-axis delta store and the axis index map (null: axis i is row i of subtable 0). */
  readonly second: { readonly store: ItemVariationStore; readonly map: ((index: number) => readonly [number, number]) | null } | null;
}

function readSegmentMaps(avar: ByteView | null, axisCount: number): SegmentMaps {
  const maps: Array<ReadonlyArray<readonly [number, number]>> = Array.from({ length: axisCount }, () => []);
  if (avar === null) return { maps, second: null };
  const major = avar.u16(0);
  if (major !== 1 && major !== 2) throw parseError(`avar: version ${major} is not 1 or 2`);
  if (avar.u16(6) !== axisCount) throw parseError(`avar: ${avar.u16(6)} axes for the ${axisCount} of fvar`);
  let at = 8;
  for (let axis = 0; axis < axisCount; axis++) {
    const count = avar.u16(at);
    at += 2;
    const pairs: Array<readonly [number, number]> = [];
    for (let k = 0; k < count; k++, at += 4) pairs.push([f2dot14(avar.i16(at)), f2dot14(avar.i16(at + 2))]);
    for (let k = 1; k < pairs.length; k++)
      if ((pairs[k] as readonly [number, number])[0] < (pairs[k - 1] as readonly [number, number])[0])
        throw parseError('avar: the segment map of an axis is not sorted by its input values');
    maps[axis] = pairs;
  }
  if (major !== 2) return { maps, second: null };
  const mapAt = avar.u32(at);
  const storeAt = avar.u32(at + 4);
  if (storeAt === 0) return { maps, second: null };
  const store = readItemVariationStore(avar.sub(storeAt, avar.length - storeAt, 'avar store'));
  if (store.axisCount > axisCount) throw parseError(`avar: a delta store of ${store.axisCount} axes for the ${axisCount} of fvar`);
  return { maps, second: { store, map: mapAt === 0 ? null : readIndexMap(avar, mapAt) } };
}

function applySegments(pairs: ReadonlyArray<readonly [number, number]>, value: number): number {
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  if (first === undefined || last === undefined) return value;
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let k = 1; k < pairs.length; k++) {
    const [from, to] = pairs[k] as readonly [number, number];
    const [previousFrom, previousTo] = pairs[k - 1] as readonly [number, number];
    if (value <= from)
      return from === previousFrom ? to : previousTo + ((value - previousFrom) / (from - previousFrom)) * (to - previousTo);
  }
  return value;
}

const MAX_INSTANCES = 4096;

/** The instance records after the axes: [subfamilyNameID, flags, one Fixed per axis, optional postScriptNameID]. @failure a record shorter than its axes, more than 4096 of them, a coordinate outside its axis -> WRP_FONT_PARSE */
function readNamedInstances(fvar: ByteView, at: number, axes: readonly VariationAxis[]): NamedInstanceRecord[] {
  const count = fvar.u16(12);
  const size = fvar.u16(14);
  if (count === 0) return [];
  if (count > MAX_INSTANCES) throw parseError(`fvar: ${count} named instances exceed ${MAX_INSTANCES}`);
  const short = 4 + 4 * axes.length;
  if (size !== short && size !== short + 2)
    throw parseError(`fvar: instance records of ${size} bytes, ${short} or ${short + 2} expected for ${axes.length} axes`);
  const out: NamedInstanceRecord[] = [];
  for (let k = 0; k < count; k++) {
    const record = at + k * size;
    const coordinates: Record<string, number> = {};
    axes.forEach((axis, a) => {
      const value = fixed(fvar, record + 4 + 4 * a);
      if (!(value >= axis.min && value <= axis.max))
        throw parseError(`fvar: named instance ${k} has ${axis.tag} = ${value} outside ${axis.min}..${axis.max}`);
      coordinates[axis.tag] = value;
    });
    out.push({ subfamilyNameId: fvar.u16(record), postScriptNameId: size === short + 2 ? fvar.u16(record + short) : null, coordinates });
  }
  return out;
}

/** The variation space of a font, or null without an `fvar` table. @failure damaged fvar / avar -> WRP_FONT_PARSE */
export function readVariationSpace(fvar: ByteView | null, avar: ByteView | null): VariationSpace | null {
  if (fvar === null) return null;
  if (fvar.u16(0) !== 1) throw parseError(`fvar: version ${fvar.u16(0)} is not 1`);
  const axesAt = fvar.u16(4);
  const axisCount = fvar.u16(8);
  const axisSize = fvar.u16(10);
  if (axisCount > MAX_AXES) throw parseError(`fvar: ${axisCount} axes exceed ${MAX_AXES}`);
  if (axisSize < 20) throw parseError(`fvar: axis records of ${axisSize} bytes are shorter than 20`);
  const axes: VariationAxis[] = [];
  for (let k = 0; k < axisCount; k++) {
    const at = axesAt + k * axisSize;
    const axis: VariationAxis = {
      tag: fvar.ascii(at, 4),
      min: fixed(fvar, at + 4),
      default: fixed(fvar, at + 8),
      max: fixed(fvar, at + 12),
    };
    if (!(axis.min <= axis.default && axis.default <= axis.max))
      throw parseError(`fvar: axis '${axis.tag}' has min ${axis.min}, default ${axis.default}, max ${axis.max} out of order`);
    if (axes.some((other) => other.tag === axis.tag)) throw parseError(`fvar: axis '${axis.tag}' is listed twice`);
    axes.push(axis);
  }
  const instances = readNamedInstances(fvar, axesAt + axisCount * axisSize, axes);
  const { maps, second } = readSegmentMaps(avar, axisCount);
  const checked = (values: AxisValues): void => {
    for (const [tag, value] of Object.entries(values)) {
      const axis = axes.find((candidate) => candidate.tag === tag);
      if (axis === undefined)
        throw new FontError(
          'WRP_FONT_VARIATION',
          `variation: the font has no axis '${tag}' (axes: ${axes.map((a) => a.tag).join(', ') || 'none'})`,
        );
      if (!Number.isFinite(value) || value < axis.min || value > axis.max)
        throw new FontError('WRP_FONT_VARIATION', `variation: axis '${tag}' = ${value} is outside ${axis.min}..${axis.max}`);
    }
  };
  const instance = (values: AxisValues): Record<string, number> => {
    checked(values);
    const sorted = axes
      .filter((axis) => values[axis.tag] !== undefined && values[axis.tag] !== axis.default)
      .map((axis) => axis.tag)
      .sort();
    return Object.fromEntries(sorted.map((tag) => [tag, values[tag] as number]));
  };
  return {
    axes,
    instances,
    instance,
    coordinates: (values) => {
      const chosen = instance(values);
      const segmented = axes.map((axis, k) => {
        const value = chosen[axis.tag];
        if (value === undefined) return 0;
        const normal =
          value < axis.default ? (value - axis.default) / (axis.default - axis.min) : (value - axis.default) / (axis.max - axis.default);
        const mapped = applySegments(maps[k] as ReadonlyArray<readonly [number, number]>, toF2dot14(normal));
        return toF2dot14(Math.max(-1, Math.min(1, mapped)));
      });
      if (second === null) return segmented;
      // avar version 2: every axis (also one left at its default) moves by its delta from the store, evaluated at the segment-mapped coordinates of all axes
      return segmented.map((coordinate, k) => {
        const [outer, inner] = second.map === null ? [0, k] : second.map(k);
        return toF2dot14(Math.max(-1, Math.min(1, coordinate + second.store.delta(outer, inner, segmented) / 16384)));
      });
    },
  };
}

type Region = ReadonlyArray<readonly [number, number, number]>;

interface DataSubtable {
  readonly itemCount: number;
  readonly wordCount: number;
  readonly long: boolean;
  readonly regionIndexes: readonly number[];
  readonly rows: number;
}

export interface ItemVariationStore {
  readonly axisCount: number;
  readonly dataCount: number;
  /** Regions of subtable `data`. @failure data outside the store -> WRP_FONT_PARSE */
  readonly regionCount: (data: number) => number;
  /** The scalar of each region of subtable `data` at `coords`. */
  readonly scalars: (data: number, coords: readonly number[]) => number[];
  /** The interpolated delta of row `inner` of subtable `outer` (0 for the no-variation index 0xFFFF / 0xFFFF). */
  readonly delta: (outer: number, inner: number, coords: readonly number[]) => number;
}

/** The scalar of one region at `coords` (OpenType 'Algorithm for interpolation of instance values'). */
export function regionScalar(region: Region, coords: readonly number[]): number {
  let scalar = 1;
  for (let axis = 0; axis < region.length; axis++) {
    const [start, peak, end] = region[axis] as readonly [number, number, number];
    const coord = coords[axis] ?? 0;
    if (start > peak || peak > end || (start < 0 && end > 0 && peak !== 0) || peak === 0 || coord === peak) continue;
    if (coord < start || coord > end) return 0;
    scalar *= coord < peak ? (coord - start) / (peak - start) : (end - coord) / (end - peak);
  }
  return scalar;
}

/** An ItemVariationStore at the start of `view`. @failure unknown format, counts over the caps, region indexes out of range -> WRP_FONT_PARSE */
export function readItemVariationStore(view: ByteView): ItemVariationStore {
  if (view.u16(0) !== 1) throw parseError(`variation store: format ${view.u16(0)} is not 1`);
  const listAt = view.u32(2);
  const dataCount = view.u16(6);
  if (dataCount > MAX_DATA) throw parseError(`variation store: ${dataCount} data subtables exceed ${MAX_DATA}`);
  const axisCount = view.u16(listAt);
  const regionCount = view.u16(listAt + 2);
  if (axisCount > MAX_AXES || regionCount > MAX_REGIONS)
    throw parseError(`variation store: ${axisCount} axes and ${regionCount} regions exceed ${MAX_AXES} and ${MAX_REGIONS}`);
  const regions: Region[] = [];
  for (let r = 0; r < regionCount; r++) {
    const region: Array<readonly [number, number, number]> = [];
    for (let a = 0; a < axisCount; a++) {
      const at = listAt + 4 + (r * axisCount + a) * 6;
      region.push([f2dot14(view.i16(at)), f2dot14(view.i16(at + 2)), f2dot14(view.i16(at + 4))]);
    }
    regions.push(region);
  }
  const subtables: DataSubtable[] = [];
  let totalIndexes = 0;
  for (let d = 0; d < dataCount; d++) {
    const at = view.u32(8 + 4 * d);
    const itemCount = view.u16(at);
    const wordField = view.u16(at + 2);
    const indexCount = view.u16(at + 4);
    if (indexCount > regionCount) throw parseError(`variation store: subtable ${d} lists ${indexCount} regions of ${regionCount}`);
    totalIndexes += indexCount;
    if (totalIndexes > MAX_REGION_INDEXES)
      throw parseError(`variation store: more than ${MAX_REGION_INDEXES} region indexes over all subtables`);
    const regionIndexes = Array.from({ length: indexCount }, (_, k) => view.u16(at + 6 + 2 * k));
    if (regionIndexes.some((index) => index >= regionCount))
      throw parseError(`variation store: subtable ${d} names a region outside 0..${regionCount - 1}`);
    const wordCount = wordField & 0x7fff;
    if (wordCount > indexCount) throw parseError(`variation store: subtable ${d} has ${wordCount} word deltas for ${indexCount} regions`);
    subtables.push({ itemCount, wordCount, long: (wordField & 0x8000) !== 0, regionIndexes, rows: at + 6 + 2 * indexCount });
  }
  const subtable = (data: number): DataSubtable => {
    const found = subtables[data];
    if (found === undefined) throw parseError(`variation store: subtable ${data} is outside 0..${dataCount - 1}`);
    return found;
  };
  const scalars = (data: number, coords: readonly number[]): number[] =>
    subtable(data).regionIndexes.map((index) => regionScalar(regions[index] as Region, coords));
  return {
    axisCount,
    dataCount,
    regionCount: (data) => subtable(data).regionIndexes.length,
    scalars,
    delta: (outer, inner, coords) => {
      if (outer === 0xffff && inner === 0xffff) return 0;
      const data = subtable(outer);
      if (inner >= data.itemCount)
        throw parseError(`variation store: row ${inner} is outside the ${data.itemCount} rows of subtable ${outer}`);
      const wide = data.long ? 4 : 2;
      const narrow = data.long ? 2 : 1;
      const rowSize = data.wordCount * wide + (data.regionIndexes.length - data.wordCount) * narrow;
      let at = data.rows + inner * rowSize;
      const scale = scalars(outer, coords);
      let total = 0;
      for (let k = 0; k < data.regionIndexes.length; k++) {
        const isWord = k < data.wordCount;
        const size = isWord ? wide : narrow;
        const value = size === 4 ? view.u32(at) | 0 : size === 2 ? view.i16(at) : view.i8(at);
        at += size;
        total += (scale[k] as number) * value;
      }
      return total;
    },
  };
}

/** A DeltaSetIndexMap at `at` of `view`: the (outer, inner) pair of an index. */
function readIndexMap(view: ByteView, at: number): (index: number) => readonly [number, number] {
  const format = view.u8(at);
  if (format !== 0 && format !== 1) throw parseError(`index map: format ${format} is not 0 or 1`);
  const entryFormat = view.u8(at + 1);
  const count = format === 0 ? view.u16(at + 2) : view.u32(at + 2);
  const size = ((entryFormat >> 4) & 3) + 1;
  const innerBits = (entryFormat & 15) + 1;
  if (count === 0) throw parseError('index map: no entries');
  const first = at + (format === 0 ? 4 : 6);
  return (index) => {
    const entryAt = first + Math.min(index, count - 1) * size;
    let entry = 0;
    for (let b = 0; b < size; b++) entry = entry * 256 + view.u8(entryAt + b);
    return [Math.floor(entry / 2 ** innerBits), entry % 2 ** innerBits];
  };
}

/**
 * The advance-width delta of a glyph at `coords` from an `HVAR` table, in font units (unrounded).
 * @failure damaged table -> WRP_FONT_PARSE
 */
export function readAdvanceDeltas(hvar: ByteView, coords: readonly number[]): (glyph: number) => number {
  if (hvar.u16(0) !== 1) throw parseError(`HVAR: version ${hvar.u16(0)} is not 1`);
  const storeAt = hvar.u32(4);
  const mapAt = hvar.u32(8);
  const store = readItemVariationStore(hvar.sub(storeAt, hvar.length - storeAt, 'HVAR store'));
  const mapped = mapAt === 0 ? null : readIndexMap(hvar, mapAt);
  return (glyph) => {
    const [outer, inner] = mapped === null ? [0, glyph] : mapped(glyph);
    return store.delta(outer, inner, coords);
  };
}

/**
 * The advance-height delta of a glyph at `coords` from a `VVAR` table, in font units (unrounded). The advance-height mapping is optional (without it the glyph index is the row of subtable 0);
 * the mappings of the side bearings and of the vertical origin are not used, but must lie inside the table.
 * @failure a version other than 1, an offset outside the table, a damaged store or map -> WRP_FONT_PARSE
 */
export function readVerticalAdvanceDeltas(vvar: ByteView, coords: readonly number[]): (glyph: number) => number {
  if (vvar.u16(0) !== 1) throw parseError(`VVAR: version ${vvar.u16(0)} is not 1`);
  const storeAt = vvar.u32(4);
  const store = readItemVariationStore(vvar.sub(storeAt, vvar.length - storeAt, 'VVAR store'));
  for (const offset of [12, 16, 20]) {
    const mappingAt = vvar.u32(offset);
    if (mappingAt !== 0) readIndexMap(vvar, mappingAt);
  }
  const advanceAt = vvar.u32(8);
  const mapped = advanceAt === 0 ? null : readIndexMap(vvar, advanceAt);
  return (glyph) => {
    const [outer, inner] = mapped === null ? [0, glyph] : mapped(glyph);
    return store.delta(outer, inner, coords);
  };
}
