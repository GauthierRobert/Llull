import { describe, expect, it } from 'vitest';
import { boxInsidePlanes, boxOverlapsBox, buildInstanceBvh, packBoxes, rayHitsBox, type PackedBoxes } from '@core/geometry/instanceBvh';
import { frustumPlanes, type PlanCamera } from '@core/geometry/renderPlanCamera';
import type { Vec3 } from '@core/model/vectors';

/** Deterministic xorshift in [0, 1). */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function randomBoxes(count: number, seed: number, degenerate = 0): PackedBoxes {
  const next = rng(seed);
  const boxes: { min: Vec3; max: Vec3 }[] = [];
  for (let i = 0; i < count; i++) {
    const min: Vec3 = [next() * 200 - 100, next() * 200 - 100, next() * 40];
    const flat = i < degenerate;
    boxes.push({ min, max: flat ? min : [min[0] + next() * 3, min[1] + next() * 3, min[2] + next() * 3] });
  }
  return packBoxes(boxes);
}

const camera = (over: Partial<PlanCamera> = {}): PlanCamera => ({
  projection: 'perspective',
  eye: [0, -150, 60],
  direction: [0, 0.9486832980505138, -0.31622776601683794],
  up: [0, 0.31622776601683794, 0.9486832980505138],
  fovDeg: 40,
  viewHeight: 0,
  widthPx: 800,
  heightPx: 600,
  ...over,
});

const brute = (count: number, hit: (offset: number) => boolean): number[] =>
  Array.from({ length: count }, (_, i) => i).filter((i) => hit(i * 6));

describe('instanceBvh', () => {
  const boxes = randomBoxes(10_000, 7, 300);
  const bvh = buildInstanceBvh(boxes);

  it('frustum query equals the brute-force scan (perspective, orthographic, several cameras)', () => {
    const cameras = [
      camera(),
      camera({ eye: [30, -20, 80], fovDeg: 20 }),
      camera({ projection: 'orthographic', fovDeg: 0, viewHeight: 60, eye: [10, -150, 30] }),
      camera({ projection: 'orthographic', fovDeg: 0, viewHeight: 400, eye: [0, -150, 30] }),
    ];
    for (const view of cameras) {
      const planes = frustumPlanes(view);
      const expected = brute(bvh.count, (o) => boxInsidePlanes(boxes, o, planes));
      const result = bvh.frustumQuery(planes);
      expect(result).toEqual(expected);
      expect(result.length).toBeGreaterThan(0);
    }
    const everything = bvh.frustumQuery(frustumPlanes(camera({ projection: 'orthographic', fovDeg: 0, viewHeight: 4000 })));
    expect(everything.length).toBe(10_000);
  });

  it('ray query equals the brute-force scan, including axis-parallel rays', () => {
    const next = rng(11);
    const rays: [Vec3, Vec3][] = [
      [
        [-120, 0, 5],
        [1, 0, 0],
      ],
      [
        [0, 0, 100],
        [0, 0, -1],
      ],
      [
        [10, 10, 10],
        [0, 1, 0],
      ],
    ];
    for (let i = 0; i < 40; i++)
      rays.push([
        [next() * 200 - 100, next() * 200 - 100, 50],
        [next() - 0.5, next() - 0.5, -next()],
      ]);
    let hits = 0;
    for (const [origin, direction] of rays) {
      const result = bvh.rayQuery(origin, direction);
      expect(result).toEqual(brute(bvh.count, (o) => rayHitsBox(boxes, o, origin, direction)));
      hits += result.length;
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('box query equals the brute-force scan', () => {
    for (const [min, max] of [
      [
        [-10, -10, 0],
        [10, 10, 40],
      ],
      [
        [50, 50, 10],
        [50, 50, 10],
      ],
      [
        [-200, -200, -5],
        [200, 200, 80],
      ],
      [
        [500, 500, 500],
        [600, 600, 600],
      ],
    ] as [Vec3, Vec3][])
      expect(bvh.boxQuery(min, max)).toEqual(brute(bvh.count, (o) => boxOverlapsBox(boxes, o, min, max)));
  });

  it('equals brute force on degenerate, point, touching and exact-boundary boxes and a grazing ray', () => {
    const list: { min: Vec3; max: Vec3 }[] = [
      { min: [0, 0, 0], max: [0, 0, 0] },
      { min: [1, 1, 1], max: [1, 1, 1] },
      { min: [0, 0, 0], max: [1, 0, 1] },
      { min: [1, 0, 0], max: [2, 1, 1] },
      { min: [2, 0, 0], max: [3, 1, 1] },
      { min: [-1, -1, -1], max: [-1, 5, -1] },
      { min: [4, 4, 4], max: [4, 4, 5] },
      ...Array.from({ length: 20 }, (_, i) => ({ min: [i, i, 0] as Vec3, max: [i + 1, i + 1, 0] as Vec3 })),
    ];
    const packed = packBoxes(list);
    const tree = buildInstanceBvh(packed);
    const queries: [Vec3, Vec3][] = [
      [
        [1, 0, 0],
        [2, 1, 1],
      ],
      [
        [1, 1, 1],
        [1, 1, 1],
      ],
      [
        [3, 0, 0],
        [4, 4, 4],
      ],
      [
        [-1, -1, -1],
        [0, 0, 0],
      ],
      [
        [0.5, 0.5, 0.5],
        [0.5, 0.5, 0.5],
      ],
    ];
    for (const [min, max] of queries)
      expect(tree.boxQuery(min, max)).toEqual(brute(tree.count, (o) => boxOverlapsBox(packed, o, min, max)));
    const rays: [Vec3, Vec3][] = [
      [
        [-5, 1, 1],
        [1, 0, 0],
      ],
      [
        [0, 0, 0],
        [1, 1, 0],
      ],
      [
        [1, 2, 0.5],
        [0, -1, 0],
      ],
      [
        [1, -3, 1],
        [0, 1, 0],
      ],
      [
        [-2, 1, 0],
        [1, 0, 0],
      ],
      [
        [2, 1.0000000000000002, 0.5],
        [1, 0, 0],
      ],
    ];
    let hits = 0;
    for (const [origin, direction] of rays) {
      const result = tree.rayQuery(origin, direction);
      expect(result).toEqual(brute(tree.count, (o) => rayHitsBox(packed, o, origin, direction)));
      hits += result.length;
    }
    expect(hits).toBeGreaterThan(5);
  });

  it('is deterministic', () => {
    const again = buildInstanceBvh(boxes);
    const planes = frustumPlanes(camera());
    expect(again.frustumQuery(planes)).toEqual(bvh.frustumQuery(planes));
  });

  it('handles empty input, one box, identical boxes and invalid rays', () => {
    const empty = buildInstanceBvh(new Float64Array(0));
    expect(empty.count).toBe(0);
    expect(empty.frustumQuery(frustumPlanes(camera()))).toEqual([]);
    expect(empty.rayQuery([0, 0, 0], [1, 0, 0])).toEqual([]);
    expect(empty.boxQuery([0, 0, 0], [1, 1, 1])).toEqual([]);
    const one = buildInstanceBvh(packBoxes([{ min: [0, 0, 0], max: [1, 1, 1] }]));
    expect(one.rayQuery([-1, 0.5, 0.5], [1, 0, 0])).toEqual([0]);
    expect(one.rayQuery([-1, 0.5, 0.5], [-1, 0, 0])).toEqual([]);
    expect(one.rayQuery([-1, 0.5, 0.5], [0, 0, 0])).toEqual([]);
    expect(one.rayQuery([-1, 0.5, 0.5], [Number.NaN, 0, 0])).toEqual([]);
    const same = buildInstanceBvh(packBoxes(Array.from({ length: 50 }, () => ({ min: [1, 1, 1] as Vec3, max: [2, 2, 2] as Vec3 }))));
    expect(same.boxQuery([0, 0, 0], [1, 1, 1])).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(same.boxQuery([3, 3, 3], [4, 4, 4])).toEqual([]);
  });
});
