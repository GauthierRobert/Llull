/** Golden plans of 05 IMP (validation/plans/target_*.json at a coarse voxel so the snapshots stay small): replay reproduces them exactly. */

import type { GoldenAction } from './plans';

export const implicitPlans: Record<string, GoldenAction[]> = {
  implicit_smooth_corner: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_field_primitive', params: { shape: 'plane', normal: [1, 0, 0], offset: 0 }, as: 'px' },
    { command: 'add_field_primitive', params: { shape: 'plane', normal: [0, 1, 0], offset: 0 }, as: 'py' },
    { command: 'combine_fields', params: { op: 'union', a: '$px', b: '$py', blend: { kind: 'quadratic', radius: 2 } }, as: 'corner' },
    { command: 'add_field_primitive', params: { shape: 'box', size: [20, 20, 10], position: [6, 6, 5] }, as: 'bounds' },
    { command: 'combine_fields', params: { op: 'intersect', a: '$corner', b: '$bounds' }, as: 'part' },
    { command: 'create_implicit_body', params: { field: '$part', voxel: 2 }, as: 'body' },
    { command: 'implicit_properties', params: { id: '$body' } },
    {
      command: 'evaluate_field',
      params: {
        field: '$part',
        points: [
          [0.5, 0.5, 5],
          [2, 0, 5],
          [0, 2, 5],
        ],
      },
    },
  ],
  implicit_shell_gyroid_block: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [12, 12, 12] }, as: 'box' },
    { command: 'field_from_solid', params: { entityId: '$box' }, as: 'fbox' },
    { command: 'shell_field', params: { field: '$fbox', thickness: 2 }, as: 'skin' },
    { command: 'add_field_primitive', params: { shape: 'box', size: [8, 8, 8] }, as: 'inner' },
    {
      command: 'add_tpms_lattice',
      params: { kind: 'gyroid', form: 'sheet', thickness: 1.6, cellSize: 8, origin: [0, 0, 0], region: '$inner' },
      as: 'infill',
    },
    { command: 'combine_fields', params: { op: 'union', a: '$skin', b: '$infill' }, as: 'part' },
    { command: 'create_implicit_body', params: { field: '$part', voxel: 1.5, hideSource: ['$box'] }, as: 'body' },
    { command: 'lattice_properties', params: { id: '$infill' } },
    { command: 'check_implicit', params: { id: '$body' } },
  ],
  implicit_octet_block: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_field_primitive', params: { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] }, as: 'block' },
    {
      command: 'add_strut_lattice',
      params: { cell: 'octet', cellSize: 10, radius: 0.5, origin: [0, 0, 0], region: '$block' },
      as: 'octet',
    },
    { command: 'lattice_properties', params: { id: '$octet' } },
  ],
};
