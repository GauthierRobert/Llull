import { describe, expect, it } from 'vitest';
import {
  availableModes,
  classificationColour,
  colourBuffer,
  effectiveMode,
  elevationColour,
  SINGLE_COLOUR,
} from '../../../src/ui/viewport/3d/scan/colourModes';
import { cropsFor, keepsPoint, keptIndices, type CropLike } from '../../../src/ui/viewport/3d/scan/cropFilter';
import { buildTileBuffers } from '../../../src/ui/viewport/3d/scan/tileBuffers';

const RANGE = { zLow: 0, zHigh: 10 };
const inside: CropLike = { cloudIds: [], min: [0, 0, 0], max: [5, 5, 5], keep: 'inside' };
const outside: CropLike = { cloudIds: ['c1'], min: [1, 1, 1], max: [2, 2, 2], keep: 'outside' };
const f32 = (values: readonly number[]): number[] => values.map((v) => Math.fround(v));

describe('colour modes', () => {
  it('ramps elevation from the low to the high end and clamps', () => {
    const low = elevationColour(0, 0, 10);
    const high = elevationColour(10, 0, 10);
    expect(elevationColour(-5, 0, 10)).toEqual(low);
    expect(elevationColour(99, 0, 10)).toEqual(high);
    expect(low).not.toEqual(high);
    expect(elevationColour(3, 5, 5)).toEqual(elevationColour(7, 5, 5));
  });

  it('offers elevation and flat always, the rest only with data', () => {
    expect(availableModes(undefined)).toEqual(['elevation', 'single']);
    expect(availableModes({ intensity: [1] })).toEqual(['intensity', 'elevation', 'single']);
    expect(effectiveMode('rgb', undefined)).toBe('elevation');
    expect(effectiveMode('rgb', { rgb: [1, 2, 3] })).toBe('rgb');
  });

  it('colours by rgb (8 and 16 bit), intensity and class when the column exists', () => {
    const z = (): number => 0;
    expect([...colourBuffer('rgb', 1, z, RANGE, { rgb: [255, 0, 51] })]).toEqual(f32([1, 0, 0.2]));
    expect(colourBuffer('rgb', 1, z, RANGE, { rgb: [65535, 0, 0] })[0]).toBe(1);
    const grey = colourBuffer('intensity', 2, z, RANGE, { intensity: [0, 100] });
    expect(grey[0]).toBeCloseTo(0.15, 5);
    expect(grey[3]).toBeCloseTo(1, 5);
    const classes = colourBuffer('classification', 2, z, RANGE, { classification: [2, 77] });
    expect([...classes.slice(0, 3)]).toEqual(f32(classificationColour(2)));
    expect(classificationColour(77)).not.toEqual(classificationColour(2));
  });

  it('falls back to elevation for a missing column and paints flat as one colour', () => {
    expect([...colourBuffer('rgb', 1, () => 10, RANGE)]).toEqual(f32(elevationColour(10, 0, 10)));
    const flat = colourBuffer('single', 2, () => 0, RANGE);
    expect(flat[0]).toBeCloseTo(SINGLE_COLOUR[0], 5);
    expect(flat[3]).toBeCloseTo(SINGLE_COLOUR[0], 5);
  });
});

describe('crop filter', () => {
  it('selects the crops that apply to a cloud', () => {
    expect(cropsFor([inside, outside], 'c1')).toHaveLength(2);
    expect(cropsFor([inside, outside], 'c2')).toEqual([inside]);
  });

  it('keeps inside points of an inside crop and outside points of an outside crop', () => {
    expect(keepsPoint([inside], 1, 1, 1)).toBe(true);
    expect(keepsPoint([inside], 9, 1, 1)).toBe(false);
    expect(keepsPoint([outside], 1.5, 1.5, 1.5)).toBe(false);
    expect(keepsPoint([outside], 4, 4, 4)).toBe(true);
    expect(keepsPoint([inside, outside], 1.5, 1.5, 1.5)).toBe(false);
  });

  it('returns the surviving indices, all of them without crops', () => {
    const points = [1, 1, 1, 9, 9, 9, 3, 3, 3];
    expect([...keptIndices(points, [inside])]).toEqual([0, 2]);
    expect([...keptIndices(points, [])]).toEqual([0, 1, 2]);
  });
});

describe('tile buffers', () => {
  it('stores positions relative to the origin and colours per surviving point', () => {
    const data = { positions: [1000, 2000, 3, 1001, 2001, 4, 1002, 2002, 50], complete: false };
    const crop: CropLike = { cloudIds: [], min: [999, 1999, 0], max: [1100, 2100, 10], keep: 'inside' };
    const buffers = buildTileBuffers(data, [1000, 2000, 0], 'elevation', RANGE, [crop]);
    expect(buffers.count).toBe(2);
    expect([...buffers.positions]).toEqual([0, 0, 3, 1, 1, 4]);
    expect(buffers.colours).toHaveLength(6);
    expect(buffers.origin).toEqual([1000, 2000, 0]);
  });

  it('keeps per-point columns aligned with the surviving points', () => {
    const data = { positions: [0, 0, 1, 50, 0, 1, 1, 1, 1], attributes: { intensity: [10, 20, 30] }, complete: true };
    const buffers = buildTileBuffers(data, [0, 0, 0], 'intensity', RANGE, [inside]);
    expect(buffers.count).toBe(2);
    expect(buffers.colours[3]).toBeCloseTo(1, 5);
    expect(buffers.colours[0]).toBeLessThan(buffers.colours[3] ?? 0);
  });
});
