// Holes through a plate, patterns and transforms. (Mesh kernels run these too; hole bores are inscribed polygons there.)
import { BOTH, addCase, cylTol, mesh } from './caseKit.mjs';
import { PI, box, cone, cylinder, part, sphere, union } from './formulas.mjs';

const BASE = 1e-3;
const WHY_BORE =
  'bore tessellated as an inscribed n-gon (n from the kernel default circle resolution): loss <= k (1 - cos(pi/n)) of the removed share';

/** Plate 20x20x4 centred on the origin (top face z = 2), area 1120. */
const PLATE = box([20, 20, 4]);
const plateAction = { command: 'add_box', params: { size: [20, 20, 4] }, as: 'p' };

/** A plate minus removed parts: centroid by moments, volume, and the given area. */
function drilled(removed, area) {
  const gone = union(removed);
  const v = PLATE.v - gone.v;
  return part(
    v,
    area,
    [0, 1, 2].map((i) => (-gone.v * gone.c[i]) / v),
    PLATE.min,
    PLATE.max,
  );
}

export function featureCases(out) {
  const hole = (name, description, formula, points, hole, extent, removed, area, extra = {}) => {
    const frac = union(removed).v / (PLATE.v - union(removed).v);
    addCase(out, {
      family: 'hole',
      name,
      description,
      formula,
      actions: [
        plateAction,
        { command: 'add_hole', params: { target: '$p', face: { near: [0, 0, 2] }, points, pointsFrame: 'world_xy', hole, extent } },
      ],
      p: drilled(removed, area),
      mesh: mesh(BASE + cylTol(hole.cboreDiameter ? hole.cboreDiameter / 2 : hole.diameter / 2, frac), BASE + cylTol(2, 0.3), WHY_BORE),
      ...extra,
    });
  };
  const bore = (r, z0, z1) => cylinder(r, z1 - z0, [0, 0, (z0 + z1) / 2]);
  const A0 = 1120;

  hole(
    'hole-through',
    'through hole d=4 in a 20x20x4 plate',
    'V = abc - pi r^2 h; A = A0 - 2 pi r^2 + 2 pi r h',
    [[0, 0]],
    { kind: 'simple', diameter: 4 },
    { kind: 'through_all' },
    [bore(2, -2, 2)],
    A0 - 2 * PI * 4 + 2 * PI * 2 * 4,
  );
  hole(
    'hole-four-through',
    'four through holes d=3 at (+-5,+-5)',
    'V = abc - 4 pi r^2 h',
    [
      [5, 5],
      [-5, 5],
      [5, -5],
      [-5, -5],
    ],
    { kind: 'simple', diameter: 3 },
    { kind: 'through_all' },
    [
      ...[
        [5, 5],
        [-5, 5],
        [5, -5],
        [-5, -5],
      ].map(([x, y]) => cylinder(1.5, 4, [x, y, 0])),
    ],
    A0 + 4 * (-2 * PI * 2.25 + 2 * PI * 1.5 * 4),
  );
  hole(
    'hole-counterbore',
    'counterbore D=8 x 1.5 over a d=4 through hole',
    'V = abc - pi r^2 h - pi (R^2 - r^2) c',
    [[0, 0]],
    { kind: 'counterbore', diameter: 4, cboreDiameter: 8, cboreDepth: 1.5 },
    { kind: 'through_all' },
    [bore(2, -2, 2), part(PI * 12 * 1.5, null, [0, 0, 2 - 0.75], [0, 0, 0], [0, 0, 0])],
    A0 - PI * 16 + 2 * PI * 4 * 1.5 + PI * 12 + 2 * PI * 2 * 2.5 - PI * 4,
  );
  const cskCone = ((PI * 2) / 3) * (16 + 8 + 4);
  hole(
    'hole-countersink',
    '90 degree countersink D=8 over a d=4 through hole',
    'V = abc - frustum(4,2,2) - pi r^2 (h - 2)',
    [[0, 0]],
    { kind: 'countersink', diameter: 4, cskDiameter: 8, cskAngle: 90 },
    { kind: 'through_all' },
    [part(cskCone, null, [0, 0, 2 - (2 * (16 + 16 + 12)) / (4 * 28)], [0, 0, 0], [0, 0, 0]), bore(2, -2, 0)],
    A0 - PI * 16 + PI * 6 * Math.hypot(2, 2) + 2 * PI * 2 * 2 - PI * 4,
  );
  hole(
    'hole-blind-flat',
    'flat-bottom blind hole d=4 depth 2',
    'V = abc - pi r^2 depth',
    [[0, 0]],
    { kind: 'simple', diameter: 4 },
    { kind: 'blind', depth: 2, drillPointAngle: 0 },
    [bore(2, 0, 2)],
    A0 + 2 * PI * 2 * 2,
  );
  const tip = 2 / Math.tan((59 * PI) / 180);
  hole(
    'hole-blind-drill-point',
    'blind hole d=4 depth 2 plus a 118 degree drill point',
    'V = pi r^2 depth + pi r^2 (r / tan(59 deg)) / 3',
    [[0, 0]],
    { kind: 'simple', diameter: 4 },
    { kind: 'blind', depth: 2, drillPointAngle: 118 },
    [bore(2, 0, 2), part((PI * 4 * tip) / 3, null, [0, 0, -tip / 4], [0, 0, 0], [0, 0, 0])],
    A0 - PI * 4 + 2 * PI * 2 * 2 + PI * 2 * Math.hypot(2, tip),
  );

  const pattern = (name, description, formula, actions, p, extra = {}) =>
    addCase(out, { family: 'pattern', name, description, formula, actions, p, kernels: BOTH, ...extra });
  const row = (p0, n, step) =>
    union(
      Array.from({ length: n }, (_, i) => ({
        ...p0,
        c: p0.c.map((x, k) => x + i * step[k]),
        min: p0.min.map((x, k) => x + i * step[k]),
        max: p0.max.map((x, k) => x + i * step[k]),
      })),
    );
  pattern(
    'pattern-linear-boxes',
    'five unit cubes 3 apart',
    'bodies = n; V = n V1; centroid = mean',
    [
      { command: 'add_box', params: { size: [1, 1, 1] }, as: 'a' },
      { command: 'array_linear', params: { id: '$a', count: 5, offset: [3, 0, 0] } },
    ],
    row(box([1, 1, 1]), 5, [3, 0, 0]),
    { bodies: 5 },
  );
  pattern(
    'pattern-linear-spheres',
    'three spheres r=1 along a diagonal',
    'bodies = n; V = n V1',
    [
      { command: 'add_sphere', params: { radius: 1 }, as: 'a' },
      { command: 'array_linear', params: { id: '$a', count: 3, offset: [4, 4, 4] } },
    ],
    row(sphere(1), 3, [4, 4, 4]),
    { bodies: 3 },
  );
  pattern(
    'pattern-linear-cones',
    'four cones in a row along Y',
    'bodies = n; V = n V1',
    [
      { command: 'add_cone', params: { radius: 1, height: 2 }, as: 'a' },
      { command: 'array_linear', params: { id: '$a', count: 4, offset: [0, 5, 0] } },
    ],
    row(cone(1, 2), 4, [0, 5, 0]),
    { bodies: 4, mesh: mesh(null, 0.03, 'area of a cone is summed over display triangles') },
  );
  const polar = union(Array.from({ length: 6 }, (_, i) => cylinder(0.5, 2, [5 * Math.cos((PI * i) / 3), 5 * Math.sin((PI * i) / 3), 0])));
  pattern(
    'pattern-polar-cylinders',
    'six cylinders r=0.5 h=2 on a circle of radius 5',
    'bodies = n; V = n pi r^2 h; centroid on the axis',
    [
      { command: 'add_cylinder', params: { radius: 0.5, height: 2, position: [5, 0, 0] }, as: 'a' },
      { command: 'array_polar', params: { id: '$a', count: 6, center: [0, 0, 0] } },
    ],
    polar,
    {
      bodies: 6,
      knownFailure: {
        fields: ['bbox'],
        measured: { bboxY: [-5.013139720814415, 5.013139720814413] },
        diagnosis:
          'measure_bounding_box returns the AABB of the rotated local box (entityBoundsInDoc), not the tight box of the rotated cylinder: ' +
          '0.5 sin60 + 0.5 cos60 + 5 sin60 = 5.013 instead of 5 sin60 + 0.5 = 4.830 for a cylinder turned 60 degrees about Z',
      },
    },
  );
  pattern(
    'pattern-polar-cylinders-quarter',
    'four cylinders r=0.5 h=2 on a circle of radius 5 (quarter turns keep the AABB exact)',
    'bodies = n; V = n pi r^2 h',
    [
      { command: 'add_cylinder', params: { radius: 0.5, height: 2, position: [5, 0, 0] }, as: 'a' },
      { command: 'array_polar', params: { id: '$a', count: 4, center: [0, 0, 0] } },
    ],
    union(Array.from({ length: 4 }, (_, i) => cylinder(0.5, 2, [5 * Math.cos((PI * i) / 2), 5 * Math.sin((PI * i) / 2), 0]))),
    { bodies: 4 },
  );
  pattern(
    'pattern-polar-boxes',
    'four boxes 2x1x1 on a circle of radius 4 (quarter turns turn the boxes)',
    'bodies = n; V = n V1; centroid on the axis',
    [
      { command: 'add_box', params: { size: [2, 1, 1], position: [4, 0, 0] }, as: 'a' },
      { command: 'array_polar', params: { id: '$a', count: 4, center: [0, 0, 0] } },
    ],
    part(8, 4 * 10, [0, 0, 0], [-5, -5, -0.5], [5, 5, 0.5]),
    { bodies: 4 },
  );
  pattern(
    'mirror-box',
    'box mirrored across the Y axis (position negated)',
    'bbox follows the mirrored position',
    [
      { command: 'add_box', params: { size: [2, 3, 4], position: [3, 2, 1] }, as: 'a' },
      { command: 'mirror_entity', params: { id: '$a', axis: 'y' } },
    ],
    box([2, 3, 4], [3, -2, 1]),
  );

  const xform = (name, description, formula, actions, p) => addCase(out, { family: 'transform', name, description, formula, actions, p });
  xform(
    'scale-box',
    'box 2x3x4 scaled by 1.5',
    'V scales with f^3, A with f^2',
    [
      { command: 'add_box', params: { size: [2, 3, 4] }, as: 'a' },
      { command: 'scale_entity', params: { id: '$a', factor: 1.5 } },
    ],
    box([3, 4.5, 6]),
  );
  xform(
    'scale-sphere',
    'sphere r=2 scaled by 0.5',
    'V scales with f^3',
    [
      { command: 'add_sphere', params: { radius: 2 }, as: 'a' },
      { command: 'scale_entity', params: { id: '$a', factor: 0.5 } },
    ],
    sphere(1),
  );
  xform(
    'rotate-box-z90',
    'box 2x3x4 rotated a quarter turn about Z',
    'bbox extents swap',
    [
      { command: 'add_box', params: { size: [2, 3, 4] }, as: 'a' },
      { command: 'rotate_entity', params: { id: '$a', delta: [0, 0, PI / 2] } },
    ],
    box([3, 2, 4]),
  );
}
