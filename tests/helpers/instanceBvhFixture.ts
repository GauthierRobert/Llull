/** Seeded box sets, queries and the TypeScript BVH results the native `llull-bvh` instance tree must reproduce (VC-VIS-60, native side). */
import { buildInstanceBvh, exportInstanceBvh, packBoxes } from '@core/geometry/instanceBvh';
import type { FrustumPlane } from '@core/geometry/renderPlanCamera';
import type { Vec3 } from '@core/model/vectors';
import { seeded } from '../unit/cae/gridMesh';

type Box = { min: Vec3; max: Vec3 };

function randomBoxes(count: number, seed: number, zeroSize: number, identical: number): Box[] {
  const next = seeded(seed);
  const boxes: Box[] = [];
  for (let i = 0; i < count; i++) {
    const min: Vec3 = [next() * 200 - 100, next() * 200 - 100, next() * 40];
    if (i < zeroSize) boxes.push({ min, max: min });
    else if (i < zeroSize + identical) boxes.push({ min: [5, 5, 5], max: [6, 7, 8] });
    else boxes.push({ min, max: [min[0] + next() * 3, min[1] + next() * 3, min[2] + next() * 3] });
  }
  return boxes;
}

function queriesFor(next: () => number): { frustum: FrustumPlane[][]; rays: [Vec3, Vec3][]; boxes: [Vec3, Vec3][] } {
  const frustum: FrustumPlane[][] = [];
  for (let q = 0; q < 14; q++) {
    const planes: FrustumPlane[] = [];
    for (let p = 0; p < 4 + (q % 3); p++) {
      // axis-aligned normals (zero components) every third plane exercise the sign branch of the near-corner pick
      const axis = p % 3;
      const normal: Vec3 =
        q % 2 === 0 ? [axis === 0 ? 1 : 0, axis === 1 ? -1 : 0, axis === 2 ? 1 : 0] : [next() - 0.5, next() - 0.5, next() - 0.5];
      planes.push({ normal, offset: (next() - 0.3) * 120 });
    }
    frustum.push(planes);
  }
  const rays: [Vec3, Vec3][] = [];
  for (let q = 0; q < 20; q++)
    rays.push([
      [next() * 260 - 130, next() * 260 - 130, next() * 60 - 10],
      q % 5 === 0 ? [0, next() - 0.5, 0] : [next() - 0.5, next() - 0.5, (next() - 0.5) * 0.3],
    ]);
  const boxes: [Vec3, Vec3][] = [];
  for (let q = 0; q < 20; q++) {
    const min: Vec3 = [next() * 200 - 100, next() * 200 - 100, next() * 40];
    boxes.push([min, [min[0] + next() * 60, min[1] + next() * 60, min[2] + next() * 20]]);
  }
  boxes.push(
    [
      [5, 5, 5],
      [6, 7, 8],
    ],
    [
      [6, 7, 8],
      [9, 9, 9],
    ],
  );
  return { frustum, rays, boxes };
}

/** One entry per box set: the boxes, the exported tree arrays and the ascending results of each query. */
export function instanceBvhCases(): Record<string, unknown>[] {
  const sets: [string, Box[]][] = [
    ['random-700-zero-identical', randomBoxes(700, 11, 40, 25)],
    ['random-3000', randomBoxes(3000, 12, 0, 0)],
    ['all-identical-37', randomBoxes(37, 13, 0, 37)],
    ['all-zero-size-60', randomBoxes(60, 14, 60, 0)],
    ['single-leaf-3', randomBoxes(3, 15, 0, 0)],
    ['empty', []],
  ];
  return sets.map(([name, boxes], index) => {
    const bvh = buildInstanceBvh(packBoxes(boxes));
    const tree = exportInstanceBvh(bvh);
    const queries = queriesFor(seeded(500 + index));
    return {
      name,
      boxes: Array.from(tree.boxes),
      order: Array.from(tree.order),
      nodeBox: Array.from(tree.nodeBox),
      nodeStart: Array.from(tree.nodeStart),
      nodeEnd: Array.from(tree.nodeEnd),
      nodeChild: Array.from(tree.nodeChild),
      frustum: queries.frustum.map((planes) => ({ planes, result: bvh.frustumQuery(planes) })),
      rays: queries.rays.map(([origin, direction]) => ({ origin, direction, result: bvh.rayQuery(origin, direction) })),
      boxQueries: queries.boxes.map(([min, max]) => ({ min, max, result: bvh.boxQuery(min, max) })),
    };
  });
}
