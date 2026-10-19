// SC-F2 / SC-F3 feature depth: thin extrude (open band, closed ring).
import { addCase } from './caseKit.mjs';
import { minus, prism } from './formulas.mjs';

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
    actions: [{ command: 'extrude_profile', params: { profile: [[0, 0], [10, 0], [10, 10]], openPath: true, depth: 5, thin: { thickness: 2, side: 'centre' } } }],
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
}
