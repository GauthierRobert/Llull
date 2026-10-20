// Fillets, chamfers and shells: the Manifold mesh kernel cannot build these (the commands no-op), so they only run on the exact OCCT kernel.
import { EXACT_ONLY, addCase } from './caseKit.mjs';
import { PI, part, sphere } from './formulas.mjs';

const Q = 1 - PI / 4; // area of the square minus the quarter disc, per r^2
/** Distance from the circle centre of the removed fillet sliver's centroid, per r: 1 / (6 (1 - pi/4)). */
const SLIVER = 1 / (6 * Q);

export function blendCases(out) {
  const make = (family, name, description, formula, actions, p, extra = {}) =>
    addCase(out, { family, name, description, formula, actions, p, kernels: EXACT_ONLY, ...extra });
  const a = { command: 'add_box', params: { size: [10, 10, 10] }, as: 'a' };

  // Constant fillet on one vertical edge of a 10-cube: removed volume (1 - pi/4) r^2 L.
  const r1 = 1;
  const removed1 = Q * r1 * r1 * 10;
  const c1 = 5 - r1 + r1 * SLIVER;
  make(
    'fillet',
    'fillet-box-one-edge',
    'r=1 fillet on one vertical edge of a 10-cube',
    'V = abc - (1 - pi/4) r^2 L; removed centroid at (a/2 - r + r/(6(1-pi/4)))',
    [a, { command: 'fillet_edge', params: { id: '$a', edgesNear: [[5, 5, 0]], radius: 1 } }],
    part(
      1000 - removed1,
      600 - (2 * r1 * 10 - (PI / 2) * r1 * 10 + 2 * Q * r1 * r1),
      [(-removed1 * c1) / (1000 - removed1), (-removed1 * c1) / (1000 - removed1), 0],
      [-5, -5, -5],
      [5, 5, 5],
    ),
  );

  const four = (r) => {
    const V = 20 * 10 * 5 - 4 * Q * r * r * 5;
    const A = 2 * (200 + 50 + 100) - 4 * (2 * r * 5 - (PI / 2) * r * 5 + 2 * Q * r * r);
    return part(V, A, [0, 0, 0], [-10, -5, -2.5], [10, 5, 2.5]);
  };
  make(
    'fillet',
    'fillet-box-four-vertical',
    'r=2 fillets on the four vertical edges of a 20x10x5 block',
    'V = abc - 4 (1 - pi/4) r^2 c',
    [
      { command: 'add_box', params: { size: [20, 10, 5] }, as: 'a' },
      {
        command: 'fillet_edge',
        params: {
          id: '$a',
          edgesNear: [
            [10, 5, 0],
            [-10, 5, 0],
            [10, -5, 0],
            [-10, -5, 0],
          ],
          radius: 2,
        },
      },
    ],
    four(2),
  );

  const rb = (a0, b0, c0, r) => {
    const [x, y, z] = [a0 - 2 * r, b0 - 2 * r, c0 - 2 * r];
    return part(
      x * y * z + 2 * r * (x * y + y * z + x * z) + PI * r * r * (x + y + z) + (4 / 3) * PI * r ** 3,
      2 * (x * y + y * z + x * z) + 2 * PI * r * (x + y + z) + 4 * PI * r * r,
      [0, 0, 0],
      [-a0 / 2, -b0 / 2, -c0 / 2],
      [a0 / 2, b0 / 2, c0 / 2],
    );
  };
  const allEdges = (size, r) => {
    const [x, y, z] = size.map((s) => s / 2);
    const edges = [];
    for (const sy of [-1, 1]) for (const sz of [-1, 1]) edges.push([0, sy * y, sz * z]);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) edges.push([sx * x, 0, sz * z]);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) edges.push([sx * x, sy * y, 0]);
    return [
      { command: 'add_box', params: { size }, as: 'a' },
      { command: 'fillet_edge', params: { id: '$a', edgesNear: edges, radius: r } },
    ];
  };
  make(
    'fillet',
    'fillet-cube-all-edges',
    'r=1 on all twelve edges of a 10-cube',
    'Steiner: V = x y z + 2r(xy+yz+xz) + pi r^2 (x+y+z) + 4/3 pi r^3, x = a - 2r',
    allEdges([10, 10, 10], 1),
    rb(10, 10, 10, 1),
  );
  make(
    'fillet',
    'fillet-block-all-edges',
    'r=2 on all twelve edges of a 20x12x8 block',
    'Steiner formula for a rounded box',
    allEdges([20, 12, 8], 2),
    rb(20, 12, 8, 2),
  );

  // Top rim of a cylinder: Pappus on the removed sliver, V = 2 pi [(R - r)(1 - pi/4) r^2 + r^3/6].
  const R = 5;
  const rr = 1;
  const slice = 2 * PI * ((R - rr) * Q * rr * rr + rr ** 3 / 6);
  const cylV = PI * R * R * 10;
  const cylA = 2 * PI * R * (R + 10);
  const arcRadius = R - rr + (2 * rr) / PI;
  const cylArea = cylA - PI * (R * R - (R - rr) ** 2) - 2 * PI * R * rr + ((PI * rr) / 2) * 2 * PI * arcRadius;
  make(
    'fillet',
    'fillet-cylinder-rim',
    'r=1 fillet on the top rim of a cylinder R=5 h=10',
    'Pappus: removed = 2 pi [(R - r)(1 - pi/4) r^2 + r^3/6]',
    [
      { command: 'add_cylinder', params: { radius: 5, height: 10 }, as: 'a' },
      { command: 'fillet_edge', params: { id: '$a', edgesNear: [[5, 0, 5]], radius: 1 } },
    ],
    part(cylV - slice, cylArea, [0, 0, (-slice * (5 - rr + rr * SLIVER)) / (cylV - slice)], [-5, -5, -5], [5, 5, 5]),
  );

  // Chamfers: removed prism is a right triangle d x d.
  const d = 1;
  const rem = (d * d * 10) / 2;
  const cc = 5 - d / 3;
  make(
    'chamfer',
    'chamfer-box-one-edge',
    'd=1 chamfer on one vertical edge of a 10-cube',
    'V = abc - d^2 L / 2; A = A0 - 2 d L + sqrt2 d L - d^2',
    [a, { command: 'chamfer_edge', params: { id: '$a', edgesNear: [[5, 5, 0]], distance: 1 } }],
    part(
      1000 - rem,
      600 - 2 * d * 10 + Math.SQRT2 * d * 10 - d * d,
      [(-rem * cc) / (1000 - rem), (-rem * cc) / (1000 - rem), 0],
      [-5, -5, -5],
      [5, 5, 5],
    ),
  );
  const dd = 2;
  make(
    'chamfer',
    'chamfer-box-four-vertical',
    'd=2 chamfers on the four vertical edges of a 20x10x5 block',
    'V = abc - 4 d^2 c / 2; A = A0 - 4 (2 d c - sqrt2 d c + d^2)',
    [
      { command: 'add_box', params: { size: [20, 10, 5] }, as: 'a' },
      {
        command: 'chamfer_edge',
        params: {
          id: '$a',
          edgesNear: [
            [10, 5, 0],
            [-10, 5, 0],
            [10, -5, 0],
            [-10, -5, 0],
          ],
          distance: 2,
        },
      },
    ],
    part(1000 - 4 * ((dd * dd * 5) / 2), 700 - 4 * (2 * dd * 5 - Math.SQRT2 * dd * 5 + dd * dd), [0, 0, 0], [-10, -5, -2.5], [10, 5, 2.5]),
  );

  // Shells.
  const open = (size, t) => {
    const [x, y, z] = size;
    const inner = (x - 2 * t) * (y - 2 * t) * (z - t);
    const A =
      2 * (x * y + y * z + x * z) -
      x * y +
      (x * y - (x - 2 * t) * (y - 2 * t)) +
      2 * (x - 2 * t) * (z - t) +
      2 * (y - 2 * t) * (z - t) +
      (x - 2 * t) * (y - 2 * t);
    return part(x * y * z - inner, A, [0, 0, (-inner * (t / 2)) / (x * y * z - inner)], [-x / 2, -y / 2, -z / 2], [x / 2, y / 2, z / 2]);
  };
  make(
    'shell',
    'shell-box-open-top',
    '10-cube hollowed to 1 mm walls, top face removed',
    'V = abc - (a-2t)(b-2t)(c-t)',
    [a, { command: 'shell_solid', params: { id: '$a', thickness: 1, openFacesNear: [[0, 0, 5]] } }],
    open([10, 10, 10], 1),
  );
  make(
    'shell',
    'shell-block-open-top',
    '20x10x6 block hollowed to 1.5 walls, top face removed',
    'V = abc - (a-2t)(b-2t)(c-t)',
    [
      { command: 'add_box', params: { size: [20, 10, 6] }, as: 'a' },
      { command: 'shell_solid', params: { id: '$a', thickness: 1.5, openFacesNear: [[0, 0, 3]] } },
    ],
    open([20, 10, 6], 1.5),
  );
  make(
    'shell',
    'shell-box-sealed',
    '10-cube with a sealed 8-cube cavity',
    'V = abc - (a-2t)^3; A = 6a^2 + 6(a-2t)^2',
    [a, { command: 'shell_solid', params: { id: '$a', thickness: 1 } }],
    part(1000 - 512, 600 + 384, [0, 0, 0], [-5, -5, -5], [5, 5, 5]),
  );
  make(
    'shell',
    'shell-sphere-sealed',
    'sphere R=5 with a sealed cavity of R=4',
    'V = 4/3 pi (R^3 - (R-t)^3); A = 4 pi (R^2 + (R-t)^2)',
    [
      { command: 'add_sphere', params: { radius: 5 }, as: 'a' },
      { command: 'shell_solid', params: { id: '$a', thickness: 1 } },
    ],
    part(sphere(5).v - sphere(4).v, sphere(5).a + sphere(4).a, [0, 0, 0], [-5, -5, -5], [5, 5, 5]),
  );
}
