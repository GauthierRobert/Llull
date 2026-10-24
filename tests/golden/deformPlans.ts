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
  deform_ffd_barrel: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [1, 1, 1], anchor: 'min' }, as: 'cube' },
    {
      command: 'deform_lattice',
      params: {
        id: '$cube',
        degrees: [1, 1, 2],
        box: 'bounds',
        moves: [
          { index: [0, 0, 1], delta: [-0.25, -0.25, 0] },
          { index: [1, 0, 1], delta: [0.25, -0.25, 0] },
          { index: [0, 1, 1], delta: [-0.25, 0.25, 0] },
          { index: [1, 1, 1], delta: [0.25, 0.25, 0] },
        ],
        output: { tolerance: 0.01 },
      },
      as: 'barrel',
    },
    { command: 'analyze_deformation', params: { id: '$barrel' } },
  ],
  deform_point_push: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [40, 40, 10], anchor: 'base-center' }, as: 'slab' },
    {
      command: 'deform_by_point',
      params: { id: '$slab', point: [0, 0, 10], direction: [0, 0, 1], distance: 2, radius: 10, output: { tolerance: 0.2 } },
      as: 'bumped',
    },
    { command: 'check_deformation', params: { ids: ['$bumped'] } },
  ],
  deform_curve_to_curve_bar: [
    { command: 'add_box', params: { size: [10, 10, 100], anchor: 'base-center' }, as: 'bar' },
    {
      command: 'interpolate_curve',
      params: {
        points: [
          [5, 0, 0],
          [5, 0, 50],
          [5, 0, 100],
        ],
        degree: 2,
      },
      as: 'rail',
    },
    {
      command: 'interpolate_curve',
      params: {
        points: [
          [5, 0, 0],
          [15, 0, 50],
          [5, 0, 100],
        ],
        degree: 2,
      },
      as: 'goal',
    },
    {
      command: 'deform_curve_to_curve',
      params: {
        id: '$bar',
        pairs: [{ initialId: '$rail', targetId: '$goal' }],
        fixedPoints: [[0, 0, 0]],
        samples: 12,
        output: { tolerance: 0.5 },
      },
      as: 'bulged',
    },
  ],
  deform_morph_planes: [
    {
      command: 'create_nurbs_surface',
      params: {
        degreeU: 1,
        degreeV: 1,
        poles: [
          [
            [0, 0, 0],
            [0, 10, 0],
          ],
          [
            [10, 0, 0],
            [10, 10, 0],
          ],
        ],
      },
      as: 'low',
    },
    {
      command: 'create_nurbs_surface',
      params: {
        degreeU: 1,
        degreeV: 1,
        poles: [
          [
            [0, 0, 10],
            [0, 10, 10],
          ],
          [
            [10, 0, 10],
            [10, 10, 10],
          ],
        ],
      },
      as: 'high',
    },
    { command: 'morph_bodies', params: { fromId: '$low', toId: '$high', t: 0.3 }, as: 'between' },
  ],
};
