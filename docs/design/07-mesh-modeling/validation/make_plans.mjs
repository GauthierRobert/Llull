// 07 MSH build_project plans. Run: node make_plans.mjs  -> plans/*.json
// Only plans/baseline_*.json use commands that exist today; target_* plans name proposed commands (listed in `unbuilt`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icosphere } from './lib_mesh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const save = (name, plan) => {
  fs.writeFileSync(path.join(here, 'plans', name), JSON.stringify(plan, null, 1) + '\n');
  process.stdout.write(`wrote plans/${name}\n`);
};
const soup = (m) => m.faces.flatMap((f) => f.flatMap((v) => m.positions[v].map((x) => Number(x.toPrecision(12)))));

const ico2 = icosphere(10, 2);
const defect = JSON.parse(fs.readFileSync(path.join(here, 'data', 'defect_mesh.json'), 'utf8'));

save('baseline_mesh_today.json', {
  id: 'MSH-BASELINE',
  status:
    'RUNNABLE TODAY: every command exists (import_mesh, mass_properties, split_body, export_stl, export_3mf, add_subdivision_solid, check_model); split_body needs a kernel (Manifold or native OCC)',
  validates: ['VC-MSH-01', 'VC-MSH-17', 'VC-MSH-30'],
  description:
    'What llull can do with a mesh today: land an icosphere (R 10, level 2, 320 triangles) as a mesh entity, measure it, cut it with a plane, check the halves add up, export it for printing, and build a smooth quad-cage solid. No repair, decimation, remeshing, smoothing, hull, Minkowski, offset, sculpt or mesh-to-B-rep fitting exists.',
  expect: {
    stepIndexBase: 0,
    'step 2 data.volume': {
      value: 4047.04467998,
      tolerance: 1e-9,
      relative: true,
      source: 'data/icosphere_convergence.json level 2 (method mesh)',
    },
    'step 2 data.area': { value: 1232.98485952, tolerance: 1e-9, relative: true },
    'step 4 data.volume + step 5 data.volume': {
      value: 4047.04467998,
      tolerance: 1e-6,
      relative: true,
      note: 'halves of a plane split sum to the whole',
    },
    'step 7 data.objects[0].manifold': true,
    'step 8 data.triangleCount': 320,
  },
  actions: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'import_mesh', params: { bodies: [{ positions: soup(ico2), name: 'icosphere_r10_l2' }] }, as: 'ico' },
    { command: 'mass_properties', params: { entityId: '$ico' } },
    { command: 'split_body', params: { id: '$ico', plane: { origin: [0, 0, 0], normal: [0, 0, 1] } }, as: 'halves' },
    { command: 'mass_properties', params: { entityId: '$halves[0]' } },
    { command: 'mass_properties', params: { entityId: '$halves[1]' } },
    { command: 'import_mesh', params: { bodies: [{ positions: soup(ico2), name: 'icosphere_again' }] }, as: 'ico2' },
    { command: 'export_3mf', params: { entityIds: ['$ico2'], name: 'icosphere' } },
    { command: 'export_stl', params: { entityIds: ['$ico2'], format: 'binary' } },
    { command: 'add_subdivision_solid', params: { box: { size: [20, 20, 20] }, levels: 3 }, as: 'subd' },
    { command: 'mass_properties', params: { entityId: '$subd' } },
    { command: 'check_model', params: {} },
  ],
  notes: ['Without a kernel split_body refuses with CMD_KERNEL_UNAVAILABLE: run with --kernel manifold or the native kernel.'],
});

save('target_scan_cleanup_to_print.json', {
  id: 'MSH-SCAN-PRINT',
  status: 'RUNNABLE: every command is built (07 MSH M0, M1, M2)',
  unbuilt: [],
  validates: ['VC-MSH-03', 'VC-MSH-04', 'VC-MSH-05', 'VC-MSH-07', 'VC-MSH-09', 'VC-MSH-10', 'VC-MSH-16', 'VC-MSH-17', 'VC-MSH-28'],
  description: 'Scanned or downloaded STL -> watertight, smooth, lighter, hollow, flat-bottomed print part, checked and exported as 3MF.',
  prerequisites: [
    'the CLI reads the file and passes base64: llull import_mesh_file file=validation/data/icosphere_r10_l1_binary.stl units=mm',
  ],
  actions: [
    { command: 'set_units', params: { units: 'mm' } },
    {
      command: 'import_mesh_file',
      params: { format: 'stl', file: 'validation/data/icosphere_r10_l1_binary.stl', units: 'mm', name: 'scan' },
      as: 'scan',
    },
    { command: 'analyze_mesh', params: { id: '$scan' } },
    { command: 'repair_mesh', params: { id: '$scan', mode: 'stitch', removeSmallComponents: { maxFaces: 10 } } },
    { command: 'fill_mesh_holes', params: { id: '$scan', holes: 'all', maxBoundaryEdges: 500, fairing: 'curvature' } },
    { command: 'smooth_mesh', params: { id: '$scan', method: 'taubin', lambda: 0.6307, passBand: 0.1, iterations: 10 } },
    { command: 'remesh_mesh', params: { id: '$scan', targetEdgeLength: 1, iterations: 5, preserveFeatureAngleDeg: 40 } },
    { command: 'decimate_mesh', params: { id: '$scan', maxDeviation: 0.05, preserveBoundary: true } },
    { command: 'cut_mesh', params: { id: '$scan', plane: { origin: [0, 0, -8], normal: [0, 0, 1] }, keep: 'positive', cap: true } },
    {
      command: 'hollow_mesh',
      params: { id: '$scan', wallThickness: 1.2, tolerance: 0.4, maxCells: 150000, drainHoles: [{ near: [0, 0, -8], diameter: 3 }] },
    },
    { command: 'check_mesh', params: { ids: ['$scan'], purpose: 'print', minWallThickness: 0.8 } },
    { command: 'export_3mf', params: { entityIds: ['$scan'], name: 'print' } },
  ],
});

save('target_hull_minkowski_offset.json', {
  id: 'MSH-HULL-MINK',
  status: 'DRAFT: needs the proposed commands in `unbuilt`',
  unbuilt: [],
  notes: [
    'the ball and the sphere are imported fine icospheres (binary STL, generate_mesh_algorithms.mjs section 6): the display tessellation of add_sphere has 4 % less volume than the sphere, far outside the VC-MSH-15 bound',
    'maxCells 100000 coarsens the level-set grid (edge about 0.5): the result reports data.toleranceMet false and data.errorBound = area x edge; the measured deviation is still inside area x 0.01',
  ],
  validates: ['VC-MSH-11', 'VC-MSH-12', 'VC-MSH-13', 'VC-MSH-14', 'VC-MSH-15'],
  description: 'Closed-form cases: hull of points, cube (+) ball, cube (+) cube, cube (-) cube, offsets of a sphere and a cube.',
  expect: {
    'convex_hull data.volume': { value: 1000, tolerance: 1e-9, relative: true, source: 'data/convex_hull_cases.json cube_plus_interior' },
    'minkowski cube+icosphere(l2) volume': {
      value: 2601.81399162,
      tolerance: 1e-9,
      relative: true,
      source: 'data/minkowski_cases.json polyhedral level 2',
    },
    'minkowski cube+cube volume': { value: 2197, tolerance: 1e-9, relative: true },
    'minkowski difference cube-cube volume': { value: 343, tolerance: 1e-9, relative: true },
    'offset sphere +1 volume': {
      value: 5575.27976257,
      tolerance: 0.00272727,
      relative: true,
      source: 'data/offset_shell_cases.json (eps 0.01 bound)',
    },
  },
  actions: [
    { command: 'set_units', params: { units: 'mm' } },
    {
      command: 'convex_hull',
      params: {
        points: [
          [0, 0, 0],
          [10, 0, 0],
          [0, 10, 0],
          [10, 10, 0],
          [0, 0, 10],
          [10, 0, 10],
          [0, 10, 10],
          [10, 10, 10],
          [5, 5, 5],
          [2, 7, 3],
        ],
      },
      as: 'hull',
    },
    { command: 'mass_properties', params: { entityId: '$hull' } },
    { command: 'add_box', params: { size: [10, 10, 10], anchor: 'min' }, as: 'cube' },
    { command: 'import_mesh_file', params: { format: 'stl', file: 'validation/data/icosphere_r2_l2_binary.stl', units: 'mm' }, as: 'ball' },
    { command: 'minkowski_sum', params: { a: '$cube', b: '$ball', op: 'sum', keepSources: true }, as: 'rounded' },
    { command: 'mass_properties', params: { entityId: '$rounded' } },
    { command: 'add_box', params: { size: [3, 3, 3], anchor: 'center' }, as: 'small' },
    { command: 'minkowski_sum', params: { a: '$cube', b: '$small', op: 'sum', keepSources: true }, as: 'grown' },
    { command: 'minkowski_sum', params: { a: '$cube', b: '$small', op: 'difference', keepSources: true }, as: 'eroded' },
    {
      command: 'import_mesh_file',
      params: { format: 'stl', file: 'validation/data/icosphere_r10_l5_binary.stl', units: 'mm' },
      as: 'sphere',
    },
    {
      command: 'offset_mesh',
      params: { id: '$sphere', distance: 1, method: 'level_set', tolerance: 0.01, maxCells: 100000 },
      as: 'grownSphere',
    },
    { command: 'mass_properties', params: { entityId: '$grownSphere' } },
  ],
});

save('target_defect_repair.json', {
  id: 'MSH-REPAIR',
  status: 'RUNNABLE: every command is built (07 MSH M0, M1)',
  unbuilt: [],
  validates: ['VC-MSH-02', 'VC-MSH-04'],
  description:
    'The defect mesh of data/defect_mesh.json (2 duplicate faces, 3 flipped, 1 degenerate, a 3-edge hole, a tiny extra shell) is diagnosed with exact counts and repaired back to the 320-face closed icosphere.',
  expect: {
    stepIndexBase: 0,
    'step 2 data': defect.truth,
    'step 6 data.closed': true,
    'step 6 data.faces': 320,
    'step 6 data.volume': { value: defect.truth.afterRepair.volume, tolerance: 1e-9, relative: true },
  },
  actions: [
    { command: 'set_units', params: { units: 'mm' } },
    {
      command: 'import_mesh',
      params: { bodies: [{ positions: defect.positions.flat(), indices: defect.faces.flat(), name: 'defects' }] },
      as: 'm',
    },
    { command: 'analyze_mesh', params: { id: '$m', weldTolerance: 1e-6 } },
    { command: 'repair_mesh', params: { id: '$m', mode: 'stitch', weldTolerance: 1e-6, removeSmallComponents: { maxFaces: 10 } } },
    { command: 'fill_mesh_holes', params: { id: '$m', holes: 'all', fairing: 'none' } },
    { command: 'repair_mesh', params: { id: '$m', mode: 'orient' } },
    { command: 'analyze_mesh', params: { id: '$m' } },
  ],
});

save('target_sculpt_quad_brep.json', {
  id: 'MSH-SCULPT-BREP',
  status:
    'PARTIAL: steps 0-4 (add_grid_mesh, sculpt_mesh, import, remesh) run; steps 5-7 need quad_remesh and fit_subdivision_to_mesh (M6, not built)',
  unbuilt: ['quad_remesh', 'fit_subdivision_to_mesh'],
  validates: ['VC-MSH-19', 'VC-MSH-21', 'VC-MSH-22'],
  description:
    'Sculpt a symmetric bump on a flat patch (closed-form displaced volume), then quad-remesh an organic mesh, fit a subdivision cage to it and hand it to the exact kernel as B-spline faces.',
  expect: {
    stepIndexBase: 0,
    'step 2 data.displacedVolume': {
      value: 8.37768936157,
      tolerance: 1e-9,
      relative: true,
      source: 'data/sculpt_cases.json smooth (discrete grid)',
    },
    'step 2 data.symmetryError': { value: 0, tolerance: 1e-12 },
    'step 6 data.maxDeviation': 'TBD - measure with fit_subdivision_to_mesh on the icosphere l4 (target <= 0.05 mm)',
  },
  actions: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_grid_mesh', params: { size: [20, 20], cells: [80, 80], position: [0, 0, 0] }, as: 'patch' },
    {
      command: 'sculpt_mesh',
      params: {
        id: '$patch',
        brush: 'draw',
        stamps: [{ center: [0, 0, 0] }],
        radius: 4,
        strength: 0.5,
        falloff: 'smooth',
        direction: 'normal',
        symmetry: { plane: 'yz' },
      },
    },
    {
      command: 'import_mesh_file',
      params: { format: 'stl', file: 'validation/data/icosphere_r10_l1_ascii.stl', units: 'mm' },
      as: 'organic',
    },
    { command: 'remesh_mesh', params: { id: '$organic', targetEdgeLength: 1.5, iterations: 5 } },
    { command: 'quad_remesh', params: { id: '$organic', targetQuadCount: 600, adaptiveSize: 0, detectHardEdgesDeg: 30 }, as: 'quads' },
    {
      command: 'fit_subdivision_to_mesh',
      params: { cageId: '$quads', targetId: '$organic', levels: 3, maxDeviation: 0.05, iterations: 10 },
      as: 'subd',
    },
    { command: 'mass_properties', params: { entityId: '$subd' } },
  ],
});

save('target_bad_plan_codes.json', {
  id: 'MSH-CODES',
  status: 'RUNNABLE: each step refuses with the named code (exit 1 on the CLI for a single call); run with --continue',
  unbuilt: [],
  validates: ['VC-MSH-26'],
  expect: {
    stepIndexBase: 0,
    'step 0': 'MESH_ENTITY_NOT_FOUND',
    'step 2': 'MESH_TARGET_UNREACHABLE',
    'step 3': 'MESH_ENTITY_NOT_FOUND (an unknown id; with a real open sheet: MESH_NOT_CLOSED)',
    'step 4': 'CMD_INVALID_PARAMS (paths targetEdgeLength; zod .positive())',
    'step 5': 'MESH_IMPORT_UNITS_REQUIRED',
    runMode:
      'run each step as its own CLI call, or the plan with --continue-on-error if available; build_project aborts at the first failure (AF-14)',
  },
  actions: [
    { command: 'decimate_mesh', params: { id: 'nope', targetTriangles: 10 } },
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'b' },
    { command: 'decimate_mesh', params: { id: '$b', targetTriangles: 2, maxDeviation: 1e-9, requireTarget: true } },
    { command: 'minkowski_sum', params: { a: '$b', b: 'open-sheet-id', op: 'sum' } },
    { command: 'remesh_mesh', params: { id: '$b', targetEdgeLength: -1 } },
    { command: 'import_mesh_file', params: { format: 'stl', file: 'validation/data/icosphere_r10_l1_ascii.stl' } },
  ],
});
