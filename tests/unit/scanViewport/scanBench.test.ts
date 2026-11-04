// Opt-in CPU benchmark of the scan viewport: LLULL_SCAN_BENCH=1 npx vitest run tests/unit/scanViewport/scanBench.test.ts
// Measures what a headless run can: the LOD plan, the tile buffer build, the kd-tree build and the snap query (linear vs kd-tree) at
// 1 / 2 / 3 M points. It cannot measure GPU draw cost or frame time (no GPU here): those need the desktop app.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildTileBuffers } from '../../../src/ui/viewport/3d/scan/tileBuffers';
import { buildKdTree, type KdTree } from '../../../src/ui/viewport/3d/scan/kdTree';
import { buildTileGrid } from '../../../src/ui/viewport/3d/scan/tileGrid';
import { LEVEL_BUDGETS, selectLevels } from '../../../src/ui/viewport/3d/scan/lodSelect';
import { nearestScreenPoint, type SnapTile, type SnapView } from '../../../src/ui/viewport/3d/scan/pointSnap';

const enabled = process.env['LLULL_SCAN_BENCH'] === '1';

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
function time(runs: number, fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  return median(samples);
}

describe.skipIf(!enabled)('scan viewport CPU benchmark', () => {
  it.each([1_000_000, 2_000_000, 3_000_000])('%i points', (budget) => {
    const grid = buildTileGrid({ min: [0, 0, 0], max: [60, 40, 12] }, 32);
    const camera = { position: [30, -8, 8] as [number, number, number], fov: 1, viewportHeight: 2000, sees: () => true };
    const planMs = time(50, () => void selectLevels(grid, camera, budget));
    const levels = selectLevels(grid, camera, budget);
    let seed = 1;
    const rand = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const trees = new WeakMap<Float32Array, KdTree>();
    const tiles: SnapTile[] = [];
    let total = 0;
    let bufferMs = 0;
    let treeMs = 0;
    for (const tile of grid) {
      const level = levels.get(tile.key);
      if (level === undefined) continue;
      const n = Math.min(LEVEL_BUDGETS[level] ?? 0, 200_000);
      const positions = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        positions[3 * i] = tile.min[0] + rand() * (tile.max[0] - tile.min[0]);
        positions[3 * i + 1] = tile.min[1] + rand() * (tile.max[1] - tile.min[1]);
        positions[3 * i + 2] = tile.min[2] + rand() * (tile.max[2] - tile.min[2]);
      }
      let t = performance.now();
      const buffers = buildTileBuffers({ positions, complete: false }, tile.min, 'elevation', { zLow: 0, zHigh: 12 });
      bufferMs += performance.now() - t;
      t = performance.now();
      trees.set(buffers.positions, buildKdTree(buffers.positions));
      treeMs += performance.now() - t;
      total += buffers.count;
      tiles.push({ origin: tile.min, positions: buffers.positions, centre: tile.centre, radius: tile.radius });
    }
    const cam = new THREE.PerspectiveCamera(57, 1, 0.1, 500);
    cam.up.set(0, 0, 1);
    cam.position.set(30, -8, 8);
    cam.lookAt(30, 20, 4);
    cam.updateMatrixWorld();
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const view: SnapView = { viewProjection: [...vp.elements], renderOrigin: [0, 0, 0], width: 1000, height: 1000, focalPx: 1000 };
    const pointer = { x: 500, y: 500 };
    const linearMs = time(5, () => void nearestScreenPoint(tiles, view, pointer, 12));
    const treeQueryMs = time(5, () => void nearestScreenPoint(tiles, view, pointer, 12, (tile) => trees.get(tile.positions)));
    expect(nearestScreenPoint(tiles, view, pointer, 12, (tile) => trees.get(tile.positions))).toEqual(
      nearestScreenPoint(tiles, view, pointer, 12),
    );
    console.warn(
      `[scan-bench] budget=${budget} drawn=${total} tiles=${tiles.length} plan=${planMs.toFixed(2)}ms buffers(all)=${bufferMs.toFixed(0)}ms ` +
        `kdBuild(all)=${treeMs.toFixed(0)}ms snap linear=${linearMs.toFixed(2)}ms kd=${treeQueryMs.toFixed(2)}ms`,
    );
  });
});
