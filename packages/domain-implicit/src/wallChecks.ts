/** Measured wall and pore thickness of an implicit body for check_implicit (05 IMP 5.8, FR-IMP-40..42): the body's sign grid read by the distance transform. */

import type { FieldEngine } from '@core/geometry/field/engineTypes';
import type { FieldProgram } from '@core/geometry/field/program';
import type { Vec3 } from '@core/model/types';
import { type ThicknessStats, phaseThickness } from './edt';

/** Nodes the thickness analysis may use (the transform keeps ~20 bytes per node). */
const MAX_NODES = 2 ** 22;

export interface WallMeasures {
  readonly voxel: number;
  readonly wall: ThicknessStats;
  readonly pore: ThicknessStats;
  /** World position of the smallest wall / pore, or null. */
  readonly wallAt: Vec3 | null;
  readonly poreAt: Vec3 | null;
  readonly nodes: number;
}

/**
 * Wall (solid) and pore (complement) thickness of `program` over `box` padded by 2 voxels, on a grid of at least `body voxel` spacing and at most MAX_NODES nodes.
 * @failure the engine refuses the grid -> its message
 */
export function measureWalls(
  engine: FieldEngine,
  program: FieldProgram,
  box: { readonly min: Vec3; readonly max: Vec3 },
  bodyVoxel: number,
): WallMeasures | string {
  const extent = [0, 1, 2].map((axis) => (box.max[axis] as number) - (box.min[axis] as number));
  const volume = extent.reduce((a, b) => a * (b + 4 * bodyVoxel), 1);
  const voxel = Math.max(bodyVoxel, Math.cbrt(volume / MAX_NODES));
  const pad = 2 * voxel;
  const grid = {
    min: [box.min[0] - pad, box.min[1] - pad, box.min[2] - pad] as Vec3,
    max: [box.max[0] + pad, box.max[1] + pad, box.max[2] + pad] as Vec3,
    voxel,
  };
  const answer = engine.measure(program, grid, null, { kind: 'nodes' });
  if (!answer.ok) return answer.message;
  if (answer.kind !== 'nodes') return 'the field engine answered with an unexpected measure';
  const wall = phaseThickness(answer.inside, answer.nodes, voxel);
  const complement = Uint8Array.from(answer.inside, (flag) => (flag === 1 ? 0 : 1));
  const pore = phaseThickness(complement, answer.nodes, voxel, {
    lo: [3, 3, 3],
    hi: [answer.nodes[0] - 3, answer.nodes[1] - 3, answer.nodes[2] - 3],
  });
  const at = (stats: ThicknessStats): Vec3 | null =>
    stats.minNode === null
      ? null
      : [grid.min[0] + stats.minNode[0] * voxel, grid.min[1] + stats.minNode[1] * voxel, grid.min[2] + stats.minNode[2] * voxel];
  return { voxel, wall, pore, wallAt: at(wall), poreAt: at(pore), nodes: answer.nodes[0] * answer.nodes[1] * answer.nodes[2] };
}
