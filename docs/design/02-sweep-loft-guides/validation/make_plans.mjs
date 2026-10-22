// SWG build_project plans (Node ESM, no dependencies):  node make_plans.mjs  -> validation/plans/*.json
// baseline_*.json uses only commands and params that exist today; target_*.json use the commands / params proposed in TECHNICAL_SPEC §4
// (listed in validation/proposed_steps.json - plan, step index, command - so tests/unit/contract/blockedPlanCommands.json can list them until built).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'plans');
mkdirSync(out, { recursive: true });
const PI = Math.PI;
const r6 = (x) => Number(x.toFixed(9));

// Exact rational quadratic circle (9 poles, seam at angle a0) in the plane z = zc, as create_nurbs_curve params.
function nurbsCircle(radius, zc, a0 = 0) {
  const w = Math.SQRT1_2;
  const base = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
  ];
  const poles = base.map(([x, y]) => [
    r6(radius * (x * Math.cos(a0) - y * Math.sin(a0))),
    r6(radius * (x * Math.sin(a0) + y * Math.cos(a0))),
    zc,
  ]);
  return {
    degree: 2,
    poles,
    weights: [1, w, 1, w, 1, w, 1, w, 1].map(r6),
    knots: [0, 0.25, 0.5, 0.75, 1],
    multiplicities: [3, 2, 2, 2, 3],
  };
}
const step = (command, params, as, proposed = false) => ({
  command,
  params,
  ...(as ? { as } : {}),
  ...(proposed ? { [PROPOSED]: true } : {}),
});
const PROPOSED = Symbol('proposed');
const P = true;

const plans = {
  // ---------- runs on today's llull ----------
  baseline_today_sweeps_lofts: [
    step('set_units', { units: 'mm' }),
    step('draw_arc', { center: [0, 0], radius: 50 }, 'torusPath'),
    step('sweep_profile', { pathId: '$torusPath', radius: 10 }, 'torus'),
    step('mass_properties', { entityId: '$torus' }),
    step(
      'sweep_profile',
      {
        path: [
          [200, 0, 0],
          [200, 0, 100],
        ],
        stations: [
          { at: 0, radius: 10 },
          { at: 1, radius: 5 },
        ],
      },
      'taper',
    ),
    step('mass_properties', { entityId: '$taper' }),
    step(
      'loft_sections',
      {
        sections: [
          { center: [400, 0, 0], radius: 10 },
          { center: [400, 0, 50], radius: 5 },
        ],
        ruled: true,
      },
      'frustum',
    ),
    step('mass_properties', { entityId: '$frustum' }),
    step('add_coil', { radius: 20, pitch: 10, turns: 3, sectionRadius: 2, position: [600, 0, 0] }, 'coil'),
    step('mass_properties', { entityId: '$coil' }),
    step(
      'sweep_profile',
      {
        path: [
          [0, 300, 0],
          [100, 300, 0],
          [100, 400, 0],
        ],
        radius: 5,
        bendRadius: 30,
      },
      'elbow',
    ),
    step('mass_properties', { entityId: '$elbow' }),
  ],

  // ---------- twist, scale, area, orientation ----------
  target_twist_scale_orientation: [
    step('set_units', { units: 'mm' }),
    step(
      'sweep_profile',
      {
        path: [
          [0, 0, 0],
          [0, 0, 100],
        ],
        section: [
          [-5, -5],
          [5, -5],
          [5, 5],
          [-5, 5],
        ],
        twist: { type: 'linear', start: 0, end: PI / 2 },
      },
      'bar90',
      P,
    ),
    step('mass_properties', { entityId: '$bar90' }),
    step(
      'sweep_profile',
      {
        path: [
          [30, 0, 0],
          [30, 0, 100],
        ],
        section: [
          [-5, -5],
          [5, -5],
          [5, 5],
          [-5, 5],
        ],
        twistTurns: 1,
      },
      'bar360',
      P,
    ),
    step('mass_properties', { entityId: '$bar360' }),
    step(
      'sweep_profile',
      {
        path: [
          [60, 0, 0],
          [60, 0, 100],
        ],
        section: [
          [-5, -5],
          [5, -5],
          [5, 5],
          [-5, 5],
        ],
        twist: { type: 's_curve', start: 0, end: PI },
      },
      'barS',
      P,
    ),
    step('mass_properties', { entityId: '$barS' }),
    step(
      'sweep_profile',
      {
        path: [
          [90, 0, 0],
          [90, 0, 100],
        ],
        radius: 10,
        scale: { type: 'linear', start: 1, end: 0.5 },
      },
      'cone',
      P,
    ),
    step('mass_properties', { entityId: '$cone' }),
    step(
      'sweep_profile',
      {
        path: [
          [120, 0, 0],
          [120, 0, 100],
        ],
        radius: 10,
        scale: { type: 'expression', expression: '1 + 0.25*sin(2*pi*t)' },
      },
      'wavy',
      P,
    ),
    step('mass_properties', { entityId: '$wavy' }),
    step(
      'sweep_profile',
      {
        path: [
          [150, 0, 0],
          [150, 0, 100],
        ],
        section: [
          [-5, -5],
          [5, -5],
          [5, 5],
          [-5, 5],
        ],
        area: { type: 'linear', start: 100, end: 25 },
      },
      'areaLaw',
      P,
    ),
    step('mass_properties', { entityId: '$areaLaw' }),
    step(
      'sweep_profile',
      {
        path: [
          [200, 0, 0],
          [200, 0, 100],
        ],
        stations: [
          { at: 0, radius: 10 },
          { at: 1, radius: 5 },
        ],
        stationBlend: 'linear',
      },
      'linearStations',
      P,
    ),
    step('mass_properties', { entityId: '$linearStations' }),
    step('draw_arc', { center: [0, 0], radius: 50, startAngle: 0, endAngle: PI / 2, position: [0, 300, 0] }, 'arcPath'),
    step(
      'sweep_profile',
      {
        pathId: '$arcPath',
        section: [
          [-5, -5],
          [5, -5],
          [5, 5],
          [-5, 5],
        ],
        scale: { type: 'linear', start: 1, end: 0.5 },
      },
      'vane',
      P,
    ),
    step('mass_properties', { entityId: '$vane' }),
    step(
      'sweep_profile',
      {
        path: [
          [300, 0, 0],
          [370.710678119, 0, 70.710678119],
        ],
        radius: 10,
        orientation: { mode: 'fixed' },
      },
      'oblique',
      P,
    ),
    step('mass_properties', { entityId: '$oblique' }),
    step('inspect_sweep', { id: '$vane', samples: 21 }, undefined, P),
    step(
      'check_sweep_loft',
      { ids: ['$bar90', '$bar360', '$barS', '$cone', '$wavy', '$areaLaw', '$linearStations', '$vane', '$oblique'] },
      undefined,
      P,
    ),
  ],

  // ---------- helices, springs, screw sweeps ----------
  target_helix_spring_thread: [
    step('set_units', { units: 'mm' }),
    step('add_helix', { position: [0, 0, 0], axis: [0, 0, 1], radius: 20, pitch: 10, turns: 3 }, 'helix', P),
    step('sweep_profile', { pathId: '$helix', radius: 2 }, 'tube', P),
    step('mass_properties', { entityId: '$tube' }),
    step('inspect_sweep', { id: '$tube', samples: 31 }, undefined, P),
    step(
      'sweep_profile',
      {
        pathId: '$helix',
        section: [
          [18, -1.5],
          [22, -1.5],
          [22, 1.5],
          [18, 1.5],
        ],
        sectionFrame: 'axial',
        orientation: { mode: 'axis_plane', axisPoint: [0, 0, 0], direction: [0, 0, 1] },
      },
      'screw10',
      P,
    ),
    step('mass_properties', { entityId: '$screw10' }),
    step('add_helix', { position: [100, 0, 0], axis: [0, 0, 1], radius: 20, pitch: 5, turns: 3 }, 'helix5', P),
    step(
      'sweep_profile',
      {
        pathId: '$helix5',
        section: [
          [18, -1.5],
          [22, -1.5],
          [22, 1.5],
          [18, 1.5],
        ],
        sectionFrame: 'axial',
        orientation: { mode: 'axis_plane', axisPoint: [100, 0, 0], direction: [0, 0, 1] },
      },
      'screw5',
      P,
    ),
    step('mass_properties', { entityId: '$screw5' }),
    step('add_helix', { position: [200, 0, 0], axis: [0, 0, 1], radius: 20, endRadius: 10, pitch: 10, turns: 5 }, 'cone', P),
    step('sweep_profile', { pathId: '$cone', radius: 1 }, 'conicalTube', P),
    step('mass_properties', { entityId: '$conicalTube' }),
    step('add_coil', { radius: 20, pitch: 10, turns: 3, sectionRadius: 2, position: [300, 0, 0], exactHelix: true }, 'coil', P),
    step('mass_properties', { entityId: '$coil' }),
    step(
      'add_helix',
      {
        position: [400, 0, 0],
        axis: [0, 0, 1],
        radius: 15,
        turns: 8,
        pitchLaw: {
          type: 'table',
          points: [
            [0, 2],
            [0.125, 2],
            [0.2, 6],
            [0.8, 6],
            [0.875, 2],
            [1, 2],
          ],
        },
      },
      'springPath',
      P,
    ),
    step('sweep_profile', { pathId: '$springPath', radius: 0.9 }, 'spring', P),
    step('check_sweep_loft', { ids: ['$tube', '$screw10', '$screw5', '$conicalTube', '$coil', '$spring'] }, undefined, P),
  ],

  // ---------- rails and surface orientation ----------
  target_rails_and_surface_mode: [
    step('set_units', { units: 'mm' }),
    step(
      'interpolate_curve',
      {
        points: [
          [0, 10, 0],
          [100, 5, 0],
        ],
        degree: 1,
      },
      'railA',
    ),
    step(
      'interpolate_curve',
      {
        points: [
          [0, -10, 0],
          [100, -5, 0],
        ],
        degree: 1,
      },
      'railB',
    ),
    step(
      'sweep_profile',
      {
        guideIds: ['$railA', '$railB'],
        guideMode: 'scale',
        radius: 10,
        anchors: [
          [10, 0],
          [-10, 0],
        ],
      },
      'twoRail',
      P,
    ),
    step('mass_properties', { entityId: '$twoRail' }),
    step(
      'sweep_profile',
      {
        guideIds: ['$railA', '$railB'],
        guideMode: 'scale',
        maintainHeight: true,
        radius: 10,
        anchors: [
          [10, 0],
          [-10, 0],
        ],
      },
      'twoRailHeight',
      P,
    ),
    step('mass_properties', { entityId: '$twoRailHeight' }),
    step(
      'interpolate_curve',
      {
        points: [
          [200, 0, 0],
          [200, 0, 100],
        ],
        degree: 1,
      },
      'spine',
    ),
    step(
      'interpolate_curve',
      {
        points: [
          [210, 0, 0],
          [205, 0, 100],
        ],
        degree: 1,
      },
      'rail1',
    ),
    step('sweep_profile', { pathId: '$spine', guideIds: ['$rail1'], guideMode: 'scale', radius: 10, anchors: [[10, 0]] }, 'oneRail', P),
    step('mass_properties', { entityId: '$oneRail' }),
    step('add_helix', { position: [0, 300, 0], axis: [0, 0, 1], radius: 10, pitch: 20, turns: 2 }, 'h1', P),
    step('add_helix', { position: [0, 300, 0], axis: [0, 0, 1], radius: 10, pitch: 20, turns: 2, startAngleRad: PI }, 'h2', P),
    step(
      'sweep_surface',
      {
        guideIds: ['$h1', '$h2'],
        section: {
          line: [
            [10, 0],
            [-10, 0],
          ],
        },
        guideMode: 'scale',
        anchors: [
          [10, 0],
          [-10, 0],
        ],
      },
      'helicoid',
      P,
    ),
    step('measure_area', { entityId: '$helicoid' }),
    step('check_sweep_loft', { ids: ['$twoRail', '$twoRailHeight', '$oneRail', '$helicoid'] }, undefined, P),
  ],

  // ---------- loft end conditions, alignment, closed / centreline ----------
  target_loft_conditions_alignment: [
    step('set_units', { units: 'mm' }),
    step('create_nurbs_curve', nurbsCircle(10, 0), 'c0'),
    step('create_nurbs_curve', nurbsCircle(5, 50), 'c1'),
    step(
      'loft_sections',
      { sectionIds: ['$c0', '$c1'], startCondition: { type: 'normal', magnitude: 1 }, endCondition: { type: 'normal', magnitude: 1 } },
      'bottle',
      P,
    ),
    step('mass_properties', { entityId: '$bottle' }),
    step(
      'loft_sections',
      { sectionIds: ['$c0', '$c1'], startCondition: { type: 'normal', magnitude: 2 }, endCondition: { type: 'normal', magnitude: 2 } },
      'bottle2',
      P,
    ),
    step('mass_properties', { entityId: '$bottle2' }),
    step('create_nurbs_curve', { ...nurbsCircle(10, 0), position: [100, 0, 0] }, 'd0'),
    step('create_nurbs_curve', { ...nurbsCircle(10, 50, PI / 2), position: [100, 0, 0] }, 'd1'),
    step('loft_sections', { sectionIds: ['$d0', '$d1'], ruled: true, alignment: 'none' }, 'hyperboloid90', P),
    step('mass_properties', { entityId: '$hyperboloid90' }),
    step('loft_sections', { sectionIds: ['$d0', '$d1'], ruled: true, alignment: 'auto' }, 'cylinderAligned', P),
    step('mass_properties', { entityId: '$cylinderAligned' }),
    step('draw_arc', { center: [0, 0], radius: 50, startAngle: 0, endAngle: PI / 2, position: [300, 0, 0] }, 'centreline'),
    step(
      'loft_sections',
      {
        sections: [
          { center: [350, 0, 0], rotation: [PI / 2, 0, 0], radius: 10 },
          { center: [300, 50, 0], rotation: [PI / 2, 0, PI / 2], radius: 10 },
        ],
        centerlineId: '$centreline',
        sectionCount: 16,
      },
      'elbowLoft',
      P,
    ),
    step('mass_properties', { entityId: '$elbowLoft' }),
    step('check_sweep_loft', { ids: ['$bottle', '$bottle2', '$hyperboloid90', '$cylinderAligned', '$elbowLoft'] }, undefined, P),
  ],

  // ---------- network, ruled, developable ----------
  target_network_ruled: [
    step('set_units', { units: 'mm' }),
    // sections x = 0, 0.5, 1 of z = sin(pi x) + y^3 (exact cubics in y), guides y = 0, 0.5, 1 (sin in x, interpolated through 41 points)
    ...[0, 0.5, 1].map((x, i) =>
      step(
        'interpolate_curve',
        {
          points: Array.from({ length: 5 }, (_, k) => {
            const y = k / 4;
            return [x, y, r6(Math.sin(PI * x) + y ** 3)];
          }),
        },
        `s${i}`,
      ),
    ),
    ...[0, 0.5, 1].map((y, j) =>
      step(
        'interpolate_curve',
        {
          points: Array.from({ length: 41 }, (_, k) => {
            const x = k / 40;
            return [x, y, r6(Math.sin(PI * x) + y ** 3)];
          }),
        },
        `g${j}`,
      ),
    ),
    step('loft_surface', { sectionIds: ['$s0', '$s1', '$s2'], guideIds: ['$g0', '$g1', '$g2'] }, 'gordon'),
    step('network_surface', { curveIds: ['$g1', '$s2', '$g0', '$s0', '$g2', '$s1'] }, 'network', P),
    step('measure_deviation', {
      id: '$network',
      points: Array.from({ length: 121 }, (_, k) => {
        const x = (k % 11) / 10;
        const y = Math.floor(k / 11) / 10;
        return [x, y, r6(Math.sin(PI * x) + y ** 3)];
      }),
    }),
    step(
      'interpolate_curve',
      {
        points: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        degree: 1,
        position: [10, 0, 0],
      },
      'e0',
    ),
    step(
      'interpolate_curve',
      {
        points: [
          [0, 1, 0],
          [1, 1, 1],
        ],
        degree: 1,
        position: [10, 0, 0],
      },
      'e1',
    ),
    step('ruled_surface', { curveIds: ['$e0', '$e1'], coupling: 'parameter' }, 'hypar', P),
    step('measure_area', { entityId: '$hypar' }),
    step('analyze_surface_curvature', { id: '$hypar', samples: [[0.5, 0.5]] }),
    step('create_nurbs_curve', { ...nurbsCircle(10, 0), position: [100, 0, 0] }, 'f0'),
    step('create_nurbs_curve', { ...nurbsCircle(5, 50), position: [100, 0, 0] }, 'f1'),
    step('ruled_surface', { curveIds: ['$f0', '$f1'], coupling: 'developable' }, 'frustumSheet', P),
    step('measure_area', { entityId: '$frustumSheet' }),
    step('check_sweep_loft', { ids: ['$network', '$hypar', '$frustumSheet'] }, undefined, P),
  ],

  // ---------- refusals: every step must fail with its documented code ----------
  bad_refusals: [
    step('set_units', { units: 'mm' }),
    step('draw_arc', { center: [0, 0], radius: 5 }, 'tight'),
    step('sweep_profile', { pathId: '$tight', radius: 6 }, undefined), // SWG_SELF_INTERSECTION_LOCAL (today: plain no-op message)
    step('draw_arc', { center: [0, 0], radius: 50 }, 'ring'),
    step(
      'sweep_profile',
      {
        pathId: '$ring',
        section: [
          [-5, -5],
          [5, -5],
          [5, 5],
          [-5, 5],
        ],
        twist: { type: 'linear', start: 0, end: 1.745329252 },
      },
      undefined,
      P,
    ), // SWG_CLOSED_TWIST_NOT_PERIODIC
    step(
      'sweep_profile',
      {
        path: [
          [0, 0, 0],
          [0, 0, 100],
        ],
        radius: 5,
        orientation: { mode: 'frenet' },
      },
      undefined,
      P,
    ), // SWG_FRAME_DEGENERATE
    step('add_helix', { radius: 10, pitch: 3, turns: 4 }, 'hx', P),
    step(
      'sweep_profile',
      {
        pathId: '$hx',
        section: [
          [8, -2],
          [12, -2],
          [12, 2],
          [8, 2],
        ],
        sectionFrame: 'axial',
        orientation: { mode: 'axis_plane', direction: [0, 0, 1] },
      },
      undefined,
      P,
    ), // SWG_SELF_INTERSECTION_GLOBAL (axial extent 4 >= pitch 3)
    step(
      'sweep_profile',
      {
        path: [
          [0, 0, 0],
          [0, 0, 100],
        ],
        radius: 5,
        scale: { type: 'linear', start: 1, end: -0.5 },
      },
      undefined,
      P,
    ), // SWG_LAW_NONPOSITIVE
    step(
      'sweep_profile',
      {
        path: [
          [0, 0, 0],
          [0, 0, 100],
        ],
        radius: 5,
        twist: {
          type: 'table',
          points: [
            [0, 0],
            [0.5, 1],
            [0.4, 2],
          ],
        },
      },
      undefined,
      P,
    ), // SWG_LAW_INVALID
  ],
};

for (const [name, plan] of Object.entries(plans)) writeFileSync(join(out, `${name}.json`), `${JSON.stringify(plan, null, 1)}\n`);
const proposed = Object.fromEntries(
  Object.entries(plans).map(([name, plan]) => [name, plan.flatMap((s, index) => (s[PROPOSED] ? [{ index, command: s.command }] : []))]),
);
writeFileSync(join(here, 'proposed_steps.json'), `${JSON.stringify(proposed, null, 1)}\n`);
process.stdout.write(`wrote ${Object.keys(plans).length} plans to ${out}\n`);
