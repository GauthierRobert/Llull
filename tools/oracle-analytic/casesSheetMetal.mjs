// Sheet-metal parts (plugin sheetmetal): base flat + 90 degree edge flanges. Closed forms of the folded solid.
import { addCase } from './caseKit.mjs';
import { PI, part } from './formulas.mjs';

/** Quarter-annulus centroid distance from the bend centre along each axis: 4 (R^3 - r^3) / (3 pi (R^2 - r^2)). */
const quarterCentroid = (r, R) => (4 * (R ** 3 - r ** 3)) / (3 * PI * (R * R - r * r));

/**
 * L-bracket: flat base Lb (X) x W (Y) x T on z in [0, T] with a 90 degree flange up at x = Lb (bend tangent line on the picked edge),
 * leg length F measured to the outside mold line. bend = W (pi/4) ((R+T)^2 - R^2); leg = W T (F - (R + T)).
 */
function bracket(Lb, W, T, R, F, mirrored = false) {
  const Ro = R + T;
  const base = { v: Lb * T * W, c: [Lb / 2, W / 2, T / 2] };
  const bend = { v: W * (PI / 4) * (Ro * Ro - R * R), c: [Lb + quarterCentroid(R, Ro), W / 2, Ro - quarterCentroid(R, Ro)] };
  const legLength = F - Ro;
  const leg = { v: W * T * legLength, c: [Lb + R + T / 2, W / 2, Ro + legLength / 2] };
  const sections = [base, bend, leg];
  if (mirrored) {
    const flip = (s) => ({ v: s.v, c: [Lb - s.c[0], s.c[1], s.c[2]] });
    sections.push(flip(bend), flip(leg));
  }
  const v = sections.reduce((s, p) => s + p.v, 0);
  const c = [0, 1, 2].map((i) => sections.reduce((s, p) => s + p.v * p.c[i], 0) / v);
  // cross-section perimeter: base bottom + top, arcs, both sides of each leg, two free ends; area = perimeter x W + the two end faces
  const flanges = mirrored ? 2 : 1;
  const perimeter = 2 * Lb + flanges * ((PI / 2) * (R + Ro) + 2 * legLength) + 2 * T;
  const area = perimeter * W + 2 * (v / W);
  return { p: part(v, area, c, [mirrored ? -Ro : 0, 0, 0], [Lb + Ro, W, F]), legLength };
}

/** The folded solid is a mesh union that keeps the two coincident faces at each flat/bend junction, so mass_properties area is too large by 2 T W per junction. */

export function sheetMetalCases(out) {
  const rule = (name, thickness, insideRadius) => ({
    command: 'create_sheet_metal_rule',
    params: { name, material: '2024-T3', temper: 'T3', thickness, insideRadius, kFactor: 0.44 },
  });
  const baseActions = (name, Lb, W) => [
    { command: 'draw_rectangle', params: { width: Lb, height: W, position: [0, 0, 0] }, as: 'prof' },
    { command: 'add_sheet_metal_base', params: { profileId: '$prof', rule: name, side: 'up' }, as: 'part' },
  ];
  const flange = (near, F, angle = 90) => ({
    command: 'add_flange',
    params: { id: '$part', edge: { near }, angle, length: F, lengthReference: 'outside_mold_line', position: 'material_outside' },
  });
  const add = (name, description, formula, actions, p, extra = {}) =>
    addCase(out, { family: 'sheetmetal', name, description, formula, actions, p, stepRoundTrip: false, ...extra });
  const F = 'folded solid: V = W [Lb T + (pi/4)((R+T)^2 - R^2) + T (F - (R+T))]; area = perimeter x W + 2 section';

  add(
    'sheetmetal-flat-plate',
    'sheet-metal base flat 33.6x50, T=1.6',
    'V = Lb W T',
    [rule('R1', 1.6, 4.8), ...baseActions('R1', 33.6, 50)],
    part(33.6 * 50 * 1.6, 2 * (33.6 * 50 + 1.6 * 83.6), [16.8, 25, 0.8], [0, 0, 0], [33.6, 50, 1.6]),
  );
  const l1 = bracket(33.6, 50, 1.6, 4.8, 30);
  add(
    'sheetmetal-bracket-90',
    'L-bracket 33.6x50, T=1.6, R=4.8, flange 30 to the OML (the VC-FTR draft bracket)',
    F,
    [rule('R1', 1.6, 4.8), ...baseActions('R1', 33.6, 50), flange([33.6, 25, 0], 30)],
    l1.p,
    {
      mesh: { volume: null, area: 0.02, reason: 'area is summed over the display triangles of the tessellated bend' },
    },
  );
  const l2 = bracket(40, 30, 3, 2, 20);
  add(
    'sheetmetal-bracket-thick',
    'L-bracket 40x30, T=3, R=2, flange 20 to the OML',
    F,
    [rule('R2', 3, 2), ...baseActions('R2', 40, 30), flange([40, 15, 0], 20)],
    l2.p,
    {
      mesh: { volume: null, area: 0.02, reason: 'area is summed over the display triangles of the tessellated bend' },
    },
  );
  const l3 = bracket(60, 25, 1, 1, 15);
  add(
    'sheetmetal-bracket-tight',
    'L-bracket 60x25, T=1, R=1, flange 15 to the OML',
    F,
    [rule('R3', 1, 1), ...baseActions('R3', 60, 25), flange([60, 12.5, 0], 15)],
    l3.p,
    {
      mesh: { volume: null, area: 0.02, reason: 'area is summed over the display triangles of the tessellated bend' },
    },
  );
  const u = bracket(33.6, 50, 1.6, 4.8, 30, true);
  add(
    'sheetmetal-channel-u',
    'U-channel: two 90 degree flanges (30 to the OML) on opposite edges of a 33.6x50 base',
    F,
    [rule('R1', 1.6, 4.8), ...baseActions('R1', 33.6, 50), flange([33.6, 25, 0], 30), flange([0, 25, 0], 30)],
    u.p,
    {
      mesh: { volume: null, area: 0.02, reason: 'area is summed over the display triangles of the tessellated bends' },
    },
  );
  // 45 degree flange: bend sector 45 degrees, leg = F - (R+T) tan(22.5 deg); only the volume is checked.
  const T = 1.6;
  const R = 4.8;
  const Ro = R + T;
  const alpha = PI / 4;
  const leg45 = 30 - Ro * Math.tan(alpha / 2);
  add(
    'sheetmetal-flange-45',
    'base 33.6x50 with a 45 degree flange, 30 to the OML (setback (R+T) tan(22.5))',
    'V = W [Lb T + (alpha/2)((R+T)^2 - R^2) + T (F - (R+T) tan(alpha/2))]',
    [rule('R1', T, R), ...baseActions('R1', 33.6, 50), flange([33.6, 25, 0], 30, 45)],
    { ...part(50 * (33.6 * T + (alpha / 2) * (Ro * Ro - R * R) + T * leg45), null, [0, 0, 0], null, null) },
    { centroid: false, area: null },
  );
}
