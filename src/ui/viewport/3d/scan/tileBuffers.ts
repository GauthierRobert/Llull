// A fetched tile as GPU-ready buffers: positions relative to the tile origin (float32 keeps millimetres at any site coordinate), colours
// from the chosen mode, crops applied. Pure.

import type { Vec3 } from '@core/model/vectors';
import { colourBuffer, type ColourMode, type ColourRange, type TileAttributes } from './colourModes';
import { keptIndices, type CropLike } from './cropFilter';

/** What the host returned for one tile query: document-frame positions, plus any per-point columns. */
export interface TileData {
  /** Flat [x, y, z, …], document units and frame. */
  readonly positions: ArrayLike<number>;
  readonly attributes?: TileAttributes | undefined;
  /** The answer held fewer points than asked: nothing finer exists in this box. */
  readonly complete: boolean;
}

export interface TileBuffers {
  readonly origin: Vec3;
  /** Local xyz, float32. */
  readonly positions: Float32Array;
  readonly colours: Float32Array;
  readonly count: number;
}

function pick(attributes: TileAttributes | undefined, kept: Uint32Array): TileAttributes | undefined {
  if (attributes === undefined) return undefined;
  const take = (column: ArrayLike<number> | undefined, width: number): ArrayLike<number> | undefined => {
    if (column === undefined) return undefined;
    const out = new Float64Array(kept.length * width);
    for (let i = 0; i < kept.length; i++) for (let k = 0; k < width; k++) out[i * width + k] = column[(kept[i] ?? 0) * width + k] ?? 0;
    return out;
  };
  return { rgb: take(attributes.rgb, 3), intensity: take(attributes.intensity, 1), classification: take(attributes.classification, 1) };
}

export function buildTileBuffers(
  data: TileData,
  origin: Vec3,
  mode: ColourMode,
  range: ColourRange,
  crops: readonly CropLike[] = [],
): TileBuffers {
  const kept = keptIndices(data.positions, crops);
  const positions = new Float32Array(kept.length * 3);
  for (let i = 0; i < kept.length; i++) {
    const source = (kept[i] ?? 0) * 3;
    positions[3 * i] = (data.positions[source] ?? 0) - origin[0];
    positions[3 * i + 1] = (data.positions[source + 1] ?? 0) - origin[1];
    positions[3 * i + 2] = (data.positions[source + 2] ?? 0) - origin[2];
  }
  const colours = colourBuffer(mode, kept.length, (i) => data.positions[(kept[i] ?? 0) * 3 + 2] ?? 0, range, pick(data.attributes, kept));
  return { origin, positions, colours, count: kept.length };
}
