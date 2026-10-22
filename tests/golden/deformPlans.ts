/** Golden plans of 01 DEF (validation/plans/target_*.json at a coarse mesh tolerance so the snapshots stay small): replay reproduces them exactly. */

import type { GoldenAction } from './plans';

const WORLD = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] };

export const deformPlans: Record<string, GoldenAction[]> = {
  deform_twist_box: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [10, 10, 100], anchor: 'base-center' }, as: 'bar' },
    {
      command: 'twist_body',
      params: {
        id: '$bar',
        angleDeg: 90,
        frame: WORLD,
        region: { start: 0, end: 100, falloff: 'linear' },
        output: { mode: 'auto', tolerance: 1 },
      },
      as: 'twisted',
    },
    { command: 'analyze_deformation', params: { id: '$twisted' } },
    { command: 'check_deformation', params: { ids: ['$twisted'] } },
  ],
  deform_bend_bar: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [10, 10, 78.5398163397], anchor: 'base-center' }, as: 'bar' },
    {
      command: 'bend_body',
      params: { id: '$bar', radius: 50, angleDeg: 90, frame: { ...WORLD, reference: [0, 1, 0] }, output: { tolerance: 1 } },
      as: 'arc',
    },
    { command: 'analyze_deformation', params: { id: '$arc' } },
  ],
  deform_taper_cylinder_cone: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_cylinder', params: { radius: 5, height: 40, anchor: 'base-center' }, as: 'rod' },
    {
      command: 'taper_body',
      params: { id: '$rod', scaleEnd: 0.4, frame: WORLD, region: { start: 0, end: 40, falloff: 'linear' }, output: { tolerance: 0.5 } },
      as: 'cone',
    },
    { command: 'check_deformation', params: { ids: ['$cone'] } },
  ],
  deform_scale_nonuniform_sphere: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_sphere', params: { radius: 10, position: [0, 0, 0] }, as: 'ball' },
    { command: 'scale_nonuniform', params: { id: '$ball', factors: [1, 1, 2], center: [0, 0, 0] }, as: 'egg' },
    { command: 'analyze_deformation', params: { id: '$egg' } },
  ],
  deform_stretch_then_twist: [
    { command: 'add_box', params: { size: [10, 10, 100], anchor: 'base-center' }, as: 'bar' },
    { command: 'stretch_body', params: { id: '$bar', factor: 1.5, frame: WORLD, region: { start: 20, end: 60 } }, as: 'long' },
    { command: 'twist_body', params: { id: '$long', angleDeg: 45, frame: WORLD, output: { tolerance: 1 } } },
  ],
};
