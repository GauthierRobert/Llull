// SC-F3 fillets with per-edge radii and chord sizing. The Manifold mesh kernel cannot round edges, so they run on the exact OCCT kernel only.
import { EXACT_ONLY, addCase } from './caseKit.mjs';
import { PI, part } from './formulas.mjs';

const Q = 1 - PI / 4; // area of the square minus the quarter disc, per r^2
const SLIVER = 1 / (6 * Q); // centroid distance of the removed sliver from the circle centre, per r

export function filletDepthCases(out) {
  const [w, d, h] = [20, 10, 5];
  const box = { command: 'add_box', params: { size: [w, d, h] }, as: 'a' };
  const blockArea = 2 * (w * d + d * h + w * h);
  const perEdgeArea = (r) => 2 * r * h - (PI / 2) * r * h + 2 * Q * r * r;
  const corner = (r) => [w / 2 - r + r * SLIVER, d / 2 - r + r * SLIVER];
  const bbox = [
    [-w / 2, -d / 2, -h / 2],
    [w / 2, d / 2, h / 2],
  ];

  // Vertical edges at (+10,+5) with r=1 and (-10,-5) with r=2: each removes (1 - pi/4) r^2 h, centroid by moments.
  const [r1, r2] = [1, 2];
  const removed = [Q * r1 * r1 * h, Q * r2 * r2 * h];
  const volume = w * d * h - removed[0] - removed[1];
  const [c1, c2] = [corner(r1), corner(r2)];
  addCase(out, {
    family: 'fillet',
    name: 'fillet-per-edge-radii',
    description: 'two opposite vertical edges of a 20x10x5 block rounded with r=1 and r=2 in one fillet_edge call',
    formula: 'V = abc - sum (1 - pi/4) r_i^2 h; removed slivers centred (a/2 - r + r/(6(1-pi/4))) from the centre',
    actions: [
      box,
      {
        command: 'fillet_edge',
        params: {
          id: '$a',
          edges: [
            { near: [10, 5, 0], size: r1 },
            { near: [-10, -5, 0], size: r2 },
          ],
        },
      },
    ],
    kernels: EXACT_ONLY,
    p: part(
      volume,
      blockArea - perEdgeArea(r1) - perEdgeArea(r2),
      [(-removed[0] * c1[0] + removed[1] * c2[0]) / volume, (-removed[0] * c1[1] + removed[1] * c2[1]) / volume, 0],
      bbox[0],
      bbox[1],
    ),
  });

  // Chord c = 2 r cos(theta / 2) with theta = 90 deg gives r = c / sqrt 2: a chord of 2 sqrt 2 is the r=2 round of the four-edge case.
  addCase(out, {
    family: 'fillet',
    name: 'fillet-chord-four-vertical',
    description: 'chord-length fillets (chord 2 sqrt 2 = r 2 on right-angle edges) on the four vertical edges of a 20x10x5 block',
    formula: 'r = c / (2 cos(theta/2)) = c / sqrt 2 = 2; V = abc - 4 (1 - pi/4) r^2 h',
    actions: [
      box,
      {
        command: 'fillet_edge',
        params: {
          id: '$a',
          mode: 'chord',
          edgesNear: [
            [10, 5, 0],
            [-10, 5, 0],
            [10, -5, 0],
            [-10, -5, 0],
          ],
          radius: 2 * Math.SQRT2,
        },
      },
    ],
    kernels: EXACT_ONLY,
    p: part(w * d * h - 4 * Q * 4 * h, blockArea - 4 * perEdgeArea(2), [0, 0, 0], bbox[0], bbox[1]),
  });
}
