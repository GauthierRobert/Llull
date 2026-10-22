// DEF build_project plans. Run: node generate_plans.mjs  -> validation/plans/*.json
// baseline_* plans use only commands that exist today (2026-10-22); target_* plans use the commands proposed in
// TECHNICAL_SPEC §4 (each marked in the plan's first step comment-free: the list is in validation/README.md §3).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'plans');
mkdirSync(dir, { recursive: true });
const save = (name, steps) => writeFileSync(join(dir, name), JSON.stringify(steps, null, 1) + '\n');
const r6 = (v) => Number(v.toFixed(6));
const PI = Math.PI;

// Square 10 x 10 section as 40 points (10 per side) so the 24-point loft resampling keeps the corners near the square.
const square = (side, perSide, angle) => {
  const h = side / 2;
  const corners = [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ];
  const pts = [];
  for (let c = 0; c < 4; c++) {
    const [a, b] = [corners[c], corners[(c + 1) % 4]];
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      pts.push([r6(x * Math.cos(angle) - y * Math.sin(angle)), r6(x * Math.sin(angle) + y * Math.cos(angle))]);
    }
  }
  return pts;
};

// 1. BASELINE (runs today): a 90 deg twisted 10 x 10 x 100 bar approximated by a smooth loft through 11 rotated squares.
save('baseline_twisted_bar_loft.json', [
  { command: 'set_units', params: { units: 'mm' } },
  {
    command: 'loft_sections',
    params: {
      sections: Array.from({ length: 11 }, (_, i) => ({
        center: [0, 0, i * 10],
        rotation: [0, 0, 0],
        section: square(10, 10, (i * PI) / 20),
      })),
      ruled: false,
    },
    as: 'bar',
  },
  { command: 'mass_properties', params: { entityId: '$bar' } },
  { command: 'measure_bounding_box', params: { entityId: '$bar' } },
]);

// 2. BASELINE (runs today): a 10 x 10 bar bent 90 deg on a 50 mm neutral radius, built as a sweep along an arc.
save('baseline_bent_bar_sweep.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'draw_arc', params: { center: [0, 0], radius: 50, startAngle: 0, endAngle: r6(PI / 2) }, as: 'path' },
  { command: 'sweep_profile', params: { pathId: '$path', section: square(10, 10, 0) }, as: 'bent' },
  { command: 'mass_properties', params: { entityId: '$bent' } },
]);

const frameZ = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] };

save('target_twist_box.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [10, 10, 100], position: [0, 0, 0], anchor: 'base-center' }, as: 'bar' },
  {
    command: 'twist_body',
    params: {
      id: '$bar',
      angleDeg: 90,
      frame: frameZ,
      region: { start: 0, end: 100, falloff: 'linear' },
      output: { mode: 'auto', tolerance: 0.001 },
    },
    as: 'twisted',
  },
  { command: 'mass_properties', params: { entityId: '$twisted' } },
  { command: 'analyze_deformation', params: { id: '$twisted' } },
  { command: 'check_deformation', params: { ids: ['$twisted'] } },
]);

save('target_bend_cylinder_torus.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cylinder', params: { radius: 5, height: r6(2 * PI * 50), position: [0, 0, 0], anchor: 'base-center' }, as: 'rod' },
  {
    command: 'bend_body',
    params: {
      id: '$rod',
      radius: 50,
      angleDeg: 360,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] },
      output: { mode: 'exact', tolerance: 0.0001 },
    },
    as: 'ring',
  },
  { command: 'mass_properties', params: { entityId: '$ring' } },
  {
    command: 'analyze_deformation',
    params: { id: '$ring', compareTo: { kind: 'torus', majorRadius: 50, minorRadius: 5, center: [0, 50, 0], axis: [1, 0, 0] } },
  },
  { command: 'check_deformation', params: { ids: ['$ring'] } },
]);

save('target_taper_cylinder_cone.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cylinder', params: { radius: 5, height: 40, position: [0, 0, 0], anchor: 'base-center' }, as: 'pin' },
  {
    command: 'taper_body',
    params: {
      id: '$pin',
      scaleEnd: 0.4,
      frame: frameZ,
      region: { start: 0, end: 40, falloff: 'linear' },
      output: { mode: 'exact', tolerance: 0.0001 },
    },
    as: 'cone',
  },
  { command: 'mass_properties', params: { entityId: '$cone' } },
  { command: 'inspect_topology', params: { id: '$cone' } },
  { command: 'check_deformation', params: { ids: ['$cone'] } },
]);

// Barrel FFD of the unit cube: degrees [1, 1, 2]; the 4 control points of the middle layer (k = 1) move radially by (m - 1)(q - 0.5), m = 1.5.
const m = 1.5;
save('target_ffd_barrel.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' }, as: 'cube' },
  {
    command: 'deform_lattice',
    params: {
      id: '$cube',
      degrees: [1, 1, 2],
      box: 'bounds',
      moves: [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([i, j]) => ({ index: [i, j, 1], delta: [r6((m - 1) * (i - 0.5)), r6((m - 1) * (j - 0.5)), 0] })),
      output: { mode: 'auto', tolerance: 0.0001 },
    },
    as: 'barrel',
  },
  { command: 'mass_properties', params: { entityId: '$barrel' } },
  { command: 'analyze_deformation', params: { id: '$barrel' } },
]);

save('target_flow_plate_on_cylinder.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [60, 20, 2], position: [0, 0, 0], anchor: 'min' }, as: 'plate' },
  { command: 'add_cylinder', params: { radius: 30, height: 40, position: [0, 10, -30], axis: [0, 1, 0] }, as: 'drum' },
  {
    command: 'flow_on_surface',
    params: {
      id: '$plate',
      base: { plane: { origin: [0, 0, 0], normal: [0, 0, 1], uDirection: [1, 0, 0] } },
      target: { entityId: '$drum', faceNear: [0, 10, 0] },
      targetOrigin: [0, 0, 0],
      targetUDirection: [1, 0, 0],
      output: { mode: 'auto', tolerance: 0.001 },
    },
    as: 'wrapped',
  },
  { command: 'mass_properties', params: { entityId: '$wrapped' } },
  { command: 'check_deformation', params: { ids: ['$wrapped'] } },
]);

save('target_point_push.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [100, 100, 50], position: [0, 0, -25] }, as: 'block' },
  {
    command: 'deform_by_point',
    params: {
      id: '$block',
      point: [0, 0, 0],
      direction: [0, 0, 1],
      distance: 2,
      radius: 10,
      falloff: 'smooth_c2',
      output: { mode: 'auto', tolerance: 0.001 },
    },
    as: 'bumped',
  },
  { command: 'mass_properties', params: { entityId: '$bumped' } },
  { command: 'analyze_deformation', params: { id: '$bumped' } },
]);

save('target_scale_nonuniform_sphere.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_sphere', params: { radius: 10, position: [0, 0, 0] }, as: 'ball' },
  { command: 'scale_nonuniform', params: { id: '$ball', factors: [1, 1, 2], center: [0, 0, 0] }, as: 'egg' },
  { command: 'mass_properties', params: { entityId: '$egg' } },
  { command: 'check_deformation', params: { ids: ['$egg'] } },
]);

// Deliberately wrong plan: every step must be refused with its stable code (VC-DEF-27).
save('target_bad_plan_codes.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_box', params: { size: [10, 10, 100], anchor: 'base-center' }, as: 'bar' },
  {
    command: 'bend_body',
    params: { id: '$bar', radius: 4, angleDeg: 90, frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] } },
  },
  {
    command: 'deform_lattice',
    params: {
      id: '$bar',
      degrees: [1, 1, 1],
      box: 'bounds',
      moves: [0, 1].flatMap((j) => [0, 1].map((k) => ({ index: [1, j, k], delta: [-15, 0, 0] }))),
    },
  },
  { command: 'scale_nonuniform', params: { id: '$bar', factors: [1, 0, 1] } },
  { command: 'twist_body', params: { id: 'missing-1.1', angleDeg: 30, frame: frameZ } },
]);

process.stdout.write(`DEF plans written to ${dir}\n`);
