// SC-F2 / SC-F3 feature depth: thin extrude (open band, closed ring), holes on sketch points, ISO threads, coils.
import { addCase, cylTol, mesh } from './caseKit.mjs';
import { PI, box, minus, part, prism } from './formulas.mjs';

const rect = (w, h, x = 0, y = 0) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

export function featureDepthCases(out) {
  // Open L path (0,0)-(10,0)-(10,10), wall 2 centred, mitred corner: left offset (0,1)(9,1)(9,10), right offset (0,-1)(11,-1)(11,10).
  const band = [
    [0, 1],
    [9, 1],
    [9, 10],
    [11, 10],
    [11, -1],
    [0, -1],
  ];
  addCase(out, {
    family: 'thin',
    name: 'thin-open-l-band',
    description: 'open L path (10+10 long) thickened 2 centred, extruded 5',
    formula: 'band polygon from the mitred offsets (shoelace): A = t (L1 + L2) = 40; V = A depth; A_surf = 2A + perimeter depth',
    actions: [
      {
        command: 'extrude_profile',
        params: {
          profile: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
          openPath: true,
          depth: 5,
          thin: { thickness: 2, side: 'centre' },
        },
      },
    ],
    p: prism(band, 5),
  });
  // Closed 20x10 rectangle, wall 2 inside: ring = outer rectangle minus the inner [2,18]x[2,8].
  const outer = prism(rect(20, 10), 4);
  const inner = prism(rect(16, 6, 2, 2), 4);
  addCase(out, {
    family: 'thin',
    name: 'thin-closed-ring-inside',
    description: 'closed 20x10 rectangle with a 2 wall growing inside, extruded 4',
    formula: 'V = (A_outer - A_inner) depth = (200 - 96) 4; A_surf = 2 (A_outer - A_inner) + (P_outer + P_inner) depth',
    actions: [{ command: 'extrude_profile', params: { profile: rect(20, 10), depth: 4, thin: { thickness: 2, side: 'inside' } } }],
    p: minus(outer, inner, 2 * (200 - 96) + (60 + 44) * 4),
  });
  addCase(out, {
    family: 'thin',
    name: 'thin-closed-ring-outside',
    description: 'closed 20x10 rectangle with a 2 wall growing outside, extruded 4',
    formula: 'outer 24x14 at (-2,-2), inner = the profile: V = (336 - 200) 4; A_surf = 2 (336 - 200) + (76 + 60) 4',
    actions: [{ command: 'extrude_profile', params: { profile: rect(20, 10), depth: 4, thin: { thickness: 2, side: 'outside' } } }],
    p: minus(prism(rect(24, 14, -2, -2), 4), prism(rect(20, 10), 4), 2 * (336 - 200) + (76 + 60) * 4),
  });

  // Plate 20x20x4 centred on the origin (top face z = 2): four d=3 through holes at the vertices of a sketch (2 point entities + a polyline).
  const [radius, height, plateVolume, plateArea] = [1.5, 4, 20 * 20 * 4, 1120];
  const holeVolume = PI * radius * radius * height;
  const WHY_BORE =
    'bore tessellated as an inscribed n-gon (n from the kernel default circle resolution): loss <= k (1 - cos(pi/n)) of the removed share';
  const frac = (4 * holeVolume) / (plateVolume - 4 * holeVolume);
  addCase(out, {
    family: 'hole',
    name: 'hole-on-sketch-points',
    description:
      'four d=3 through holes in a 20x20x4 plate placed on 2 point entities and the 2 vertices of a polyline sketched on the top face',
    formula: 'V = abc - 4 pi r^2 h; A = A0 + 4 (2 pi r h - 2 pi r^2)',
    actions: [
      { command: 'add_box', params: { size: [20, 20, 4] }, as: 'p' },
      { command: 'draw_point', params: { position: [5, 5, 2] }, as: 'a' },
      { command: 'draw_point', params: { position: [-5, -5, 2] }, as: 'b' },
      {
        command: 'draw_polyline',
        params: {
          position: [0, 0, 2],
          points: [
            [-5, 5],
            [5, -5],
          ],
        },
        as: 'c',
      },
      {
        command: 'add_hole',
        params: {
          target: '$p',
          face: { near: [0, 0, 2] },
          points: { sketchEntityIds: ['$a', '$b', '$c'] },
          hole: { kind: 'simple', diameter: 3 },
          extent: { kind: 'through_all' },
        },
      },
    ],
    p: part(
      plateVolume - 4 * holeVolume,
      plateArea + 4 * (2 * PI * radius * height - 2 * PI * radius * radius),
      [0, 0, 0],
      box([20, 20, 4]).min,
      box([20, 20, 4]).max,
    ),
    mesh: mesh(1e-3 + cylTol(radius, frac), 1e-3 + cylTol(radius, 0.3), WHY_BORE),
  });
}
