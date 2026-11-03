// Point colours: pure ramps. The elevation ramp is available for every cloud; rgb / intensity / classification need per-point attribute
// arrays that a tile carries only when the host sends them (`query_cloud_points` sends positions only today: see TileAttributes).

export type ColourMode = 'rgb' | 'intensity' | 'elevation' | 'classification' | 'single';

export const COLOUR_MODES: readonly ColourMode[] = ['rgb', 'intensity', 'elevation', 'classification', 'single'];

export const COLOUR_MODE_LABELS: Readonly<Record<ColourMode, string>> = {
  rgb: 'Colour',
  intensity: 'Intensity',
  elevation: 'Elevation',
  classification: 'Class',
  single: 'Flat',
};

/** Optional per-point columns of a tile, one entry per point. */
export interface TileAttributes {
  /** 0..255 (8-bit) or 0..65535 (16-bit LAS / E57): normalised by the tile maximum above 255. */
  readonly rgb?: ArrayLike<number> | undefined;
  readonly intensity?: ArrayLike<number> | undefined;
  /** ASPRS classification codes. */
  readonly classification?: ArrayLike<number> | undefined;
}

export type Rgb = readonly [number, number, number];

/** Flat colour of `single` (and the fallback): a cool grey-blue that reads on both viewport themes. */
export const SINGLE_COLOUR: Rgb = [0.62, 0.72, 0.84];

/** Viridis, 6 stops (low to high). */
const ELEVATION_STOPS: readonly Rgb[] = [
  [0.267, 0.005, 0.329],
  [0.231, 0.322, 0.546],
  [0.128, 0.567, 0.551],
  [0.267, 0.749, 0.441],
  [0.678, 0.865, 0.204],
  [0.993, 0.906, 0.144],
];

/** ASPRS standard classes: 0 never classified, 1 unassigned, 2 ground, 3-5 vegetation, 6 building, 7 noise, 9 water, 17 bridge, 18 high noise. */
const CLASS_COLOURS: Readonly<Record<number, Rgb>> = {
  0: [0.55, 0.55, 0.55],
  1: [0.7, 0.7, 0.7],
  2: [0.65, 0.45, 0.25],
  3: [0.55, 0.8, 0.45],
  4: [0.3, 0.7, 0.3],
  5: [0.1, 0.5, 0.2],
  6: [0.95, 0.45, 0.35],
  7: [1, 0.1, 0.6],
  9: [0.25, 0.55, 0.95],
  17: [0.95, 0.8, 0.3],
  18: [0.8, 0.1, 0.9],
};
const UNKNOWN_CLASS: Rgb = [0.85, 0.85, 0.2];

export function elevationColour(z: number, low: number, high: number): Rgb {
  const t = high > low ? Math.min(1, Math.max(0, (z - low) / (high - low))) : 0.5;
  const scaled = t * (ELEVATION_STOPS.length - 1);
  const index = Math.min(ELEVATION_STOPS.length - 2, Math.floor(scaled));
  const a = ELEVATION_STOPS[index] ?? SINGLE_COLOUR;
  const b = ELEVATION_STOPS[index + 1] ?? SINGLE_COLOUR;
  const f = scaled - index;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function classificationColour(code: number): Rgb {
  return CLASS_COLOURS[code] ?? UNKNOWN_CLASS;
}

/** Modes a tile can be coloured by: elevation and flat always, the others when the column is there. */
export function availableModes(attributes: TileAttributes | undefined): readonly ColourMode[] {
  return COLOUR_MODES.filter(
    (mode) => mode === 'elevation' || mode === 'single' || (attributes !== undefined && attributes[mode] !== undefined),
  );
}

/** The mode actually used: the requested one, else elevation (a missing column is never an error, the panel says so). */
export function effectiveMode(requested: ColourMode, attributes: TileAttributes | undefined): ColourMode {
  return availableModes(attributes).includes(requested) ? requested : 'elevation';
}

export interface ColourRange {
  readonly zLow: number;
  readonly zHigh: number;
}

function maxOf(values: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < values.length; i++) max = Math.max(max, values[i] ?? 0);
  return max;
}

/**
 * RGB float triples for `count` points. `zOf(i)` is the document elevation of point i. Rgb columns above 255 are 16-bit and are
 * normalised by 65535. Intensity is stretched over the tile's own maximum (a grey ramp, never black).
 */
export function colourBuffer(
  mode: ColourMode,
  count: number,
  zOf: (index: number) => number,
  range: ColourRange,
  attributes?: TileAttributes,
): Float32Array {
  const out = new Float32Array(count * 3);
  const mode2 = effectiveMode(mode, attributes);
  const rgb = attributes?.rgb;
  const intensity = attributes?.intensity;
  const classes = attributes?.classification;
  const rgbScale = mode2 === 'rgb' && rgb !== undefined ? (maxOf(rgb) > 255 ? 1 / 65535 : 1 / 255) : 1;
  const intensityMax = mode2 === 'intensity' && intensity !== undefined ? Math.max(1, maxOf(intensity)) : 1;
  for (let i = 0; i < count; i++) {
    let c: Rgb;
    if (mode2 === 'rgb' && rgb !== undefined)
      c = [(rgb[3 * i] ?? 0) * rgbScale, (rgb[3 * i + 1] ?? 0) * rgbScale, (rgb[3 * i + 2] ?? 0) * rgbScale];
    else if (mode2 === 'intensity' && intensity !== undefined) {
      const g = 0.15 + 0.85 * ((intensity[i] ?? 0) / intensityMax);
      c = [g, g, g];
    } else if (mode2 === 'classification' && classes !== undefined) c = classificationColour(classes[i] ?? 0);
    else if (mode2 === 'single') c = SINGLE_COLOUR;
    else c = elevationColour(zOf(i), range.zLow, range.zHigh);
    out[3 * i] = c[0];
    out[3 * i + 1] = c[1];
    out[3 * i + 2] = c[2];
  }
  return out;
}
