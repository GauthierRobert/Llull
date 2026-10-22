// IMP validation — writes the build_project plans of validation/plans/ and data/beam_block_counts.json.
// Only plans/baseline_*.json use commands that exist today; target_*.json use the commands proposed in TECHNICAL_SPEC §4
// (flagged in validation/README.md §5). Run: node make_plans.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const plan = (name, steps) => writeFileSync(path.join(here, 'plans', name), JSON.stringify(steps, null, 1) + '\n');
const step = (command, params, as) => (as === undefined ? { command, params } : { command, params, as });

// 1. BASELINE (runs today): simple-cubic unit cell as 3 cylinders r = 1, length a = 10 through the cell centre, one boolean union.
//    V = 3π r² a − 8√2 r³ = 82.934 (exact B-rep on the native kernel; the mesh kernel tessellates the cylinders).
plan('baseline_sc_unit_cell_cylinders.json', [
  step('set_units', { units: 'mm' }),
  step('add_cylinder', { radius: 1, height: 10, axis: [1, 0, 0] }, 'cx'),
  step('add_cylinder', { radius: 1, height: 10, axis: [0, 1, 0] }, 'cy'),
  step('add_cylinder', { radius: 1, height: 10, axis: [0, 0, 1] }, 'cz'),
  step('boolean', { op: 'union', a: '$cx', b: ['$cy', '$cz'] }, 'cell'),
  step('mass_properties', { entityId: '$cell' }),
]);

// 2. Same cell through the proposed strut-lattice command: relative density 0.0829341 (closed form), ρ1 = 0.0942478.
plan('target_sc_strut_lattice_cell.json', [
  step('set_units', { units: 'mm' }),
  step('add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] }, 'cellBox'),
  step('add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 1, origin: [0, 0, 0], region: '$cellBox' }, 'sc'),
  step('create_implicit_body', { field: '$sc', voxel: 0.1 }, 'body'),
  step('implicit_properties', { id: '$body', region: '$cellBox' }),
  step('lattice_properties', { id: '$sc' }),
  step('check_implicit', { id: '$body' }),
]);

// 3. Cube 40 with a 2 mm skin and a gyroid network infill (level 0, a = 12) clipped to the 36 mm inner cube: V = 40672 (exact).
plan('target_shell_gyroid_infill.json', [
  step('set_units', { units: 'mm' }),
  step('add_box', { size: [40, 40, 40] }, 'box'),
  step('field_from_solid', { entityId: '$box' }, 'fbox'),
  step('shell_field', { field: '$fbox', thickness: 2, side: 'inside' }, 'skin'),
  step('add_field_primitive', { shape: 'box', size: [36, 36, 36] }, 'inner'),
  step('add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0, cellSize: 12, origin: [0, 0, 0], region: '$inner' }, 'infill'),
  step('combine_fields', { op: 'union', a: '$skin', b: '$infill' }, 'part'),
  step('create_implicit_body', { field: '$part', voxel: 0.2, hideSource: ['$box'] }, 'body'),
  step('implicit_properties', { id: '$body' }),
  step('check_implicit', { id: '$body', process: { minWallMm: 0.4, minPoreMm: 1.0, source: 'owner-supplied' } }),
  step('export_3mf', { entityIds: ['$body'], name: 'gyroid_infill_cube' }),
]);

// 4. Same part through the convenience command infill_solid (composes 3 via execute): identical volume 40672.
plan('target_infill_solid_box.json', [
  step('set_units', { units: 'mm' }),
  step('add_box', { size: [40, 40, 40] }, 'box'),
  step(
    'infill_solid',
    {
      entityId: '$box',
      wall: 2,
      lattice: { type: 'tpms', kind: 'gyroid', form: 'network', level: 0, cellSize: 12, origin: [0, 0, 0] },
      voxel: 0.2,
    },
    'body',
  ),
  step('implicit_properties', { id: '$body' }),
  step('check_implicit', { id: '$body' }),
]);

// 5. Graded sheet gyroid column 10 × 10 × 40, wall 0.5 -> 2.5 mm linear in z: relative density 0.40438 (quadrature reference).
plan('target_graded_gyroid_column.json', [
  step('set_units', { units: 'mm' }),
  step('create_scalar_field', { kind: 'coordinate', axis: 'z' }, 'z'),
  step('create_scalar_field', { kind: 'ramp', input: '$z', inMin: 0, inMax: 40, outMin: 0.5, outMax: 2.5, clamp: true }, 'wall'),
  step('add_field_primitive', { shape: 'box', size: [10, 10, 40], position: [5, 5, 20] }, 'column'),
  step(
    'add_tpms_lattice',
    { kind: 'gyroid', form: 'sheet', thickness: '$wall', normalize: 'gradient', cellSize: 10, origin: [0, 0, 0], region: '$column' },
    'graded',
  ),
  step('create_implicit_body', { field: '$graded', voxel: 0.1 }, 'body'),
  step('implicit_properties', { id: '$body', region: '$column' }),
  step('lattice_properties', { id: '$graded' }),
  step('check_implicit', { id: '$body' }),
]);

// 6. Smooth (quadratic, k = 2) union of the half-spaces x < 0 and y < 0, clipped to the box [−4,16]² × [0,10]:
//    V = 20·20·10 − 16·16·10 + 10 · k²/6 = 1446.6667 (exact); the blend meets each face 2 mm from the edge.
plan('target_smooth_union_corner.json', [
  step('set_units', { units: 'mm' }),
  step('add_field_primitive', { shape: 'plane', normal: [1, 0, 0], offset: 0 }, 'px'),
  step('add_field_primitive', { shape: 'plane', normal: [0, 1, 0], offset: 0 }, 'py'),
  step('combine_fields', { op: 'union', a: '$px', b: '$py', blend: { kind: 'quadratic', radius: 2 } }, 'corner'),
  step('add_field_primitive', { shape: 'box', size: [20, 20, 10], position: [6, 6, 5] }, 'bounds'),
  step('combine_fields', { op: 'intersect', a: '$corner', b: '$bounds' }, 'part'),
  step('create_implicit_body', { field: '$part', voxel: 0.05 }, 'body'),
  step('implicit_properties', { id: '$body' }),
  step('evaluate_field', {
    field: '$part',
    points: [
      [0.5, 0.5, 5],
      [2, 0, 5],
      [0, 2, 5],
    ],
  }),
]);

// 7. Octet beam lattice, 2 × 2 × 2 cells of 10 mm, strut radius 0.5 (x = 0.05), exported as a 3MF beam lattice.
plan('target_octet_beam_lattice_3mf.json', [
  step('set_units', { units: 'mm' }),
  step('add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] }, 'block'),
  step('add_strut_lattice', { cell: 'octet', cellSize: 10, radius: 0.5, origin: [0, 0, 0], region: '$block' }, 'octet'),
  step('lattice_properties', { id: '$octet' }),
  step('create_implicit_body', { field: '$octet', voxel: 0.05 }, 'body'),
  step('implicit_properties', { id: '$body', region: '$block' }),
  step('export_3mf', { entityIds: ['$body'], beamLattice: true, name: 'octet_block' }),
]);

// 8. Conformal gyroid sleeve: cylindrical cell map, 8 cells around (seamless); a second call with 6.5 cells is refused (IMP_MAP_SEAM).
plan('target_cylindrical_gyroid_sleeve.json', [
  step('set_units', { units: 'mm' }),
  step('add_field_primitive', { shape: 'cylinder', radius: 30, height: 40, position: [0, 0, 20] }, 'outer'),
  step('add_field_primitive', { shape: 'cylinder', radius: 20, height: 42, position: [0, 0, 20] }, 'bore'),
  step('combine_fields', { op: 'subtract', a: '$outer', b: '$bore' }, 'sleeve'),
  step(
    'add_tpms_lattice',
    {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 1,
      cellSize: [10, 10, 10],
      map: { kind: 'cylindrical', origin: [0, 0, 0], axis: [0, 0, 1], cellsAround: 16, radialCellSize: 10 },
      region: '$sleeve',
    },
    'lat',
  ),
  step('create_implicit_body', { field: '$lat', voxel: 0.2 }, 'body'),
  step('check_implicit', { id: '$body' }),
  step('implicit_properties', { id: '$body', region: '$sleeve' }),
]);

// 9. Deliberately wrong plan: every step must be refused with the documented code (VC-IMP-40).
plan('target_errors.json', [
  step('add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 6, cellSize: 10 }),
  step('add_strut_lattice', { cell: 'bcc', cellSize: 10, radius: 5.5 }),
  step('add_tpms_lattice', {
    kind: 'gyroid',
    form: 'sheet',
    thickness: 1,
    cellSize: 10,
    map: { kind: 'cylindrical', origin: [0, 0, 0], axis: [0, 0, 1], cellsAround: 6.5, radialCellSize: 10 },
  }),
  step('add_field_primitive', { shape: 'sphere', radius: 1000 }, 'big'),
  step('create_implicit_body', { field: '$big', voxel: 0.001 }),
  step('combine_fields', { op: 'union', a: 'no-such-field', b: '$big' }),
]);

// Beam / node counts of an n × n × n octet block (3MF: one beam per nearest-neighbour bond, face diagonals split at the face centre).
function octetBlock(n) {
  const nodes = [];
  for (let i = 0; i <= 2 * n; i += 1)
    for (let j = 0; j <= 2 * n; j += 1) for (let k = 0; k <= 2 * n; k += 1) if ((i + j + k) % 2 === 0) nodes.push([i, j, k]); // FCC in half-cell units
  const key = (p) => p.join(',');
  const set = new Set(nodes.map(key));
  let beams = 0;
  const dirs = [];
  for (const a of [-1, 0, 1])
    for (const b of [-1, 0, 1]) for (const c of [-1, 0, 1]) if (Math.abs(a) + Math.abs(b) + Math.abs(c) === 2) dirs.push([a, b, c]);
  for (const p of nodes)
    for (const d of dirs) {
      const q = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
      if (set.has(key(q)) && key(p) < key(q)) beams += 1;
    }
  return { n, nodes: nodes.length, beams, directionsPerNode: dirs.length };
}
writeFileSync(
  path.join(here, 'data', 'beam_block_counts.json'),
  JSON.stringify({ generated: 'make_plans.mjs', octet: [1, 2, 3].map(octetBlock) }, null, 1) + '\n',
);
process.stdout.write('plans written\n');
