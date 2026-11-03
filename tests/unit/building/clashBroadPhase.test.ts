import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { findClashes } from '@aec/industrial/clash/clash';
import { clashStressDocument } from '../../helpers/clashStress';

describe('check_clashes broad phase (VIS-M7)', () => {
  it.each([
    [1, 400, 20_000],
    [2, 900, 40_000],
  ])('the BVH scan equals the full scan on a randomized building (seed %i, %i elements)', (seed, count, side) => {
    const doc = clashStressDocument(count, seed, side);
    for (const tolerance of [0, 5]) {
      const full = findClashes(doc, null, tolerance, Infinity);
      const viaBvh = findClashes(doc, null, tolerance, 0);
      expect(viaBvh).toEqual(full);
      expect(full.length).toBeGreaterThan(5);
    }
    expect(new Set(findClashes(doc, null, 0, Infinity).map((clash) => clash.kind)).size).toBeGreaterThan(1);
  });

  it('check_clashes is pure and read-only, and a level filter keeps both scans equal', () => {
    const doc = clashStressDocument(120, 3, 12_000);
    const before = JSON.stringify(doc.building);
    const result = execute(doc, 'check_clashes', {});
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc.building)).toBe(before);
    const levelId = doc.building?.levelOrder[0] ?? '';
    expect(findClashes(doc, new Set([levelId]), 0, 0)).toEqual(findClashes(doc, new Set([levelId]), 0, Infinity));
    expect(findClashes(doc, new Set(['none']), 0, 0)).toEqual([]);
  });

  it('an empty building has no clashes on either path', () => {
    const empty = clashStressDocument(0, 1);
    expect(findClashes(empty, null, 0, 0)).toEqual([]);
    expect(findClashes(empty, null, 0, Infinity)).toEqual([]);
  });
});

describe.skipIf(process.env['VIS_PERF'] === undefined)('check_clashes broad-phase timing', () => {
  it.each([20, 50, 100, 200, 500, 1000, 1500, 3000, 6000])(
    'n = %i elements',
    (count) => {
      const doc = clashStressDocument(count, 5, 12_000 * Math.sqrt(count / 100));
      const t0 = performance.now();
      const full = findClashes(doc, null, 5, Infinity);
      const t1 = performance.now();
      const viaBvh = findClashes(doc, null, 5, 0);
      const t2 = performance.now();
      console.warn(
        `VIS-PERF clash n=${count} full ${(t1 - t0).toFixed(0)} ms, bvh ${(t2 - t1).toFixed(0)} ms (${full.length}=${viaBvh.length} clashes)`,
      );
    },
    600_000,
  );
});
