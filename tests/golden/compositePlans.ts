import type { GoldenAction } from './plans';

const WOVEN = {
  name: 'PW_fabric',
  form: 'woven',
  E1: 70000,
  E2: 70000,
  G12: 5000,
  nu12: 0.05,
  Xt: 600,
  Xc: 570,
  Yt: 600,
  Yc: 570,
  S: 90,
  plyThickness: 0.25,
  density: 0.0016,
  lockingAngle: 40,
  warningShear: 30,
  basis: 'b_basis',
  source: 'illustrative fabric values; only geometry and lockingAngle matter for this plan',
};

const T300 = {
  name: 'T300_5208',
  form: 'ud_tape',
  E1: 181000,
  E2: 10300,
  G12: 7170,
  nu12: 0.28,
  Xt: 1500,
  Xc: 1500,
  Yt: 40,
  Yc: 246,
  S: 68,
  plyThickness: 0.125,
  density: 0.0016,
  basis: 'b_basis',
  source: 'Tsai & Hahn 1980 via Kaw Table 2.1 (density illustrative)',
};

const capPolygon = Array.from({ length: 24 }, (_, k): [number, number] => [
  Math.round(100 * 0.4 * Math.cos((2 * Math.PI * k) / 24) * 1e6) / 1e6,
  Math.round(100 * 0.4 * Math.sin((2 * Math.PI * k) / 24) * 1e6) / 1e6,
]);

const dart = (degrees: number): [number, number][] => {
  const a = (degrees * Math.PI) / 180;
  return [
    [0, 0],
    [Math.round(190 * Math.cos(a) * 1e6) / 1e6, Math.round(190 * Math.sin(a) * 1e6) / 1e6],
  ];
};

/** 06 CMP M3 / M4 golden plans: fishnet drape of a hemisphere with darts and shop data, and a sandwich panel with a chamfered core. */
export const compositePlans: Record<string, GoldenAction[]> = {
  composites_hemisphere_drape: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_sphere', params: { radius: 100, position: [0, 0, 0] }, as: 'tool' },
    { command: 'create_lamina_material', params: WOVEN },
    {
      command: 'define_rosette',
      params: { name: 'Rpole', origin: [0, 0, 100], axis0: [1, 0, 0], normal: [0, 0, 1], method: 'translational' },
    },
    {
      command: 'create_composite_part',
      params: { name: 'Dome', toolSurface: { entityId: '$tool', faceNear: [0, 0, 100] }, rosette: 'Rpole' },
      as: 'part',
    },
    {
      command: 'add_ply',
      params: {
        part: '$part',
        name: 'P1',
        material: 'PW_fabric',
        orientation: 0,
        sequence: 'S1',
        boundary: { kind: 'whole_face' },
        drape: { method: 'kinematic', stepLength: 4 },
      },
      as: 'p1',
    },
    { command: 'check_producibility', params: { part: '$part', plies: ['$p1'] } },
    { command: 'split_ply', params: { ply: '$p1', kind: 'dart', path: dart(0) } },
    { command: 'split_ply', params: { ply: '$p1', kind: 'dart', path: dart(90) } },
    { command: 'split_ply', params: { ply: '$p1', kind: 'dart', path: dart(180) } },
    { command: 'split_ply', params: { ply: '$p1', kind: 'dart', path: dart(270) } },
    { command: 'drape_ply', params: { ply: '$p1', part: '$part', stepLength: 4 } },
    {
      command: 'add_ply',
      params: {
        part: '$part',
        name: 'P2',
        material: 'PW_fabric',
        orientation: 45,
        sequence: 'S2',
        boundary: { kind: 'polygon', polygons: [capPolygon] },
        drape: { method: 'kinematic', stepLength: 3 },
      },
      as: 'p2',
    },
    { command: 'check_producibility', params: { part: '$part', plies: ['$p2'] } },
    { command: 'export_flat_patterns_dxf', params: { part: '$part', plies: ['$p2'] } },
    { command: 'export_laser_projection', params: { part: '$part', plies: ['$p2'] } },
    { command: 'laminate_mass', params: { part: '$part' } },
  ],
  composites_sandwich_shop_data: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [600, 400, 10], anchor: 'min', position: [0, 0, -10] }, as: 'tool' },
    { command: 'create_lamina_material', params: T300 },
    {
      command: 'create_lamina_material',
      params: {
        name: 'Honey',
        form: 'core_honeycomb',
        E1: 100,
        E2: 100,
        G12: 50,
        nu12: 0.1,
        plyThickness: 10,
        density: 0.00005,
        basis: 'b_basis',
        source: 'illustrative core data',
      },
    },
    { command: 'define_rosette', params: { name: 'R0', origin: [0, 0, 0], axis0: [1, 0, 0], normal: [0, 0, 1], method: 'translational' } },
    {
      command: 'create_composite_part',
      params: { name: 'Sandwich', toolSurface: { entityId: '$tool', faceNear: [300, 200, 0] }, rosette: 'R0' },
      as: 'part',
    },
    {
      command: 'define_zone',
      params: {
        part: '$part',
        name: 'Z-base',
        boundary: [
          [0, 0],
          [600, 0],
          [600, 400],
          [0, 400],
        ],
        laminate: '[45/-45/0/90]s',
        priority: 0,
      },
    },
    { command: 'generate_plies_from_zones', params: { part: '$part', material: 'T300_5208', sequencePrefix: 'S' } },
    {
      command: 'add_core',
      params: {
        part: '$part',
        boundary: [
          [200, 100],
          [400, 100],
          [400, 300],
          [200, 300],
        ],
        material: 'Honey',
        thickness: 10,
        chamferAngle: 30,
        afterPly: 'S4',
      },
    },
    { command: 'core_sample', params: { part: '$part', point: [300, 200, 0] } },
    { command: 'core_sample', params: { part: '$part', point: [208.66, 200, 0] } },
    { command: 'laminate_mass', params: { part: '$part' } },
    { command: 'mass_properties', params: { entityId: '$part' } },
    { command: 'export_laser_projection', params: { part: '$part', plies: ['S1', 'S8'], spacing: 100 } },
    { command: 'export_ply_book', params: { part: '$part' } },
  ],
};
