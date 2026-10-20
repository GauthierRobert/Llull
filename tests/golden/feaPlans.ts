import type { GoldenAction } from './plans';

/** Steel bar 300 x 10 x 10 mm with elastic model, material assigned: `$bar`. */
const STEEL_BAR: GoldenAction[] = [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [300, 10, 10], position: [0, 0, 0], anchor: 'min' }, as: 'bar' },
  { command: 'create_material', params: { name: 'steel', density: 0.0078 } },
  {
    command: 'add_material_model',
    params: {
      material: 'steel',
      id: 'elastic',
      model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
      basis: 'company',
      source: { citation: 'golden test input' },
    },
  },
  { command: 'define_constitutive_set', params: { material: 'steel', set: { id: 'set', elastic: 'elastic' }, makeDefault: true } },
  { command: 'assign_material', params: { materialName: 'steel', entityIds: ['$bar'] } },
];

const ROOT_FIXED: GoldenAction = {
  command: 'add_fea_constraint',
  params: { analysisId: '$an', name: 'root', kind: 'fixed', target: { entityId: '$bar', facesNear: [[0, 5, 5]] } },
};

/** FEA-REST part 2 features as recorded behaviour (05 §13): buckling preload, moment reference point, result view, margin band. */
export const feaPlans: Record<string, GoldenAction[]> = {
  fea_buckling_preload_view: [
    ...STEEL_BAR,
    { command: 'create_analysis', params: { name: 'column', analysisType: 'buckling', modes: 2 }, as: 'an' },
    { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$bar' } },
    ROOT_FIXED,
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$an',
        name: 'dead',
        kind: 'force',
        loadCase: 'LC1',
        vector: [0, 0, -200],
        target: { entityId: '$bar', facesNear: [[300, 5, 5]] },
      },
    },
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$an',
        name: 'axial',
        kind: 'force',
        loadCase: 'LC2',
        vector: [-1000, 0, 0],
        target: { entityId: '$bar', facesNear: [[300, 5, 5]] },
      },
    },
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$an',
        name: 'tip torque',
        kind: 'moment',
        loadCase: 'LC2',
        vector: [0, 0, 500],
        referencePoint: [300, 5, 5],
        target: { entityId: '$bar', facesNear: [[300, 5, 5]] },
      },
    },
    { command: 'set_buckling_preload', params: { analysisId: '$an', preloadLoadCase: 'LC1' } },
    { command: 'set_result_view', params: { analysisId: '$an', field: 'mode', mode: 2, deformationScale: 5 } },
    { command: 'set_mesh_controls', params: { analysisId: '$an', elementFamily: 'tet', order: 2, globalSize: 4 } },
  ],
  fea_static_margin_band_view: [
    ...STEEL_BAR,
    { command: 'create_analysis', params: { name: 'pull', analysisType: 'static' }, as: 'an' },
    { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$bar' } },
    ROOT_FIXED,
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$an',
        name: 'tip',
        kind: 'force',
        vector: [0, -500, 0],
        target: { entityId: '$bar', facesNear: [[300, 5, 5]] },
      },
    },
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$an',
        name: 'tip torque',
        kind: 'moment',
        vector: [0, 0, 500],
        referencePoint: [300, 5, 5],
        target: { entityId: '$bar', facesNear: [[300, 5, 5]] },
      },
    },
    { command: 'set_margin_band', params: { analysisId: '$an', marginalBand: 0.1 } },
    { command: 'set_result_view', params: { analysisId: '$an', field: 'von_mises', loadCase: 'LC1' } },
    { command: 'set_mesh_controls', params: { analysisId: '$an', elementFamily: 'tet', order: 2, globalSize: 5 } },
  ],
};
