import type { DeformFrame, DeformLaw, DeformOutput, DeformRegion } from '@core/model/deform';
import type { DeformNode } from '@core/geometry/deform/laws';
import type { ShapeRecipe } from '@core/model/types';

export const WORLD_FRAME: DeformFrame = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] };
export const MESH_OUTPUT: DeformOutput = { mode: 'mesh', tolerance: 0.01, preserveAnalytic: false };
const NO_SOURCE: ShapeRecipe = { op: 'brep', blob: 'a'.repeat(64), format: 'occt-brep-v1' };

export function region(start: number, end: number, falloff: DeformRegion['falloff'] = 'linear'): DeformRegion {
  return { start, end, falloff, beyond: 'rigid' };
}

export function deformNode(
  law: DeformLaw,
  options: { region?: DeformRegion; frame?: DeformFrame; output?: DeformOutput; source?: ShapeRecipe } = {},
): DeformNode {
  return {
    op: 'deform',
    source: options.source ?? NO_SOURCE,
    law,
    frame: options.frame ?? WORLD_FRAME,
    ...(options.region === undefined ? {} : { region: options.region }),
    output: options.output ?? MESH_OUTPUT,
  };
}

export const IDENTITY_ROWS = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;
