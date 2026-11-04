import { describe, expect, it } from 'vitest';
import { buildInstanceBvh, exportInstanceBvh, importInstanceBvh, packBoxes, type InstanceBvhBuffers } from '@core/geometry/instanceBvh';
import { frustumPlanes, type PlanCamera } from '@core/geometry/renderPlanCamera';
import type { Vec3 } from '@core/model/vectors';

function randomBoxes(count: number, seed: number, degenerate = 0): Float64Array {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  const boxes: { min: Vec3; max: Vec3 }[] = [];
  for (let i = 0; i < count; i++) {
    const min: Vec3 = [next() * 200 - 100, next() * 200 - 100, next() * 40];
    boxes.push({ min, max: i < degenerate ? min : [min[0] + next() * 3, min[1] + next() * 3, min[2] + next() * 3] });
  }
  return packBoxes(boxes);
}

const camera: PlanCamera = {
  projection: 'perspective',
  eye: [0, -150, 60],
  direction: [0, 0.9486832980505138, -0.31622776601683794],
  up: [0, 0.31622776601683794, 0.9486832980505138],
  fovDeg: 40,
  viewHeight: 0,
  widthPx: 800,
  heightPx: 600,
};

describe('instance BVH export / import (BVH-XFER)', () => {
  it('round-trips through structuredClone with identical query results on 10^4 boxes', () => {
    const original = buildInstanceBvh(randomBoxes(10_000, 7, 50));
    const copy = importInstanceBvh(structuredClone(exportInstanceBvh(original)));
    const planes = frustumPlanes(camera);
    expect(copy.count).toBe(original.count);
    expect(original.frustumQuery(planes).length).toBeGreaterThan(0);
    expect(copy.frustumQuery(planes)).toEqual(original.frustumQuery(planes));
    for (const [origin, direction] of [
      [
        [-120, -3, 10],
        [1, 0.02, 0.01],
      ],
      [
        [0, 0, 100],
        [0, 0, -1],
      ],
    ] as [Vec3, Vec3][]) {
      expect(copy.rayQuery(origin, direction)).toEqual(original.rayQuery(origin, direction));
    }
    const [min, max]: [Vec3, Vec3] = [
      [-20, -20, 0],
      [30, 25, 20],
    ];
    expect(original.boxQuery(min, max).length).toBeGreaterThan(0);
    expect(copy.boxQuery(min, max)).toEqual(original.boxQuery(min, max));
  });

  it('transfers without detaching the source BVH, and handles an empty BVH', () => {
    const original = buildInstanceBvh(randomBoxes(100, 3));
    const buffers = exportInstanceBvh(original);
    const moved = structuredClone(buffers, { transfer: buffers.transfer });
    expect(buffers.boxes.byteLength).toBe(0);
    const [min, max]: [Vec3, Vec3] = [
      [-100, -100, 0],
      [100, 100, 50],
    ];
    expect(importInstanceBvh(moved).boxQuery(min, max)).toEqual(original.boxQuery(min, max));
    expect(original.boxQuery(min, max)).toHaveLength(100);
    const empty = importInstanceBvh(exportInstanceBvh(buildInstanceBvh(new Float64Array(0))));
    expect(empty.count).toBe(0);
    expect(empty.boxQuery([0, 0, 0], [1, 1, 1])).toEqual([]);
  });

  it('is deterministic', () => {
    const a = exportInstanceBvh(buildInstanceBvh(randomBoxes(500, 11)));
    const b = exportInstanceBvh(buildInstanceBvh(randomBoxes(500, 11)));
    expect(a).toEqual(b);
  });

  it('rejects foreign BVHs and malformed buffers', () => {
    const foreign = { count: 0, frustumQuery: () => [], rayQuery: () => [], boxQuery: () => [] };
    expect(() => exportInstanceBvh(foreign)).toThrow(/not an InstanceBvh/);
    const good = exportInstanceBvh(buildInstanceBvh(randomBoxes(40, 5)));
    const empty = {
      nodeCount: 0,
      nodeBox: new Float64Array(0),
      nodeStart: new Uint32Array(0),
      nodeEnd: new Uint32Array(0),
      nodeChild: new Int32Array(0),
    };
    const cases: [Partial<Record<keyof InstanceBvhBuffers, unknown>>, RegExp][] = [
      [{ count: -1 }, /count must/],
      [{ nodeCount: 1.5 }, /nodeCount must/],
      [{ boxes: new Float64Array(5) }, /boxes must/],
      [{ boxes: good.boxes.map(() => NaN) }, /finite/],
      [{ order: new Uint32Array(40) }, /permutation/],
      [{ order: new Uint32Array(3) }, /order must/],
      [{ nodeBox: new Float64Array(3) }, /nodeBox must/],
      [{ nodeStart: new Uint32Array(1) }, /nodeStart must/],
      [{ nodeEnd: new Float64Array(good.nodeCount) }, /nodeEnd must/],
      [{ nodeChild: new Int32Array(1) }, /nodeChild must/],
      [empty, /inconsistent/],
      [{ nodeEnd: good.nodeEnd.map(() => 999) }, /range/],
      [{ nodeChild: good.nodeChild.map(() => 0) }, /child link/],
    ];
    for (const [patch, message] of cases) {
      expect(() => importInstanceBvh({ ...good, ...patch } as InstanceBvhBuffers), Object.keys(patch).join()).toThrow(message);
    }
  });
});
