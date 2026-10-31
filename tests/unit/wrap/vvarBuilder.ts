/** Test tables of the vertical metrics and the named instances (03 WRP, TECHNICAL_SPEC §14.18): `fvar` with instance records, `VVAR`, `vhea` and `vmtx`. */

import { buildStore, type AxisSpec, type StoreSpec } from './cff2Builder';

const u16 = (v: number): number[] => [(v >> 8) & 255, v & 255];
const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const fixed = (v: number): number[] => u32(Math.round(v * 65536) >>> 0);

export interface InstanceSpec {
  /** Name id of the subfamily name (`name` table). */
  readonly subfamily: number;
  /** Name id of the PostScript name; written only when `withPostScript` is set on the table. */
  readonly postScript?: number;
  /** One design value per axis, in axis order. */
  readonly coordinates: readonly number[];
}

/** An `fvar` table with instance records (the short form, or with the PostScript name id when `withPostScript`). */
export function buildFvarWithInstances(axes: readonly AxisSpec[], instances: readonly InstanceSpec[], withPostScript: boolean): number[] {
  const size = 4 + 4 * axes.length + (withPostScript ? 2 : 0);
  const out = [...u16(1), ...u16(0), ...u16(16), ...u16(2), ...u16(axes.length), ...u16(20), ...u16(instances.length), ...u16(size)];
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
  for (const instance of instances) {
    out.push(...u16(instance.subfamily), ...u16(0), ...instance.coordinates.flatMap(fixed));
    if (withPostScript) out.push(...u16(instance.postScript ?? 0xffff));
  }
  return out;
}

/**
 * A `VVAR` table: advance-height deltas from `store`, optionally through a DeltaSetIndexMap of one-byte entries (format 0, 2 inner bits); `side` puts the same map at the three other offsets
 * (top and bottom side bearings, vertical origin), `offsets` replaces the header offsets (to write a damaged table).
 */
export function buildVvar(
  store: StoreSpec,
  map?: readonly number[],
  options: { readonly side?: boolean; readonly version?: number; readonly offsets?: readonly number[] } = {},
): number[] {
  const bytes = buildStore(store);
  const mapBytes = map === undefined ? [] : [0, 0x01, ...u16(map.length), ...map];
  const mapAt = 24 + bytes.length;
  const side = options.side === true && map !== undefined ? mapAt : 0;
  const header = options.offsets ?? [24, map === undefined ? 0 : mapAt, side, side, side];
  return [...u16(options.version ?? 1), ...u16(0), ...header.flatMap(u32), ...bytes, ...mapBytes];
}

/** A `vhea` table with `longMetrics` vertical metrics. */
export function buildVhea(longMetrics: number): number[] {
  const out = [...u32(0x00010000), ...u16(900), ...u16(0xff06), ...u16(0)];
  while (out.length < 34) out.push(0);
  return [...out, ...u16(longMetrics)];
}

/** A `vmtx` table: the heights of the long metrics with their top side bearings (`tops`, default 0), then the side bearings of the remaining `glyphs - heights.length` glyphs. */
export function buildVmtx(heights: readonly number[], glyphs: number, tops: readonly number[] = []): number[] {
  return [
    ...heights.flatMap((height, k) => [...u16(height), ...u16((tops[k] ?? 0) & 0xffff)]),
    ...Array.from({ length: glyphs - heights.length }, () => u16(0)).flat(),
  ];
}
