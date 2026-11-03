import { describe, expect, it } from 'vitest';
import { buildTileGrid, tileDivisions } from '../../../src/ui/viewport/3d/scan/tileGrid';
import {
  LEVEL_BUDGETS,
  selectLevels,
  selectionPoints,
  tilePixelDiameter,
  wantedLevel,
  type LodCamera,
} from '../../../src/ui/viewport/3d/scan/lodSelect';

const BOX = { min: [0, 0, 0], max: [40, 20, 10] } as const;

const camera = (position: [number, number, number], sees: LodCamera['sees'] = () => true): LodCamera => ({
  position,
  fov: Math.PI / 3,
  viewportHeight: 1000,
  sees,
});

describe('tile grid', () => {
  it('caps the tile count and keeps near-cubic cells', () => {
    const [nx, ny, nz] = tileDivisions(BOX, 32);
    expect(nx * ny * nz).toBeLessThanOrEqual(32);
    expect(nx).toBeGreaterThan(ny);
    expect(ny).toBeGreaterThanOrEqual(nz);
  });

  it('does not split a flat slab or a degenerate box', () => {
    expect(tileDivisions({ min: [0, 0, 0], max: [30, 30, 0.1] }, 16)[2]).toBe(1);
    expect(tileDivisions({ min: [1, 1, 1], max: [1, 1, 1] }, 16)).toEqual([1, 1, 1]);
    expect(tileDivisions(BOX, 1)).toEqual([1, 1, 1]);
  });

  it('tiles the box exactly and deterministically', () => {
    const tiles = buildTileGrid(BOX, 32);
    const volume = tiles.reduce((sum, t) => sum + (t.max[0] - t.min[0]) * (t.max[1] - t.min[1]) * (t.max[2] - t.min[2]), 0);
    expect(volume).toBeCloseTo(40 * 20 * 10, 6);
    expect(new Set(tiles.map((t) => t.key)).size).toBe(tiles.length);
    expect(buildTileGrid(BOX, 32)).toEqual(tiles);
  });
});

describe('LOD selection', () => {
  const tiles = buildTileGrid(BOX, 32);

  it('projects a tile to pixels and says Infinity inside it', () => {
    const [tile] = tiles;
    if (tile === undefined) throw new Error('no tile');
    const far = tilePixelDiameter(tile, camera([tile.centre[0], tile.centre[1], tile.centre[2] + 1000]));
    const near = tilePixelDiameter(tile, camera([tile.centre[0], tile.centre[1], tile.centre[2] + 100]));
    expect(near).toBeGreaterThan(far);
    expect(tilePixelDiameter(tile, camera([...tile.centre]))).toBe(Number.POSITIVE_INFINITY);
  });

  it('culls tiles outside the frustum or too small to see', () => {
    const [tile] = tiles;
    if (tile === undefined) throw new Error('no tile');
    expect(
      wantedLevel(
        tile,
        camera([0, 0, 100], () => false),
      ),
    ).toBe(-1);
    expect(wantedLevel(tile, camera([0, 0, 1e7]))).toBe(-1);
  });

  it('gives every visible tile the coarsest level first, then refines the biggest within the budget', () => {
    const cam = camera([20, 10, 30]);
    const coarse = selectLevels(tiles, cam, tiles.length * (LEVEL_BUDGETS[0] ?? 0));
    expect([...coarse.values()].every((level) => level === 0)).toBe(true);
    expect(coarse.size).toBe(tiles.length);
    const budget = 1_000_000;
    const refined = selectLevels(tiles, cam, budget);
    expect(selectionPoints(refined)).toBeLessThanOrEqual(budget);
    expect(Math.max(...refined.values())).toBeGreaterThan(0);
  });

  it('never exceeds the budget (level 0 is the floor) and is deterministic', () => {
    const cam = camera([20, 10, 15]);
    for (const budget of [0, 100_000, 500_000, 3_000_000]) {
      const levels = selectLevels(tiles, cam, budget);
      expect(selectionPoints(levels)).toBeLessThanOrEqual(Math.max(budget, levels.size * (LEVEL_BUDGETS[0] ?? 0)));
      expect([...selectLevels(tiles, cam, budget)]).toEqual([...levels]);
    }
  });

  it('does not refine a tile that is already complete at its level', () => {
    const cam = camera([20, 10, 15]);
    const free = selectLevels(tiles, cam, 3_000_000);
    const [key] = [...free.entries()].find(([, level]) => level > 0) ?? [];
    if (key === undefined) throw new Error('nothing refined');
    const stuck = selectLevels(tiles, cam, 3_000_000, new Map([[key, { level: 1, complete: true }]]));
    expect(stuck.get(key)).toBe(Math.min(1, free.get(key) ?? 0));
  });
});
