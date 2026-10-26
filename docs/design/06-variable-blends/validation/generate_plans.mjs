// BLD plans + expected results (Node ESM, no dependencies): node generate_blend_refs.mjs && node generate_plans.mjs
// Plans: validation/plans/*.json (build_project `{ actions }`). `baseline_*` use ONLY commands and params that exist today;
// `target_*` use the commands / params proposed in TECHNICAL_SPEC §4 (listed in `unbuilt`). expected_results.json indexes every VC.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = (name) => JSON.parse(readFileSync(join(here, 'data', name), 'utf8'));
const plansDir = join(here, 'plans');
mkdirSync(plansDir, { recursive: true });
const planIndex = [];
/** Writes a plain `{ actions }` plan (what `llull run` reads); description, unbuilt names and expected codes go to the index. */
const plan = (name, description, unbuilt, actions) => {
  const expectedCodesInOrder = actions.filter((action) => action.expect !== undefined).map((action) => action.expect);
  const clean = actions.map((action) => Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'expect')));
  planIndex.push({
    file: `plans/${name}.json`,
    description,
    unbuilt,
    ...(expectedCodesInOrder.length > 0 ? { expectedCodesInOrder } : {}),
  });
  writeFileSync(join(plansDir, `${name}.json`), `${JSON.stringify({ actions: clean }, null, 1)}\n`);
};

const straight = data('straight_edge_fillets.json');
const laws = data('variable_radius_laws.json');
const rim = data('periodic_rim_law.json');
const conic = data('conic_sections.json');
const g2 = data('g2_sections.json');
const corners = data('corner_blends.json');
const faces = data('face_fillets.json');
const chamfers = data('chamfers.json');
const extra = data('extra_cases.json');

const TOP_EDGE = [0, 5, 2.5]; // block 20 x 10 x 5 centred at the origin: top long edge (y = +5, z = +2.5), along x, length 20
const TOP_FACE = [0, 0, 2.5];
const SIDE_FACE = [0, 5, 0];
const block = (as = 'b') => ({ command: 'add_box', params: { size: [20, 10, 5] }, as });
const mass = (id) => ({ command: 'mass_properties', params: { entityId: id } });
const facesOf = (id) => ({ command: 'inspect_faces', params: { entityId: id } });

// ---------- baselines: existing commands only ----------
plan(
  'baseline_variable_radius_laws',
  "Runs on today's llull with the native kernel: constant, linear (radiusEnd), control-point (edges[].sizes) and chord fillets, each followed by the queries the VCs read.",
  [],
  [
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'c10' },
    { command: 'fillet_edge', params: { id: '$c10', edgesNear: [[5, 5, 0]], radius: 1 }, as: 'f01' },
    mass('$f01'),
    block('b2'),
    { command: 'fillet_edge', params: { id: '$b2', edgesNear: [TOP_EDGE], radius: 1, radiusEnd: 2 }, as: 'f02' },
    mass('$f02'),
    facesOf('$f02'),
    block('b3'),
    {
      command: 'fillet_edge',
      params: { id: '$b3', edges: [{ near: TOP_EDGE, size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }] }] },
      as: 'f03',
    },
    mass('$f03'),
    facesOf('$f03'),
    {
      command: 'extrude_profile',
      params: {
        profile: [
          [0, 0],
          [10, 0],
          [5, 8.660254037844386],
        ],
        depth: 10,
      },
      as: 'tri',
    },
    { command: 'fillet_edge', params: { id: '$tri', edgesNear: [[0, 0, 5]], radius: 2, mode: 'chord' }, as: 'f05' },
    mass('$f05'),
    block('b30'),
    { command: 'fillet_edge', params: { id: '$b30', edgesNear: [TOP_EDGE], radius: 1, radiusEnd: 3 }, as: 'f30' },
    mass('$f30'),
    facesOf('$f30'),
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'c11' },
    { command: 'fillet_edge', params: { id: '$c11', radius: 1 }, as: 'f11' },
    mass('$f11'),
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'c18' },
    { command: 'chamfer_edge', params: { id: '$c18', edgesNear: [[5, 5, 0]], distance: 1 }, as: 'k18' },
    mass('$k18'),
  ],
);
plan(
  'baseline_limits_today',
  "Runs on today's llull and records how it handles blend limits (measured 2026-10-22: steps 2, 4 and 8 are refused with generic summaries; the 4-edge pyramid apex, step 6, succeeds). Run steps one by one (build_project aborts at the first failure): llull run --continue.",
  [],
  [
    { command: 'add_box', params: { size: [20, 10, 5] }, as: 'b20' },
    { command: 'fillet_edge', params: { id: '$b20', edgesNear: [TOP_EDGE], radius: 6 } },
    {
      command: 'extrude_profile',
      params: {
        profile: [
          [-2, 0],
          [2, 0],
          [2, 10],
          [-2, 10],
        ],
        depth: 20,
      },
      as: 'rib',
    },
    {
      command: 'fillet_edge',
      params: {
        id: '$rib',
        edgesNear: [
          [-2, 10, 10],
          [2, 10, 10],
        ],
        radius: 2,
      },
    },
    { command: 'add_pyramid', params: { baseWidth: 10, baseDepth: 10, height: 10 }, as: 'pyr' },
    {
      command: 'fillet_edge',
      params: {
        id: '$pyr',
        edgesNear: [
          [2.5, 2.5, 5],
          [-2.5, 2.5, 5],
          [-2.5, -2.5, 5],
          [2.5, -2.5, 5],
        ],
        radius: 0.5,
      },
    },
    { command: 'add_cylinder', params: { radius: 5, height: 10 }, as: 'cyl' },
    { command: 'fillet_edge', params: { id: '$cyl', edgesNear: [[5, 0, 5]], radius: 1, mode: 'chord' } },
  ],
);

// ---------- targets: proposed commands / params ----------
plan(
  'target_laws_and_profiles',
  'Radius laws (linear interpolation, periodic expression), conic and curvature-continuous profiles, asymmetric legs; closes with check_blends.',
  [],
  [
    block('b3'),
    {
      command: 'fillet_edge',
      params: { id: '$b3', edges: [{ near: TOP_EDGE, size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }] },
      as: 'f03',
    },
    { command: 'check_blends', params: { ids: ['$f03'] } },
    facesOf('$f03'),
    { command: 'add_cylinder', params: { radius: 5, height: 10 }, as: 'cyl' },
    {
      command: 'fillet_edge',
      params: { id: '$cyl', edges: [{ near: [5, 0, 5], law: { expression: '1 + 0.5*cos(2*pi*t)', samples: 33 } }] },
      as: 'f04',
    },
    mass('$f04'),
    { command: 'add_cylinder', params: { radius: 5, height: 10 }, as: 'cyl6' },
    { command: 'fillet_edge', params: { id: '$cyl6', edgesNear: [[5, 0, 5]], radius: Math.SQRT2, mode: 'chord' }, as: 'f06' },
    mass('$f06'),
    ...[0.25, Math.SQRT2 - 1, 0.5, 0.75].flatMap((rho, i) => [
      block(`bc${i}`),
      {
        command: 'fillet_edge',
        params: { id: `$bc${i}`, edgesNear: [TOP_EDGE], radius: 1, profile: { type: 'conic', rho } },
        as: `f07_${i}`,
      },
      mass(`$f07_${i}`),
    ]),
    block('ba'),
    {
      command: 'fillet_edge',
      params: {
        id: '$ba',
        edges: [{ near: TOP_EDGE, size: 1, size2: 2, side1Near: TOP_FACE }],
        profile: { type: 'conic', rho: Math.SQRT2 - 1 },
      },
      as: 'f08',
    },
    mass('$f08'),
    block('bg'),
    {
      command: 'fillet_edge',
      params: { id: '$bg', edgesNear: [TOP_EDGE], radius: 1, profile: { type: 'curvature', shape: 0.5 } },
      as: 'f09',
    },
    mass('$f09'),
    { command: 'check_blends', params: { ids: ['$f09'], require: 'G2' } },
    block('bk'),
    { command: 'fillet_edge', params: { id: '$bk', edgesNear: [TOP_EDGE], radius: 1 }, as: 'f10' },
    { command: 'check_blends', params: { ids: ['$f10'], require: 'G1' } },
  ],
);
plan(
  'target_corners_faces_chamfers',
  'Setback corners, a 4-edge apex, face-face fillet across a chamfer, hold line, full round, chamfer variants, probe; closes with check_blends.',
  ['fillet_edge.corners'],
  [
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'c12' },
    { command: 'fillet_edge', params: { id: '$c12', radius: 1, corners: [{ all: true, type: 'setback', setback: 2 }] }, as: 'f12' },
    mass('$f12'),
    { command: 'check_blends', params: { ids: ['$f12'] } },
    { command: 'add_pyramid', params: { baseWidth: 10, baseDepth: 10, height: 10 }, as: 'pyr' },
    {
      command: 'fillet_edge',
      params: {
        id: '$pyr',
        edgesNear: [
          [2.5, 2.5, 5],
          [-2.5, 2.5, 5],
          [-2.5, -2.5, 5],
          [2.5, -2.5, 5],
        ],
        radius: 0.5,
        corners: [{ near: [0, 0, 10], type: 'setback', setback: 1.5 }],
      },
      as: 'f13',
    },
    { command: 'check_blends', params: { ids: ['$f13'] } },
    {
      command: 'extrude_profile',
      params: {
        profile: [
          [-5, -5],
          [5, -5],
          [5, 4],
          [4, 5],
          [-5, 5],
        ],
        depth: 10,
      },
      as: 'sq',
    },
    { command: 'fillet_faces', params: { id: '$sq', facesA: { near: [[5, 0, 5]] }, facesB: { near: [[0, 5, 5]] }, radius: 2 }, as: 'f14' },
    mass('$f14'),
    facesOf('$f14'),
    block('bh'),
    {
      command: 'draw_polyline',
      params: {
        points: [
          [-10, 4],
          [10, 3],
        ],
        position: [0, 0, 2.5],
      },
      as: 'hold',
    },
    {
      command: 'fillet_faces',
      params: { id: '$bh', facesA: { near: [TOP_FACE] }, facesB: { near: [SIDE_FACE] }, holdLine: { id: '$hold', onFaces: 'A' } },
      as: 'f17',
    },
    facesOf('$f17'),
    {
      command: 'extrude_profile',
      params: {
        profile: [
          [-2, 0],
          [2, 0],
          [2, 10],
          [-2, 10],
        ],
        depth: 20,
      },
      as: 'rib',
    },
    {
      command: 'fillet_full_round',
      params: { id: '$rib', side1: { near: [[-2, 5, 10]] }, center: { near: [[0, 10, 10]] }, side2: { near: [[2, 5, 10]] } },
      as: 'f16',
    },
    mass('$f16'),
    facesOf('$f16'),
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'ca' },
    { command: 'chamfer_edge', params: { id: '$ca', edgesNear: [[5, 5, 0]], distance: 1, distance2: 2, side1Near: [5, 0, 0] }, as: 'k18a' },
    mass('$k18a'),
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'cb' },
    { command: 'chamfer_edge', params: { id: '$cb', edgesNear: [[5, 5, 0]], distance: 1, angleDeg: 30, side1Near: [5, 0, 0] }, as: 'k18b' },
    mass('$k18b'),
    block('bp'),
    { command: 'probe_fillet', params: { id: '$bp', edgesNear: [TOP_EDGE] } },
    { command: 'check_blends', params: { purpose: 'release' } },
  ],
);
plan(
  'target_error_codes',
  'Deliberately wrong requests; run each step alone (llull run --continue --json). Every step must exit 1 with the listed code, ids/paths and a remediation.',
  ['fillet_edge.corners', 'BLD_SETBACK_TOO_SHORT'],
  [
    block('e1'),
    { command: 'fillet_edge', params: { id: '$e1', edgesNear: [TOP_EDGE], radius: 6 }, expect: 'BLD_RADIUS_TOO_LARGE' },
    {
      command: 'fillet_edge',
      params: { id: '$e1', edgesNear: [TOP_EDGE], radius: 1, profile: { type: 'conic', rho: 1.2 } },
      expect: 'BLD_RHO_RANGE',
    },
    { command: 'add_cylinder', params: { radius: 5, height: 10 }, as: 'e2' },
    { command: 'fillet_edge', params: { id: '$e2', edges: [{ near: [5, 0, 5], size: 1, sizeEnd: 2 }] }, expect: 'BLD_LAW_NOT_PERIODIC' },
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'e3' },
    {
      command: 'fillet_edge',
      params: { id: '$e3', radius: 1, corners: [{ near: [5, 5, 5], type: 'setback', setback: 0.5 }] },
      expect: 'BLD_SETBACK_TOO_SHORT',
    },
    {
      command: 'extrude_profile',
      params: {
        profile: [
          [-5, -5],
          [5, -5],
          [5, 4],
          [4, 5],
          [-5, 5],
        ],
        depth: 10,
      },
      as: 'e4',
    },
    {
      command: 'fillet_faces',
      params: { id: '$e4', facesA: { near: [[5, 0, 5]] }, facesB: { near: [[0, 5, 5]] }, radius: 1.5 },
      expect: 'BLD_FACE_FILLET_NO_SOLUTION',
    },
  ],
);

// ---------- DES-6c step 2: profiles on curved edges and faces, varying sizes, corners (TECHNICAL_SPEC §13.11) ----------
/** Revolved spandrel volume: 2 pi |closed integral of rho^2 / 2 dz| over corner -> a, the rational quadratic a, t, b (weight w), b -> corner. */
const revolvedSpandrel = (a, t, b, w) => {
  const n = 40000;
  let sum = 0;
  let previous = a;
  for (let k = 1; k <= n; k++) {
    const u = k / n;
    const basis = [(1 - u) * (1 - u), 2 * u * (1 - u) * w, u * u];
    const norm = basis[0] + basis[1] + basis[2];
    const point = [0, 1].map((axis) => (basis[0] * a[axis] + basis[1] * t[axis] + basis[2] * b[axis]) / norm);
    sum += 0.25 * (previous[0] ** 2 + point[0] ** 2) * (point[1] - previous[1]);
    previous = point;
  }
  const line = (from, to) => 0.25 * (from[0] ** 2 + to[0] ** 2) * (to[1] - from[1]);
  return 2 * Math.PI * Math.abs(sum + line(b, t) + line(t, a));
};
const rimRemoved = revolvedSpandrel([8, 20], [10, 20], [10, 18], 1);
const bossAdded = revolvedSpandrel([12, 0], [10, 0], [10, 2], 0.4 / 0.6);
const parabolaToCircle = 1 / 6 / (1 - Math.PI / 4);

plan(
  'target_profiles_curved_variable',
  'Conic and curvature profiles on a cylinder rim, a sphere band, the concave ring of a boss, a rounded outline (tangent chain), a straight edge whose size varies and a cube whose twelve edges are profiled (G1 corner patches), each followed by check_blends.',
  [],
  [
    { command: 'add_cylinder', params: { radius: 10, height: 20, anchor: 'base-center' }, as: 'rim' },
    {
      command: 'fillet_edge',
      params: { id: '$rim', edgesNear: [[10, 0, 20]], radius: 2, profile: { type: 'conic', rho: 0.5 } },
      as: 'rimC',
    },
    mass('$rimC'),
    { command: 'check_blends', params: { ids: ['$rimC'] } },
    { command: 'add_cylinder', params: { radius: 10, height: 20, anchor: 'base-center' }, as: 'rim2' },
    {
      command: 'fillet_edge',
      params: { id: '$rim2', edgesNear: [[10, 0, 20]], radius: 2, profile: { type: 'curvature', shape: 0.5 } },
      as: 'rimG2',
    },
    { command: 'check_blends', params: { ids: ['$rimG2'], require: 'G2' } },
    { command: 'add_sphere', params: { radius: 5 }, as: 'ball' },
    { command: 'add_box', params: { size: [20, 20, 5] }, as: 'slab' },
    { command: 'boolean', params: { op: 'intersect', a: '$ball', b: '$slab' }, as: 'band' },
    {
      command: 'fillet_edge',
      params: {
        id: '$band',
        edgesNear: [
          [Math.sqrt(18.75), 0, 2.5],
          [Math.sqrt(18.75), 0, -2.5],
        ],
        radius: 0.4,
        profile: { type: 'curvature', shape: 0.5 },
      },
      as: 'bandG2',
    },
    { command: 'check_blends', params: { ids: ['$bandG2'], require: 'G2' } },
    { command: 'add_box', params: { size: [60, 60, 5], anchor: 'min' }, as: 'plate' },
    { command: 'add_cylinder', params: { radius: 10, height: 15, position: [30, 30, 5], anchor: 'base-center' }, as: 'boss' },
    { command: 'boolean', params: { op: 'union', a: '$plate', b: '$boss' }, as: 'fused' },
    { command: 'mass_properties', params: { entityId: '$fused' } },
    {
      command: 'fillet_edge',
      params: { id: '$fused', edgesNear: [[40, 30, 5]], radius: 2, profile: { type: 'conic', rho: 0.4 } },
      as: 'bossRing',
    },
    mass('$bossRing'),
    { command: 'add_box', params: { size: [20, 10, 10], anchor: 'min' }, as: 'varA' },
    { command: 'fillet_edge', params: { id: '$varA', edges: [{ near: [10, 10, 10], size: 1, sizeEnd: 2 }] }, as: 'varCircular' },
    mass('$varCircular'),
    { command: 'add_box', params: { size: [20, 10, 10], anchor: 'min' }, as: 'varB' },
    {
      command: 'fillet_edge',
      params: { id: '$varB', edges: [{ near: [10, 10, 10], size: 1, sizeEnd: 2 }], profile: { type: 'conic', rho: 0.5 } },
      as: 'varConic',
    },
    mass('$varConic'),
    { command: 'check_blends', params: { ids: ['$varConic'] } },
    { command: 'add_box', params: { size: [40, 30, 6], anchor: 'min' }, as: 'outline' },
    {
      command: 'fillet_edge',
      params: {
        id: '$outline',
        edgesNear: [
          [0, 0, 3],
          [40, 0, 3],
          [0, 30, 3],
          [40, 30, 3],
        ],
        radius: 5,
      },
      as: 'outlineRound',
    },
    {
      command: 'fillet_edge',
      params: { id: '$outlineRound', edgesNear: [[20, 30, 6]], radius: 1.5, profile: { type: 'conic', rho: 0.5 } },
      as: 'outlineLoop',
    },
    { command: 'check_blends', params: { ids: ['$outlineLoop'] } },
    { command: 'add_box', params: { size: [10, 10, 10], anchor: 'min' }, as: 'cube' },
    { command: 'fillet_edge', params: { id: '$cube', radius: 1, profile: { type: 'conic', rho: 0.5 } }, as: 'cubeC' },
    mass('$cubeC'),
    { command: 'check_blends', params: { ids: ['$cubeC'] } },
  ],
);

plan(
  'target_corners_concave_tapered',
  'Setback corners on a concave inner corner (a notch in a cube: the blends add material), on a cube whose twelve edges taper linearly from 0.8 to 1.2, and the refusal of a vertex of convex and concave edges; each followed by check_blends.',
  [],
  [
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'nc' },
    { command: 'add_box', params: { size: [6, 6, 6], position: [3, 3, 3] }, as: 'nt' },
    { command: 'boolean', params: { op: 'subtract', a: '$nc', b: '$nt' }, as: 'notch' },
    mass('$notch'),
    {
      command: 'fillet_edge',
      params: {
        id: '$notch',
        edgesNear: [
          [2.5, 0, 0],
          [0, 2.5, 0],
          [0, 0, 2.5],
        ],
        radius: 0.5,
        corners: [{ near: [0, 0, 0], type: 'setback', setback: 1.2 }],
      },
      as: 'f40',
    },
    mass('$f40'),
    { command: 'check_blends', params: { ids: ['$f40'] } },
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'tc' },
    {
      command: 'fillet_edge',
      params: {
        id: '$tc',
        edges: Array.from({ length: 12 }, (_, index) => ({ index, size: 0.8, sizeEnd: 1.2, interpolation: 'linear' })),
        corners: [{ all: true, type: 'setback', setback: 2.5 }],
      },
      as: 'f41',
    },
    mass('$f41'),
    { command: 'check_blends', params: { ids: ['$f41'] } },
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'nc2' },
    { command: 'add_box', params: { size: [6, 6, 6], position: [3, 3, 3] }, as: 'nt2' },
    { command: 'boolean', params: { op: 'subtract', a: '$nc2', b: '$nt2' }, as: 'notch2' },
    {
      command: 'fillet_edge',
      params: {
        id: '$notch2',
        edgesNear: [
          [0, 0, 2.5],
          [2.5, 0, 5],
          [0, 2.5, 5],
        ],
        radius: 0.5,
        corners: [{ near: [0, 0, 5], type: 'setback', setback: 1.2 }],
      },
      expect: 'BLD_CORNER_UNSUPPORTED',
    },
  ],
);

// ---------- DES-6c step 4: fillet_faces over face sets, curved faces, radiusEnd / law / width (TECHNICAL_SPEC §13.13) ----------
const CORNER_AREA = 1 - Math.PI / 4;
const lRemoved = CORNER_AREA * 1 * 1 * (10 + 5);
const cylinderRimRemoved = 2 * Math.PI * ((5 - 1) * CORNER_AREA * 1 + 1 / 6);
const bossRingAdded = 2 * Math.PI * ((10 + 2) * CORNER_AREA * 4 - 8 / 6);
const lawRemoved = (CORNER_AREA * 20 * (1 + 2 + 4)) / 3;
const widthRemoved = CORNER_AREA * 1 * 20;
plan(
  'target_face_sets',
  'DES-6c step 4: fillet_faces with sets of several faces (an L prism, a cylinder rim, a boss ring), a law, a width, and the refusals of what is not built',
  [],
  [
    {
      command: 'extrude_profile',
      params: {
        profile: [
          [0, 0],
          [10, 0],
          [10, 5],
          [5, 5],
          [5, 10],
          [0, 10],
        ],
        depth: 10,
      },
      as: 'lp',
    },
    mass('$lp'),
    {
      command: 'fillet_faces',
      params: {
        id: '$lp',
        facesA: { near: [[2, 2, 10]] },
        facesB: {
          near: [
            [5, 0, 5],
            [2.5, 10, 5],
          ],
        },
        radius: 1,
      },
      as: 'f42',
    },
    mass('$f42'),
    { command: 'check_blends', params: { ids: ['$f42'] } },
    { command: 'add_cylinder', params: { radius: 5, height: 10, anchor: 'base-center' }, as: 'cy' },
    mass('$cy'),
    {
      command: 'fillet_faces',
      params: { id: '$cy', facesA: { near: [[2.5, 0, 10]] }, facesB: { near: [[5, 0, 5]] }, radius: 1 },
      as: 'f43',
    },
    mass('$f43'),
    { command: 'check_blends', params: { ids: ['$f43'] } },
    { command: 'add_box', params: { size: [60, 60, 5], anchor: 'min' }, as: 'pl' },
    { command: 'add_cylinder', params: { radius: 10, height: 15, position: [30, 30, 5], anchor: 'base-center' }, as: 'bs' },
    { command: 'boolean', params: { op: 'union', a: '$pl', b: '$bs' }, as: 'fu' },
    mass('$fu'),
    {
      command: 'fillet_faces',
      params: { id: '$fu', facesA: { near: [[5, 5, 5]] }, facesB: { near: [[40, 30, 10]] }, radius: 2 },
      as: 'f44',
    },
    mass('$f44'),
    { command: 'check_blends', params: { ids: ['$f44'] } },
    block('bl'),
    mass('$bl'),
    {
      command: 'fillet_faces',
      params: { id: '$bl', facesA: { near: [TOP_FACE] }, facesB: { near: [SIDE_FACE] }, law: { expression: '1 + t', samples: 33 } },
      as: 'f45',
    },
    mass('$f45'),
    { command: 'check_blends', params: { ids: ['$f45'] } },
    block('bw'),
    {
      command: 'fillet_faces',
      params: { id: '$bw', facesA: { near: [TOP_FACE] }, facesB: { near: [SIDE_FACE] }, width: Math.SQRT2 },
      as: 'f46',
    },
    mass('$f46'),
    {
      command: 'extrude_profile',
      params: {
        profile: [
          [0, 0],
          [10, 0],
          [10, 5],
          [5, 5],
          [5, 10],
          [0, 10],
        ],
        depth: 10,
      },
      as: 'lq',
    },
    {
      command: 'fillet_faces',
      params: {
        id: '$lq',
        facesA: { near: [[2, 2, 10]] },
        facesB: {
          near: [
            [5, 0, 5],
            [2.5, 10, 5],
          ],
        },
        radius: 1,
        radiusEnd: 2,
      },
      expect: 'BLD_FACE_BLEND_UNSUPPORTED',
    },
    {
      command: 'fillet_faces',
      params: {
        id: '$lq',
        facesA: { near: [[7.5, 5, 5]] },
        facesB: {
          near: [
            [5, 0, 5],
            [2.5, 10, 5],
          ],
        },
        radius: 1,
      },
      expect: 'BLD_FACE_BLEND_UNSUPPORTED',
    },
    { command: 'add_box', params: { size: [100, 100, 100], anchor: 'min' }, as: 'cc' },
    { command: 'fillet_edge', params: { id: '$cc', edgesNear: [[100, 100, 50]], radius: 20 }, as: 'cr' },
    {
      command: 'fillet_faces',
      params: { id: '$cr', facesA: { near: [[50, 50, 100]] }, facesB: { near: [[50, 100, 50]] }, radius: 5 },
      expect: 'BLD_FACE_BLEND_UNSUPPORTED',
    },
  ],
);

// ---------- DES-6c step 5: M5, variable chamfer and per-joint blend_union radii (TECHNICAL_SPEC §13.14) ----------
const variableChamferRemoved = 0.5 * 20 * ((1 + 2 + 4) / 3);
const tPlain = 40 * 20 * 4 + 10 * 20 * 16;
const tJointsAdded = CORNER_AREA * 20 * (0.5 * 0.5 + 1.5 * 1.5);
plan(
  'target_m5',
  'DES-6c step 5: the variable chamfer 1 -> 2, its refusals, blend_union with per-joint radii and the readback, and the worked plan of the llull guide (Blends)',
  [],
  [
    block('c19'),
    { command: 'chamfer_edge', params: { id: '$c19', edgesNear: [TOP_EDGE], distance: 1, distanceEnd: 2 }, as: 'k19' },
    mass('$k19'),
    block('c19b'),
    { command: 'chamfer_edge', params: { id: '$c19b', edgesNear: [TOP_EDGE], distance: 1, distanceEnd: 6 }, expect: 'BLD_CHAMFER_FAILED' },
    { command: 'chamfer_edge', params: { id: '$c19b', distance: 1, distanceEnd: 2 }, expect: 'BLD_CHAMFER_VARIABLE_PARAMS' },
    { command: 'add_box', params: { size: [40, 20, 4], position: [20, 10, 2] }, as: 'tp' },
    { command: 'add_box', params: { size: [10, 20, 18], position: [20, 10, 11] }, as: 'ts' },
    {
      command: 'blend_union',
      params: {
        ids: ['$tp', '$ts'],
        radius: 1,
        joints: [
          { near: [15, 10, 4], radius: 0.5 },
          { near: [25, 10, 4], radius: 1.5 },
        ],
      },
      as: 'j32',
    },
    mass('$j32'),
    { command: 'check_blends', params: { ids: ['$j32'] } },
    { command: 'add_box', params: { size: [20, 10, 5] }, as: 'g1' },
    { command: 'probe_fillet', params: { id: '$g1', edgesNear: [TOP_EDGE] } },
    { command: 'fillet_edge', params: { id: '$g1', edgesNear: [TOP_EDGE], radius: 1, radiusEnd: 2 }, as: 'gf' },
    { command: 'check_blends', params: { ids: ['$gf'] } },
    { command: 'add_box', params: { size: [20, 10, 5] }, as: 'g2' },
    { command: 'chamfer_edge', params: { id: '$g2', edgesNear: [TOP_EDGE], distance: 1, distanceEnd: 2 }, as: 'gc' },
    { command: 'add_box', params: { size: [20, 10, 5] }, as: 'g3' },
    { command: 'fillet_edge', params: { id: '$g3', edgesNear: [TOP_EDGE], radius: 1, profile: { type: 'conic', rho: 0.5 } }, as: 'gp' },
    { command: 'check_blends', params: { ids: ['$gp'], require: 'G1' } },
  ],
);

// ---------- expected results ----------
const D = '--doc t.llull.json --kernel occt --json';
const cases = [
  {
    vc: 'VC-BLD-01',
    what: 'constant r = 1 fillet, one edge of a 10-cube (regression anchor = oracle 83)',
    value: straight.box10_one_edge_r1.volume,
    tolerance: 1e-3,
    unit: 'mm3',
    grade: 'A',
    source: '(b) V = a^3 - (1 - pi/4) r^2 L',
    plan: 'baseline_variable_radius_laws',
    assert: 'mass_properties($f01).data.volume',
    proves: ['FR-BLD-01', 'TR-BLD-17'],
  },
  {
    vc: 'VC-BLD-02',
    what: 'linear law r 1 -> 2 on the 20-long top edge of the 20x10x5 block: planar face areas (construction-independent) and volume (section construction)',
    value: {
      topFaceArea: laws.linear_r1_to_r2.topFaceArea,
      sideFaceArea: laws.linear_r1_to_r2.sideFaceArea,
      volume: laws.linear_r1_to_r2.volume_section,
    },
    tolerance: { faceArea: 1e-6, volume: '2e-4 relative to the section value (measured native band, see finding)' },
    measuredNative: { volume: 989.896820782, minusSectionValue: -0.088427, relative: -8.9e-5, gprops_vs_fine_mesh: '< 1e-5 relative' },
    finding:
      'OCCT Add(r1, r2, E) builds neither the normal-section nor the rolling-ball envelope construction: it removes 8.9e-5 relative MORE than the section value (VC-BLD-30). Face areas stay exact. The 0.02 band of this pack was too tight; gates: oracle 110 (2e-4), server/tests/nativeBlends.test.ts pins the measured volume.',
    unit: 'mm2 / mm3',
    grade: 'A (face areas); B (volume, measured native band)',
    source: '(b) contact line at distance r(s) on each plane; Cavalieri; envelope band data/variable_radius_laws.json',
    plan: 'baseline_variable_radius_laws',
    assert: 'inspect_faces($f02) faces named <b2>:top / <b2>:side areas; mass_properties($f02).data.volume',
    proves: ['FR-BLD-01', 'FR-BLD-05', 'TR-BLD-02'],
  },
  {
    vc: 'VC-BLD-03',
    what: 'control-point law 1 / 2 at t = 0.5 / 1: radius at the control points; with interpolation "linear" the face areas',
    value: { radiusAtHalf: 2, topFaceArea_linear: 200 - laws.controlPoints_1_2_1.faceAreaLost_piecewiseLinear },
    tolerance: { radius: 1e-6, faceArea: 1e-6 },
    unit: 'mm / mm2',
    grade: 'A',
    source: '(b) law definition; smooth (OCCT Law_Interpol) face area TBD - measure with inspect_faces',
    plan: 'baseline_variable_radius_laws (smooth) + target_laws_and_profiles (linear)',
    assert: 'check_blends($f03).data.blends[0].radius.at[t=0.5]; inspect_faces($f03)',
    proves: ['FR-BLD-01', 'FR-BLD-05', 'FR-BLD-12', 'TR-BLD-01', 'TR-BLD-05'],
  },
  {
    vc: 'VC-BLD-04',
    what: 'periodic expression law r(t) = 1 + 0.5 cos(2 pi t) around the top rim of a cylinder R 5 h 10',
    value: rim.volumeAfter,
    tolerance: 0.01,
    unit: 'mm3',
    grade: 'A (closed form); tolerance covers the 33-sample interpolation (TBD tighten after first run)',
    source: '(b) generalised Pappus over meridian sections',
    plan: 'target_laws_and_profiles',
    assert: 'mass_properties($f04).data.volume',
    proves: ['FR-BLD-02', 'FR-BLD-03', 'TR-BLD-01', 'TR-BLD-02'],
  },
  {
    vc: 'VC-BLD-05',
    what: 'chord 2 fillet on a 60 deg edge of an equilateral prism (side 10, depth 10)',
    value: straight.triPrism_chord2_60deg.volumeAfter,
    tolerance: 1e-3,
    unit: 'mm3',
    grade: 'A',
    source: '(b) r = c / (2 cos(alpha/2)); A = r^2 [cot(alpha/2) - (pi - alpha)/2]',
    plan: 'baseline_variable_radius_laws',
    assert: 'mass_properties($f05).data.volume',
    proves: ['FR-BLD-04'],
  },
  {
    vc: 'VC-BLD-06',
    what: 'chord sqrt2 fillet on the cylinder rim (plane meets cylinder at 90 deg; meridian section = two perpendicular lines) => r = 1',
    value: rim.constantR1Check.volumeAfter,
    tolerance: 1e-3,
    unit: 'mm3',
    grade: 'A',
    source: '(b) Pappus (oracle 87 value); today refused: chord needs two planar faces (baseline_limits_today step 8)',
    plan: 'target_laws_and_profiles',
    assert: 'mass_properties($f06).data.volume',
    proves: ['FR-BLD-04', 'TR-BLD-10'],
  },
  ...conic.block20x10x5_topEdge_r1.map((row, i) => ({
    vc: `VC-BLD-07${'abcd'[i]}`,
    what: `conic profile rho ${row.rho} sized by r = 1 on the block top edge`,
    value: row.volumeAfter,
    tolerance: 1e-3,
    unit: 'mm3',
    grade: 'A',
    source: '(b) removed = Delta (1 - f(w)), w = rho/(1-rho), data/conic_sections.json; rho = sqrt2-1 equals the circular value',
    plan: 'target_laws_and_profiles',
    assert: `mass_properties($f07_${i}).data.volume`,
    proves: ['FR-BLD-06', 'TR-BLD-06'],
  })),
  {
    vc: 'VC-BLD-08',
    what: 'asymmetric legs 1 (top) x 2 (side), rho = sqrt2 - 1 (elliptic quarter)',
    value: extra.asymmetricConic_1x2_block20.volumeAfter,
    tolerance: 1e-3,
    unit: 'mm3',
    grade: 'A',
    source: '(b) affine image of the circle: (1 - pi/4) d1 d2 L',
    plan: 'target_laws_and_profiles',
    assert: 'mass_properties($f08).data.volume',
    proves: ['FR-BLD-06', 'FR-BLD-08', 'TR-BLD-06'],
  },
  {
    vc: 'VC-BLD-09',
    what: 'curvature-continuous profile, tangent distance 1, shape 0.5 (quartic) on the block top edge: volume and measured G2 at both contacts',
    value: { volume: g2.block20x10x5_topEdge_d1_k05.volumeAfter, contactCurvature: 0, order: 'G2' },
    tolerance: { volume: 1e-3, contactCurvature: 1e-6 },
    unit: 'mm3 / 1/mm',
    grade: 'A',
    source: '(b) quartic Bezier area 0.1 d^2 at k = 0.5, data/g2_sections.json',
    plan: 'target_laws_and_profiles',
    assert: 'mass_properties($f09).data.volume; check_blends($f09).data.blends[0].contacts[*].order',
    proves: ['FR-BLD-07', 'FR-BLD-21', 'TR-BLD-04', 'TR-BLD-06'],
  },
  {
    vc: 'VC-BLD-10',
    what: 'a circular fillet is G1, not G2: contact curvature jump 1/r',
    value: { g2Gap: 1, g2Rel: 1, order: 'G1' },
    tolerance: { g2Gap: 1e-6 },
    unit: '1/mm',
    grade: 'A',
    source: '(b) plane curvature 0, cylinder normal curvature 1/r',
    plan: 'target_laws_and_profiles',
    assert: 'check_blends($f10).data.blends[0].contacts[*]',
    proves: ['FR-BLD-21', 'TR-BLD-04'],
  },
  {
    vc: 'VC-BLD-11',
    what: 'rolling-ball corners: all 12 edges of a 10-cube r = 1 (oracle 85)',
    value: corners.cube_all_edges_r1.volume_rollingBall,
    tolerance: 1e-3,
    unit: 'mm3',
    grade: 'A',
    source: '(b) Steiner',
    plan: 'baseline_variable_radius_laws',
    assert: 'mass_properties($f11).data.volume',
    proves: ['FR-BLD-09'],
  },
  {
    vc: 'VC-BLD-12',
    what: 'setback s = 2 at all 8 corners, r = 1: edge blend span, patch G1, volume bounds',
    value: {
      cylinderSpan: corners.cube_setback_s2.cylinderFaceSpanPerEdge,
      volumeBounds: corners.cube_setback_s2.volumeBounds,
      patchG1AngleRadMax: 0.01,
      volume: 'TBD - measure (record as golden)',
    },
    tolerance: { span: 1e-6 },
    unit: 'mm / mm3 / rad',
    grade: 'A (span, bounds); C (volume)',
    source: '(b) definition of setback; bounds data/corner_blends.json',
    plan: 'target_corners_faces_chamfers',
    assert: 'inspect_faces($f12) cylinder axis.span; mass_properties($f12); check_blends($f12)',
    proves: ['FR-BLD-09', 'TR-BLD-07'],
  },
  {
    vc: 'VC-BLD-13',
    what: '4 edges meeting at the apex of a pyramid. OCCT documents >= 4-edge contour ends as not handled, but llull-kernel (OCCT 7.9.2) completes this symmetric apex today (measured 2026-10-22: valid B-rep, 11 faces, 23 edges). Target: same without corners, setback 1.5 gives a valid solid; BLD_CORNER_UNSUPPORTED only when OCCT itself reports the vertex faulty',
    value: { today: { valid: true, faces: 11, edges: 23 }, targetValid: true, targetValid_setback: true },
    tolerance: 'exact',
    unit: '-',
    grade: 'A (measured on llull-kernel 2026-10-22; OCCT header text)',
    source: '[R1] BRepFilletAPI_MakeFillet::Build warning; baseline_limits_today step 6 run on the native kernel',
    plan: 'baseline_limits_today + target_corners_faces_chamfers + target_error_codes',
    assert: 'check_blends($f13).data.status != fail; error.code',
    proves: ['FR-BLD-10', 'FR-BLD-19', 'TR-BLD-03', 'TR-BLD-07'],
  },
  {
    vc: 'VC-BLD-14',
    what: 'face-face fillet r = 2 between the two faces of a chamfered corner (chamfer face consumed)',
    value: { volume: faces.faceFaceAcrossChamfer.volumeAfterFaceFillet, chamferFacePresent: false },
    tolerance: { volume: 1e-3 },
    unit: 'mm3',
    grade: 'A',
    source: '(b) 1000 - (1 - pi/4) r^2 L',
    plan: 'target_corners_faces_chamfers',
    assert: 'mass_properties($f14); inspect_faces($f14)',
    proves: ['FR-BLD-13', 'TR-BLD-08'],
  },
  {
    vc: 'VC-BLD-15',
    what: 'face-face fillet r = 1.5 < c/(2 - sqrt2) = 1.70711 across the chamfer is refused',
    value: 'BLD_FACE_FILLET_NO_SOLUTION',
    tolerance: 'exact',
    unit: '-',
    grade: 'A',
    source: '(b) r (sqrt2 - 1) >= c / sqrt2',
    plan: 'target_error_codes',
    assert: 'error.code, error.paths includes params.radius, remediation names 1.70711',
    proves: ['FR-BLD-13', 'FR-BLD-19', 'TR-BLD-15'],
  },
  {
    vc: 'VC-BLD-16',
    what: 'full round of a 4-wide rib top (r = 2), top face consumed; today two r = 2 fillets fail (record)',
    value: { volume: faces.fullRoundRib.volumeAfter, cylinderRadius: 2, cylinderArea: faces.fullRoundRib.cylinderFace.area },
    tolerance: { volume: 1e-3, radius: 1e-6, area: 1e-3 },
    unit: 'mm3 / mm / mm2',
    grade: 'A',
    source: '(b) (t^2/2)(1 - pi/4) L',
    plan: 'target_corners_faces_chamfers (+ baseline_limits_today step 4)',
    assert: 'mass_properties($f16); inspect_faces($f16)',
    proves: ['FR-BLD-15', 'TR-BLD-09'],
  },
  {
    vc: 'VC-BLD-17',
    what: 'hold line from 1 to 2 mm off the top edge on the top face => linear radius 1 -> 2 (90 deg): face areas',
    value: { topFaceArea: 170, sideFaceArea: 70 },
    tolerance: 1e-6,
    unit: 'mm2',
    grade: 'A',
    source: '(b) r = h tan(alpha/2)',
    plan: 'target_corners_faces_chamfers',
    assert: 'inspect_faces($f17)',
    proves: ['FR-BLD-14', 'TR-BLD-10'],
  },
  {
    vc: 'VC-BLD-18',
    what: 'chamfers on one edge of a 10-cube: symmetric d 1 (oracle 88), asymmetric 1 x 2, distance-angle 1 / 30 deg',
    value: {
      symmetric: chamfers.symmetric_d1_box10.volumeAfter,
      asymmetric: chamfers.asymmetric_1x2_box10.volumeAfter,
      distanceAngle: chamfers.distanceAngle_1_30deg_box10.volumeAfter,
    },
    tolerance: 1e-3,
    unit: 'mm3',
    grade: 'A',
    source: '(b) triangle area d1 d2 sin(alpha) / 2',
    plan: 'baseline_variable_radius_laws (symmetric) + target_corners_faces_chamfers',
    assert: 'mass_properties($k18*)',
    proves: ['FR-BLD-18', 'TR-BLD-11'],
  },
  {
    vc: 'VC-BLD-19',
    what: 'variable chamfer 1 -> 2 along the block top edge (chamfer_edge distanceEnd, M5): the ruled loft of the corner triangles; removed volume 1/2 integral d^2; refused with the reason when a distance reaches past the faces, and without listed edges (BLD_CHAMFER_VARIABLE_PARAMS); refusals by the kernel are BLD_CHAMFER_FAILED',
    value: { volume: chamfers.variableLinear_1to2_block20.volumeAfter, removed: variableChamferRemoved },
    tolerance: 1e-8,
    unit: 'mm3 (relative)',
    grade: 'A (section construction)',
    source: '(b) (1/2) integral d^2',
    plan: 'target_m5',
    assert: 'mass_properties($k19)',
    proves: ['FR-BLD-18'],
  },
  {
    vc: 'VC-BLD-20',
    what: 'probe_fillet on the block top edge: max feasible radius below the geometric bound 5; r = 0.99 rMax succeeds, r = 1.01 rMax fails',
    value: { upperBound: 5, rMax: 'TBD - measure (record as golden)' },
    tolerance: { rMax: 1e-3 },
    unit: 'mm',
    grade: 'A (bound); C (value)',
    source: '(b) face height; data/probe_limits.json',
    plan: 'target_corners_faces_chamfers',
    assert: 'probe_fillet.data.edges[0].maxRadius < 5',
    proves: ['FR-BLD-20', 'TR-BLD-14', 'TR-BLD-18'],
  },
  {
    vc: 'VC-BLD-21',
    what: 'error-code plan: each refusal has the stable code, ids/paths and a remediation; document unchanged',
    value: [
      'BLD_RADIUS_TOO_LARGE',
      'BLD_RHO_RANGE',
      'BLD_LAW_NOT_PERIODIC',
      'BLD_SETBACK_TOO_SHORT',
      'BLD_FACE_FILLET_NO_SOLUTION',
      'BLD_CORNER_UNSUPPORTED',
    ],
    tolerance: 'exact',
    unit: '-',
    grade: 'A',
    source: 'TECHNICAL_SPEC §7.1',
    plan: 'target_error_codes',
    assert: 'error.code per step, exit 1',
    proves: ['FR-BLD-19', 'TR-BLD-03', 'TR-BLD-15'],
  },
  {
    vc: 'VC-BLD-22',
    what: 'persistent references: fillet by edge name survives an upstream box resize; a deleted edge gives REF_LOST; a setback corner and a face set re-resolve by name',
    value: { sameEdge: true, lostCode: 'REF_LOST' },
    tolerance: 'exact',
    unit: '-',
    grade: 'A',
    source: 'SC-N1 naming (packages/core/src/geometry/naming/references.ts)',
    plan: 'unit + golden (edit_step_params)',
    assert: 'face names blend(<edge>) after replay',
    proves: ['FR-BLD-22', 'TR-BLD-13'],
  },
  {
    vc: 'VC-BLD-23',
    what: 'check_blends on the target plan: named defaulted tolerances, unverified for positional picks on a kernel without names, reviewRequired with purpose release',
    value: { tolerancesDefaulted: true, reviewRequired: true },
    tolerance: 'exact',
    unit: '-',
    grade: 'A',
    source: 'AF-20, AF-31, AF-32, AF-33',
    plan: 'target_corners_faces_chamfers (last step)',
    assert: 'data.tolerances.*.defaulted, data.reviewRequired, data.findings[*].code',
    proves: ['FR-BLD-21', 'FR-BLD-26', 'TR-BLD-15'],
  },
  {
    vc: 'VC-BLD-24',
    what: 'mesh kernel: every mutating BLD command refuses with CMD_KERNEL_UNAVAILABLE / BLD_KERNEL_UNSUPPORTED, document unchanged; check_blends returns not_run',
    value: 'refused',
    tolerance: 'exact',
    unit: '-',
    grade: 'A',
    source: 'L9',
    plan: 'any target plan with --kernel manifold',
    assert: 'error.code',
    proves: ['FR-BLD-28'],
  },
  {
    vc: 'VC-BLD-25',
    what: 'purity and replay: is-pure tests, golden replay equality, tool-schema snapshot',
    value: 'identical',
    tolerance: 'exact',
    unit: '-',
    grade: 'A',
    source: 'W3',
    plan: 'all target plans',
    assert: 'golden',
    proves: ['FR-BLD-23', 'TR-BLD-12', 'TR-BLD-14'],
  },
  {
    vc: 'VC-BLD-26',
    what: 'export_code cadquery of the linear-law fillet runs with bundled OCP and gives the same volume; a conic fillet export carries BLD_CODEGEN_UNSUPPORTED in notes (never silently constant)',
    value: laws.linear_r1_to_r2.volume_section,
    tolerance: 0.02,
    unit: 'mm3',
    grade: 'A (band as VC-02)',
    source: '(b) as VC-02',
    plan: 'baseline_variable_radius_laws + export_code',
    assert: 'python oracle volume; export notes',
    proves: ['FR-BLD-25', 'TR-BLD-16'],
  },
  {
    vc: 'VC-BLD-27',
    what: 'STEP round trip of conic and G2 blends: blend faces exported as B-spline surfaces, volume unchanged',
    value: 'volume change 0',
    tolerance: 1e-6,
    unit: 'relative',
    grade: 'A',
    source: '-',
    plan: 'target_laws_and_profiles + export_step + import_step_exact',
    assert: 'mass_properties before / after',
    proves: ['FR-BLD-27'],
  },
  {
    vc: 'VC-BLD-28',
    what: 'describe / result audit: every numeric param of fillet_edge, chamfer_edge, fillet_faces, fillet_full_round, probe_fillet, check_blends states its unit; every result number has a unit',
    value: 0,
    tolerance: 'exact',
    unit: 'count of violations',
    grade: 'A',
    source: 'AF-04, AF-10',
    plan: 'contract test',
    assert: 'llull describe --json',
    proves: ['FR-BLD-24', 'FR-BLD-30'],
  },
  {
    vc: 'VC-BLD-29',
    what: 'partial fillet t in [0.25, 0.75] on the block top edge (COULD): blend face lies within x in [-5 - runout, 5 + runout]; volume recorded',
    value: 'TBD - measure',
    tolerance: 'TBD',
    unit: 'mm',
    grade: 'C',
    source: 'Onshape partial fillet [R13]',
    plan: '-',
    assert: 'inspect_faces',
    proves: ['FR-BLD-11'],
  },
  {
    vc: 'VC-BLD-30',
    what: 'construction probe: linear law r 1 -> 3; the exact volume tells which construction the native kernel builds (section 981.401174 vs envelope 981.462234); face areas 160 / 60 exact either way',
    value: {
      faceAreas: extra.constructionProbe_r1to3.faceAreasExact,
      volume_section: extra.constructionProbe_r1to3.volume_section,
      volume_envelope: extra.constructionProbe_r1to3.volume_envelope,
    },
    tolerance: { faceArea: 1e-6, volume: '5e-4 relative to the section value (measured native band, see finding)' },
    measuredNative: {
      volume: 981.047466455,
      minusSectionValue: -0.353708,
      minusEnvelopeValue: -0.414768,
      relative: -3.6e-4,
      gprops_vs_fine_mesh: '< 1e-5 relative',
    },
    finding:
      'Classification result: the native volume matches NEITHER construction (981.401174 section, 981.462234 envelope); it is 3.6e-4 relative below the section value, confirmed by a 1e-4 deflection mesh, so it is the construction of OCCT Add(r1, r2, E), not integration error. Oracle 111 gates at 5e-4.',
    unit: 'mm2 / mm3',
    grade: 'A (face areas); B (volume, measured native band)',
    source: '(b) generate_blend_refs.mjs constructionProbe',
    plan: 'baseline_variable_radius_laws',
    assert: 'mass_properties($f30); inspect_faces($f30)',
    proves: ['FR-BLD-01', 'FR-BLD-05', 'TR-BLD-02'],
  },
  {
    vc: 'VC-BLD-31',
    what: 'face blend cliff edge and trim modes (COULD): blend clamped to a chosen edge; trim none keeps the full blend sheet',
    value: 'TBD - measure',
    tolerance: 'TBD',
    unit: '-',
    grade: 'C',
    source: 'Onshape Face Blend [R6]',
    plan: '-',
    assert: 'check_blends',
    proves: ['FR-BLD-16'],
  },
  {
    vc: 'VC-BLD-32',
    what: 'blend_union with per-joint radii (M5): a plate 40 x 20 x 4 with a stem 10 x 20 x 18 sunk 2 into it, joints of length 20 at radius 0.5 and 1.5 beside a default 1; added volume (1 - pi/4) L (r1^2 + r2^2); check_blends reads one radius per joint',
    value: { volume: tPlain + tJointsAdded, addedVolume: tJointsAdded, radii: [0.5, 1.5] },
    tolerance: { volume: 1e-9, radius: 1e-6 },
    unit: 'mm3 (relative) / mm',
    grade: 'A (radius readback)',
    source: '(b) (1 - pi/4) r^2 L per concave right-angle joint',
    plan: 'target_m5',
    assert: 'mass_properties($j32); check_blends($j32).data.blends[*].radius',
    proves: ['FR-BLD-17'],
  },
  {
    vc: 'VC-BLD-33',
    what: 'review overlays (COULD): toggling radius labels / section combs never changes the document; legend values equal check_blends data',
    value: 'document unchanged',
    tolerance: 'exact',
    unit: '-',
    grade: 'A',
    source: 'L1, AF-21',
    plan: 'component test',
    assert: 'store snapshot',
    proves: ['FR-BLD-29'],
  },
  {
    vc: 'VC-BLD-34',
    what: 'conic rim of a cylinder R 10 h 20, r 2, rho 0.5: the revolved spandrel is removed (rail-preserving profile on a curved edge); check_blends G1 at both contacts',
    value: { removedVolume: rimRemoved },
    tolerance: 1e-6,
    unit: 'mm3 (relative)',
    grade: 'A',
    source: '(b) 2 pi |closed integral of rho^2 / 2 dz| over the spandrel (Green), generate_plans.mjs',
    plan: 'target_profiles_curved_variable',
    assert: 'mass_properties($rimC); check_blends($rimC)',
    proves: ['FR-BLD-06', 'TR-BLD-06'],
  },
  {
    vc: 'VC-BLD-35',
    what: 'curvature profile on a plane-cylinder rim and on a sphere band (R 5, planar caps): contacts G2, curvature jump x R below 1e-6',
    value: { g2GapTimesRadius: 0 },
    tolerance: 1e-6,
    unit: 'dimensionless',
    grade: 'A',
    source: '(b) the section takes the curvature of each support (quintic, TECHNICAL_SPEC §13.11)',
    plan: 'target_profiles_curved_variable',
    assert: 'check_blends($rimG2, $bandG2).blends[*].contacts[*].order == G2',
    proves: ['FR-BLD-07', 'FR-BLD-21', 'TR-BLD-06'],
  },
  {
    vc: 'VC-BLD-36',
    what: 'conic ring (rho 0.4, r 2) on the concave edge of a boss R 10 on a plate: the revolved spandrel on the outside is added',
    value: { addedVolume: bossAdded },
    tolerance: 1e-6,
    unit: 'mm3 (relative)',
    grade: 'A',
    source: '(b) as VC-BLD-34 on the air side of the corner',
    plan: 'target_profiles_curved_variable',
    assert: 'mass_properties($bossRing) - mass_properties($fused)',
    proves: ['FR-BLD-06', 'TR-BLD-06'],
  },
  {
    vc: 'VC-BLD-37',
    what: 'conic profile on a straight edge whose size runs 1 -> 2: same contact lines as the circular variable fillet, so the removed volume is the ratio c(rho) / (1 - pi/4) of the circular one (rho 0.5: 1/6)',
    value: { ratioToCircular: parabolaToCircle },
    tolerance: 1e-4,
    unit: 'relative',
    grade: 'A',
    source: '(b) affine invariance of the section area at a right angle',
    plan: 'target_profiles_curved_variable',
    assert: '(V0 - V($varConic)) / (V0 - V($varCircular))',
    proves: ['FR-BLD-05', 'FR-BLD-06', 'TR-BLD-06'],
  },
  {
    vc: 'VC-BLD-38',
    what: 'conic profile on one top edge of a rounded outline (4 straight edges + 4 corner arcs): the whole tangent chain gets the profile, 8 blend faces, check_blends passes',
    value: { profileBlends: 8 },
    tolerance: 'exact',
    unit: '-',
    grade: 'A',
    source: 'definition (OCCT rounds the tangent chain of a picked edge)',
    plan: 'target_profiles_curved_variable',
    assert: 'check_blends($outlineLoop).data.blends where profile == conic',
    proves: ['FR-BLD-06', 'TR-BLD-06'],
  },
  {
    vc: 'VC-BLD-39',
    what: 'cube 10, all 12 edges conic rho 0.5 r 1: 8 G1 corner patches (setback 2 x the least distance, reported in data.profile), G1 <= 0.01 rad, patch G0 within 5 x the default; volume: golden 975.822 +- 0.05, below a^3 - 12 (a - 2 sb) d^2 / 6 (the prism spandrels over the span), within 1e-3 of the circular rolling-ball cube',
    value: { patches: 8, g1MaxRad: 0.01, volumeGolden: 975.822, volumeBounds: [975.772, 988], againstCircular: 1e-3 },
    tolerance: { g1: 0.01, g0: '5 x 1e-6 x diagonal', volume: 0.05 },
    unit: 'rad / mm3',
    grade: 'A (bound, circular ratio) / C (volume golden: Plate fill)',
    source: 'M2 corner refill: setback corner pipeline with the least setback x 2 (TECHNICAL_SPEC §13.11)',
    plan: 'target_profiles_curved_variable',
    assert: 'check_blends($cubeC); mass_properties($cubeC); data.profile.corners',
    proves: ['FR-BLD-09', 'TR-BLD-06', 'TR-BLD-07'],
  },
  {
    vc: 'VC-BLD-40',
    what: 'cube 10 less the octant [0, 6]^3 (a notch), its three concave inner edges r 0.5 with a setback 1.2 corner at the inner vertex: 3 blend cylinders spanning 3.8, 1 corner patch, material is ADDED (volume above the notch solid), blends and patch G1 (<= 0.01 rad), check_blends passes',
    value: { cylinders: 3, patches: 1, span: 3.8, volumeAdded: true, g1MaxRad: 0.01 },
    tolerance: { span: 1e-6, g1: 0.01, g0: '5 x 1e-6 x diagonal' },
    unit: 'mm / rad',
    grade: 'A (span, counts, bound)',
    source: 'definition (a concave blend fills the corner between its faces)',
    plan: 'target_corners_concave_tapered',
    assert: 'inspect_topology($f40); mass_properties($notch, $f40); check_blends($f40)',
    proves: ['FR-BLD-09', 'TR-BLD-06'],
  },
  {
    vc: 'VC-BLD-41',
    what: 'cube 10, all 12 edges with a radius linear from 0.8 at the start to 1.2 at the end, setback 2.5 at the 8 corners: 26 faces, 8 corner patches, volume between the constant r 1.2 and r 0.8 cubes, G1 <= 0.01 rad, check_blends passes (the law readback is not compared over a setback blend)',
    value: { faces: 26, patches: 8, volumeBetween: ['constant r 1.2', 'constant r 0.8'], g1MaxRad: 0.01 },
    tolerance: { g1: 0.01, g0: '5 x 1e-6 x diagonal' },
    unit: 'rad / mm3',
    grade: 'A (counts, bounds)',
    source: 'definition (a linear law between the two ends of the edge)',
    plan: 'target_corners_concave_tapered',
    assert: 'inspect_topology($f41); mass_properties($f41); check_blends($f41)',
    proves: ['FR-BLD-09', 'TR-BLD-06'],
  },
  {
    vc: 'VC-BLD-42',
    what: 'fillet_faces, top cap of an L prism (10 x 10, notch 5 x 5, depth 10) against TWO side walls (10 and 5 long), r 1: two blend faces, removed volume (1 - pi/4) r^2 (10 + 5)',
    value: { removedVolume: lRemoved, blends: 2 },
    tolerance: 1e-6,
    unit: 'mm3 (relative)',
    grade: 'A',
    source: '(b) V = V0 - (1 - pi/4) r^2 sum(L)',
    plan: 'target_face_sets',
    assert: 'mass_properties($lp) - mass_properties($f42); check_blends($f42)',
    proves: ['FR-BLD-13', 'TR-BLD-08'],
  },
  {
    vc: 'VC-BLD-43',
    what: 'fillet_faces, cap of a cylinder R 5 H 10 against its curved wall, r 1: Pappus volume 2 pi ((R - r)(1 - pi/4) r^2 + r^3 / 6) removed, G1',
    value: { removedVolume: cylinderRimRemoved },
    tolerance: 1e-4,
    unit: 'mm3 (relative)',
    grade: 'A',
    source: '(b) Pappus on the corner spandrel',
    plan: 'target_face_sets',
    assert: 'mass_properties($cy) - mass_properties($f43); check_blends($f43)',
    proves: ['FR-BLD-13', 'TR-BLD-08'],
  },
  {
    vc: 'VC-BLD-44',
    what: 'fillet_faces, plate top against the wall of a boss R 10 (concave ring), r 2: the spandrel on the air side is ADDED, 2 pi ((R + r)(1 - pi/4) r^2 - r^3 / 6)',
    value: { addedVolume: bossRingAdded },
    tolerance: 1e-4,
    unit: 'mm3 (relative)',
    grade: 'A',
    source: '(b) Pappus on the corner spandrel, air side',
    plan: 'target_face_sets',
    assert: 'mass_properties($f44) - mass_properties($fu); check_blends($f44)',
    proves: ['FR-BLD-13', 'TR-BLD-08'],
  },
  {
    vc: 'VC-BLD-45',
    what: 'fillet_faces law r = 1 + t on the 20-long top edge of the 20 x 10 x 5 block: removed volume (1 - pi/4) L (r0^2 + r0 r1 + r1^2) / 3 (a sampled straight expression)',
    value: { removedVolume: lawRemoved },
    tolerance: 2e-5,
    unit: 'mm3 (relative)',
    grade: 'A',
    source: '(b) integral of (1 - pi/4) r(s)^2',
    plan: 'target_face_sets',
    assert: 'mass_properties($bl) - mass_properties($f45); check_blends($f45)',
    proves: ['FR-BLD-13', 'TR-BLD-08'],
  },
  {
    vc: 'VC-BLD-46',
    what: 'fillet_faces width sqrt 2 (chord between the contact lines) on a right-angle edge of the block = radius 1: removed volume (1 - pi/4) r^2 L',
    value: { removedVolume: widthRemoved },
    tolerance: 1e-6,
    unit: 'mm3 (relative)',
    grade: 'A',
    source: '(b) chord = 2 r cos(wedge / 2) = r sqrt 2',
    plan: 'target_face_sets',
    assert: 'mass_properties($bw) - mass_properties($f46)',
    proves: ['FR-BLD-13', 'TR-BLD-08'],
  },
  {
    vc: 'VC-BLD-47',
    what: 'fillet_faces refusals by name: a varying size over two shared edges, sets of faces that share no edge with several faces, and a shared edge whose tangent chain leaves the sets (the corner of a rounded cube: the x+ top edge is in neither set); the document is unchanged',
    value: { codes: ['BLD_FACE_BLEND_UNSUPPORTED', 'BLD_FACE_BLEND_UNSUPPORTED', 'BLD_FACE_BLEND_UNSUPPORTED'] },
    tolerance: 'exact',
    unit: '-',
    grade: 'A',
    source: 'definition (TECHNICAL_SPEC §13.13)',
    plan: 'target_face_sets',
    assert: 'the last three steps are rejected with the codes',
    proves: ['FR-BLD-13', 'TR-BLD-08'],
  },
];
// Measured on the native kernel (DES-6b, OCCT 7.9.2): what each gated case actually gave and where it misses the pack tolerance.
const MEASURED = {
  'VC-BLD-03': {
    measuredNative: {
      linear: { topFaceArea: 170.0, contactLineVsPolyline: 6.4e-15, volume: 989.985248, volumeVsSection: 2.6e-9 },
      smooth: { topFaceArea: 168.749 },
    },
    finding:
      'interpolation "linear" is the exact polyline (DES-6c step 6: Law_Linear pieces in the fillet spine, TECHNICAL_SPEC 13.15): the contact line is on it to 6.4e-15 (it was 8.6e-7 with the graded-node spline of DES-6b), the top face reads 170 and the side 70 to 1e-6 and the volume equals the closed form 989.985248 to 2.6e-12 relative. A kink is a C0 knot that BRepGProp\'s fixed Gauss rule misreads (989.991 / 169.9697 / 70.0303 before the fix), so a shape with a kinked straight law is read with the adaptive rule (Shape::refined_mass, 13.15.3); the +5.1e-3 "over the section value" of DES-6b was that quadrature error, not a construction offset. Default "smooth" interpolation overshoots between the control points (168.749).',
  },
  'VC-BLD-04': {
    measuredNative: { volume: 778.233, minusReference: 0.0054 },
    finding:
      'periodic expression law (33 samples, smooth periodic interpolation): within the pack band 0.01 (0.0054 above the generalised Pappus value).',
  },
  'VC-BLD-06': {
    measuredNative: { volume: 778.957, minusReference: -4e-4 },
    finding: 'chord on a plane-cylinder rim from the sampled wedge angle: r = 1, within 1e-3.',
  },
  'VC-BLD-18': {
    measuredNative: { symmetric: 995, asymmetric: 990.0, distanceAngle: 997.113249 },
    finding: 'AddDA angle is measured on the side-1 face: second leg d tan(angle).',
  },
  'VC-BLD-07a': {
    measuredNative: { volume: 993.646111 },
    finding:
      'conic profile by boolean cut of the corner spandrel prism (straight edges between planar faces): within 1e-3 of the closed form.',
  },
  'VC-BLD-09': {
    measuredNative: { volume: 998.0, contactOrder: 'G2', contactCurvature: '< 1e-6' },
    finding: 'quartic section: zero curvature at both contacts, measured G2 by check_blends.',
  },
  'VC-BLD-14': {
    measuredNative: { volume: 991.415927 },
    finding: 'fillet_faces across the chamfer: the spandrel of the virtual corner cut from the solid; the chamfer face is consumed.',
  },
  'VC-BLD-15': {
    measuredNative: { minimumRadius: 1.707107, message: 'about 1.707107' },
    finding: 'the smallest radius is found by bisection on "the arc stays in the material".',
  },
  'VC-BLD-16': {
    measuredNative: { volume: 765.663706, cylinderArea: 125.663706, cylinderRadius: 2 },
    finding: 'full round: clear above the axis, fuse the half-cylinder.',
  },
  'VC-BLD-17': {
    measuredNative: { topFaceArea: 170, sideFaceArea: 70, tolerance: 1e-6 },
    finding: 'hold line 1 -> 2: straight radius law on the shared edge (no kink), faces exact to 1e-6.',
  },
};
for (const c of cases) if (MEASURED[c.vc] !== undefined) Object.assign(c, MEASURED[c.vc]);
for (const c of cases) c.cli = { run: `llull run plans/${String(c.plan).split(' ')[0]}.json ${D}`, assert: c.assert };
writeFileSync(
  join(here, 'expected_results.json'),
  `${JSON.stringify({ gap: 'BLD', generated: '2026-10-22', notes: 'Values: (a) quoted, (b) derived (generate_blend_refs.mjs, data/*.json) or (c) TBD with the tool to measure. Only grade A gates pass/fail. Units: the plans use the default document unit (mm).', plans: planIndex, cases }, null, 1)}\n`,
);
process.stdout.write(`wrote ${cases.length} cases and ${planIndex.length} plans\n`);
