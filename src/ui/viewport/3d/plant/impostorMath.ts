// Pure maths of the plant impostors: which instances of a LOD1 bucket are far enough to be drawn as a billboard, and the octahedral view
// atlas layout (direction <-> cell). The shader (plantImpostorMaterial.ts) repeats `octEncode` / the cell rule in GLSL; no three.js here.

import type { Vec3 } from '@core/model/types';
import { type PlanCamera } from '@core/geometry/renderPlanCamera';
import { type PlanScene, projectedPixels } from '@core/geometry/renderPlan';

/** An instance whose projected bounding-box diagonal is under this many pixels is drawn as an impostor (distance threshold per prototype). */
const IMPOSTOR_MAX_PX = 24;
/** An impostor that was drawn last time stays one until the size grows past this multiple of the threshold (no flicker at the edge). */
const IMPOSTOR_HOLD = 1.15;
/** Prototypes repeated fewer times in the scene never get an atlas (the capture would cost more than the instances). */
const IMPOSTOR_MIN_REPEATS = 24;
/** Octahedral atlas: GRID x GRID views, each CELL_PX square. */
export const ATLAS_GRID = 4;
export const ATLAS_CELL_PX = 64;

/** Octahedral mapping of a unit direction to [0, 1]^2 (the standard fold of the lower hemisphere). */
export function octEncode(direction: Vec3): [number, number] {
  const sum = Math.abs(direction[0]) + Math.abs(direction[1]) + Math.abs(direction[2]) || 1;
  let x = direction[0] / sum;
  let y = direction[1] / sum;
  if (direction[2] < 0) {
    const fx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const fy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = fx;
    y = fy;
  }
  return [x * 0.5 + 0.5, y * 0.5 + 0.5];
}

/** Inverse of `octEncode`: the unit direction of a point of [0, 1]^2. */
export function octDecode(u: number, v: number): Vec3 {
  const x = u * 2 - 1;
  const y = v * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  let dx = x;
  let dy = y;
  if (z < 0) {
    dx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    dy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
  }
  const length = Math.hypot(dx, dy, z) || 1;
  return [dx / length, dy / length, z / length];
}

/** Atlas cell (column, row) a view direction falls in. */
export function cellOf(direction: Vec3, grid = ATLAS_GRID): [number, number] {
  const [u, v] = octEncode(direction);
  const clamp = (value: number): number => Math.min(grid - 1, Math.max(0, Math.floor(value * grid)));
  return [clamp(u), clamp(v)];
}

/** The direction a cell is captured from: the decoded centre of the cell. */
export function cellDirection(column: number, row: number, grid = ATLAS_GRID): Vec3 {
  return octDecode((column + 0.5) / grid, (row + 0.5) / grid);
}

export interface ImpostorSplit {
  /** Scene indices kept as real LOD1 meshes (order kept). */
  readonly near: number[];
  /** Scene indices drawn as impostors (order kept). */
  readonly far: number[];
}

/**
 * Splits the members of a LOD1 bucket by projected size. `held` = the scene indices drawn as impostors the last time (hysteresis).
 * @invariant near and far partition `members`, both keep its order; an instance of a prototype with fewer than `minRepeats` copies is near
 */
export function splitImpostors(
  scene: PlanScene,
  members: readonly number[],
  camera: PlanCamera,
  held: ReadonlySet<number> | undefined,
  minRepeats = IMPOSTOR_MIN_REPEATS,
  maxPx = IMPOSTOR_MAX_PX,
): ImpostorSplit {
  const near: number[] = [];
  const far: number[] = [];
  const eye = camera.eye;
  for (const index of members) {
    const instance = scene.instances[index];
    if (instance === undefined || (scene.prototypeCounts[instance.prototype] ?? 0) < minRepeats) {
      near.push(index);
      continue;
    }
    const { min, max } = instance.aabb;
    const distance = Math.hypot((min[0] + max[0]) / 2 - eye[0], (min[1] + max[1]) / 2 - eye[1], (min[2] + max[2]) / 2 - eye[2]);
    const limit = held?.has(index) === true ? maxPx * IMPOSTOR_HOLD : maxPx;
    (projectedPixels(instance.diagonal, distance, camera) < limit ? far : near).push(index);
  }
  return { near, far };
}
