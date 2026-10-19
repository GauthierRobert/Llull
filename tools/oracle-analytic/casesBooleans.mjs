// Boolean unions / differences / intersections with closed-form results.
import { addCase, cylTol, mesh } from './caseKit.mjs';
import { PI, box, capVolume, cylinder, lensVolume, part, sphere, union } from './formulas.mjs';

const BASE = 1e-3;
const SPHERE = 0.03;
const WHY_CYL =
  'inscribed n-gon cross-section of the cylinder (n from the kernel default circle resolution): loss <= k (1 - cos(pi/n)) of the feature share';
const WHY_SPH = 'sphere tessellated at 32 segments: volume loss <= 3 % of the sphere share (measured about 2 %)';

export function booleanCases(out) {
  const cases = (name, description, formula, actions, p, extra = {}) =>
    addCase(out, { family: 'boolean', name, description, formula, actions, p, ...extra });
  const addBox = (as, size, position) => ({ command: 'add_box', params: { size, ...(position ? { position } : {}) }, as });
  const addCyl = (as, radius, height, params = {}) => ({ command: 'add_cylinder', params: { radius, height, ...params }, as });
  const addSphere = (as, radius, position) => ({ command: 'add_sphere', params: { radius, ...(position ? { position } : {}) }, as });
  const op = (kind, a = '$a', b = '$b') => ({ command: 'boolean', params: { op: kind, a, b } });

  cases(
    'union-boxes-disjoint',
    'two disjoint 2-cubes 5 apart',
    'V = V1 + V2; A = A1 + A2',
    [addBox('a', [2, 2, 2]), addBox('b', [2, 2, 2], [5, 0, 0]), op('union')],
    union([box([2, 2, 2]), box([2, 2, 2], [5, 0, 0])]),
  );
  cases(
    'union-boxes-touching',
    'two 2-cubes sharing a face',
    'V = 16; A = 2*24 - 2*4',
    [addBox('a', [2, 2, 2]), addBox('b', [2, 2, 2], [2, 0, 0]), op('union')],
    { ...union([box([2, 2, 2]), box([2, 2, 2], [2, 0, 0])]), a: 40 },
  );
  cases(
    'union-boxes-overlap',
    '2-cubes overlapping on a unit cube',
    'V = 8 + 8 - 1 = 15; A = 24 - 3 + 24 - 3',
    [addBox('a', [2, 2, 2]), addBox('b', [2, 2, 2], [1, 1, 1]), op('union')],
    part(15, 42, [0.5, 0.5, 0.5], [-1, -1, -1], [2, 2, 2]),
  );
  cases(
    'subtract-boxes-overlap',
    'A - B with B overlapping a unit cube corner of A',
    'V = 8 - 1 = 7; A = 21 + 3',
    [addBox('a', [2, 2, 2]), addBox('b', [2, 2, 2], [1, 1, 1]), op('subtract')],
    part(7, 24, [-0.5 / 7, -0.5 / 7, -0.5 / 7], [-1, -1, -1], [1, 1, 1]),
  );
  cases(
    'intersect-boxes-overlap',
    'A and B intersect in the unit cube [0,1]^3',
    'V = 1; A = 6',
    [addBox('a', [2, 2, 2]), addBox('b', [2, 2, 2], [1, 1, 1]), op('intersect')],
    box([1, 1, 1], [0.5, 0.5, 0.5]),
  );
  cases(
    'subtract-disjoint',
    'subtracting a distant box leaves A unchanged',
    'V = V(A)',
    [addBox('a', [2, 3, 4]), addBox('b', [1, 1, 1], [10, 0, 0]), op('subtract')],
    box([2, 3, 4]),
  );
  cases(
    'subtract-inner-cavity',
    'a 4-cube cut out of the middle of a 10-cube leaves a sealed void',
    'V = 1000 - 64; A = 600 + 96',
    [addBox('a', [10, 10, 10]), addBox('b', [4, 4, 4]), op('subtract')],
    part(936, 696, [0, 0, 0], [-5, -5, -5], [5, 5, 5]),
  );
  cases(
    'subtract-groove',
    'plate 20x10x4 with a 4-wide groove 1 deep',
    'V = 800 - 40; A = 640 - 40 + 40 + 20 - 8 (the groove also notches both end faces)',
    [addBox('a', [20, 10, 4]), addBox('b', [4, 20, 2], [0, 0, 2]), op('subtract')],
    part(760, 652, [0, 0, (-40 * 1.5) / 760], [-10, -5, -2], [10, 5, 2]),
  );
  cases(
    'union-boxes-tee',
    'T shape: 6x2x2 bar joined by a 2x4x2 stem overlapping a 2x1x2 block',
    'V = 24 + 16 - 4 = 36; A = (56 - 8) + (40 - 8)',
    [addBox('a', [6, 2, 2]), addBox('b', [2, 4, 2], [0, -2, 0]), op('union')],
    part(36, 80, [0, (0 * 24 + -2 * 16 - -0.5 * 4) / 36, 0], [-3, -4, -1], [3, 1, 1]),
  );

  const tube = (r, R, h) => PI * (R * R - r * r) * h;
  cases(
    'subtract-hole-through-box',
    'box 20x20x10 drilled by a vertical cylinder r=4',
    'V = abc - pi r^2 h; A = 2(ab+bc+ca) - 2 pi r^2 + 2 pi r h',
    [addBox('a', [20, 20, 10]), addCyl('b', 4, 20), op('subtract')],
    part(4000 - PI * 16 * 10, 1600 - 2 * PI * 16 + 2 * PI * 4 * 10, [0, 0, 0], [-10, -10, -5], [10, 10, 5]),
    { mesh: mesh(BASE + cylTol(4, (PI * 160) / 3497), BASE + cylTol(4, 0.3), WHY_CYL) },
  );
  cases(
    'union-box-cylinder',
    'box 10-cube pierced and extended by a vertical cylinder r=3 h=20',
    'V = 1000 + pi r^2 (20 - 10); A = 600 - 2 pi r^2 + 2 pi r 10 + 2 pi r^2',
    [addBox('a', [10, 10, 10]), addCyl('b', 3, 20), op('union')],
    part(1000 + PI * 9 * 10, 600 + 2 * PI * 3 * 10, [0, 0, 0], [-5, -5, -10], [5, 5, 10]),
    { mesh: mesh(BASE + cylTol(3, 0.35), BASE + cylTol(3, 0.25), WHY_CYL) },
  );
  cases(
    'intersect-box-cylinder',
    'cylinder r=4 h=20 cut to a 10-cube slab',
    'V = pi r^2 * 10; A = 2 pi r^2 + 2 pi r 10',
    [addBox('a', [10, 10, 10]), addCyl('b', 4, 20), op('intersect')],
    part(PI * 16 * 10, 2 * PI * 16 + 2 * PI * 4 * 10, [0, 0, 0], [-4, -4, -5], [4, 4, 5]),
    { mesh: mesh(BASE + cylTol(4, 1), BASE + cylTol(4, 1), WHY_CYL) },
  );
  cases(
    'intersect-steinmetz',
    'two perpendicular cylinders r=3 intersect in a Steinmetz solid',
    'V = 16 r^3 / 3; A = 16 r^2',
    [addCyl('a', 3, 20), addCyl('b', 3, 20, { axis: [1, 0, 0] }), op('intersect')],
    part((16 * 27) / 3, 16 * 9, [0, 0, 0], [-3, -3, -3], [3, 3, 3]),
    { mesh: mesh(BASE + cylTol(3, 1, 3), BASE + cylTol(3, 1), WHY_CYL) },
  );
  cases(
    'subtract-tube',
    'cylinder r=6 h=10 bored by r=4: a hollow tube',
    'V = pi (R^2 - r^2) h; A = 2 pi (R^2 - r^2) + 2 pi (R + r) h',
    [addCyl('a', 6, 10), addCyl('b', 4, 12), op('subtract')],
    part(tube(4, 6, 10), 2 * PI * 20 + 2 * PI * 10 * 10, [0, 0, 0], [-6, -6, -5], [6, 6, 5]),
    { mesh: mesh(BASE + cylTol(6, 1) + cylTol(4, 0.5), BASE + cylTol(6, 1), WHY_CYL) },
  );
  cases(
    'subtract-square-tube',
    'box 10x10x20 bored by a 6x6 square',
    'V = (100 - 36) 20; A = 2*64 + 4*10*20 + 4*6*20',
    [addBox('a', [10, 10, 20]), addBox('b', [6, 6, 30]), op('subtract')],
    part(1280, 1408, [0, 0, 0], [-5, -5, -10], [5, 5, 10]),
  );
  cases(
    'union-cylinders-stacked',
    'cylinder r=3 h=4 under a cylinder r=2 h=3 sharing a face',
    'V = pi (9*4 + 4*3)',
    [addCyl('a', 3, 4, { anchor: 'base-center' }), addCyl('b', 2, 3, { anchor: 'base-center', position: [0, 0, 4] }), op('union')],
    union([cylinder(3, 4, [0, 0, 2]), cylinder(2, 3, [0, 0, 5.5])]),
    { area: null, mesh: mesh(BASE + cylTol(3, 1), null, WHY_CYL) },
  );
  const lens = lensVolume(2, 3);
  cases(
    'union-spheres-overlap',
    'two spheres r=2, centres 3 apart',
    'V = 2 (4/3 pi r^3) - pi (4r + d)(2r - d)^2 / 12; A = 2 (4 pi r^2) - 2 (2 pi r h), h = r - d/2',
    [addSphere('a', 2), addSphere('b', 2, [3, 0, 0]), op('union')],
    part(2 * sphere(2).v - lens, 2 * sphere(2).a - 2 * (2 * PI * 2 * 0.5), [1.5, 0, 0], [-2, -2, -2], [5, 2, 2]),
    { mesh: mesh(BASE + SPHERE, BASE + SPHERE, WHY_SPH) },
  );
  const cap = capVolume(3, 2);
  const capCentroid = (3 * (2 * 3 - 2) ** 2) / (4 * (3 * 3 - 2));
  const spherecut = sphere(3).v - cap;
  cases(
    'subtract-sphere-cap',
    'sphere r=3 with the cap above z=1 sliced off by a box',
    'V = 4/3 pi r^3 - pi h^2 (3r - h)/3, h = 2; A = 4 pi r^2 - 2 pi r h + pi (r^2 - (r-h)^2)',
    [addSphere('a', 3), addBox('b', [10, 10, 10], [0, 0, 6]), op('subtract')],
    part(spherecut, 4 * PI * 9 - 2 * PI * 3 * 2 + PI * (9 - 1), [0, 0, (-cap * capCentroid) / spherecut], [-3, -3, -3], [3, 3, 1]),
    { mesh: mesh(BASE + SPHERE, BASE + SPHERE, WHY_SPH) },
  );
  const hemi = (2 / 3) * PI * 27;
  cases(
    'subtract-sphere-dent',
    'hemispherical dent r=3 in the top of a 10-cube',
    'V = 1000 - 2/3 pi r^3; A = 600 - pi r^2 + 2 pi r^2',
    [addBox('a', [10, 10, 10]), addSphere('b', 3, [0, 0, 5]), op('subtract')],
    part(1000 - hemi, 600 + PI * 9, [0, 0, (-hemi * (5 - (3 * 3) / 8)) / (1000 - hemi)], [-5, -5, -5], [5, 5, 5]),
    { mesh: mesh(BASE + SPHERE * (hemi / 943), BASE + SPHERE * 0.1, WHY_SPH) },
  );
}
