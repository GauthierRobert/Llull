// Extruded polygons (prisms) and Pappus-Guldin revolves.
import { addCase, mesh } from './caseKit.mjs';
import { PI, cone, cylinder, frustum, prism, union } from './formulas.mjs';
import { revolvePolygon } from './revolve.mjs';

const regular = (n, R) => Array.from({ length: n }, (_, i) => [R * Math.cos((2 * PI * i) / n), R * Math.sin((2 * PI * i) / n)]);

const AREA_MESH = 'area of a revolved curved face is summed over display triangles; the volume is closed-form';

export function profileCases(out) {
  const prismCase = (name, description, points, depth, position, extra = {}) =>
    addCase(out, {
      family: 'prism',
      name,
      description,
      formula: 'V = A_polygon * depth (shoelace); centroid = polygon centroid, depth/2; A = 2 A_polygon + perimeter * depth',
      actions: [{ command: 'extrude_profile', params: { profile: points, depth, ...(position ? { position } : {}) } }],
      p: prism(points, depth, position ?? [0, 0, 0]),
      ...extra,
    });
  prismCase(
    'prism-triangle',
    'right triangle 4x3 extruded 2',
    [
      [0, 0],
      [4, 0],
      [0, 3],
    ],
    2,
  );
  prismCase(
    'prism-rectangle-offset',
    'rectangle 5x2 extruded 3 from (1,2,3)',
    [
      [0, 0],
      [5, 0],
      [5, 2],
      [0, 2],
    ],
    3,
    [1, 2, 3],
  );
  prismCase(
    'prism-lshape',
    'L-shaped section (6 vertices)',
    [
      [0, 0],
      [6, 0],
      [6, 2],
      [2, 2],
      [2, 5],
      [0, 5],
    ],
    4,
  );
  prismCase('prism-hexagon', 'regular hexagon R=2 extruded 5', regular(6, 2), 5);
  prismCase(
    'prism-trapezoid',
    'trapezoid section extruded 1.5',
    [
      [0, 0],
      [8, 0],
      [6, 3],
      [2, 3],
    ],
    1.5,
  );
  prismCase(
    'prism-ibeam',
    'I-beam section 10x12, web 2, flange 3, extruded 20',
    [
      [0, 0],
      [10, 0],
      [10, 3],
      [6, 3],
      [6, 9],
      [10, 9],
      [10, 12],
      [0, 12],
      [0, 9],
      [4, 9],
      [4, 3],
      [0, 3],
    ],
    20,
  );
  prismCase(
    'prism-concave-star',
    'concave 8-vertex star extruded 2',
    [
      [0, 4],
      [1, 1],
      [4, 0],
      [1, -1],
      [0, -4],
      [-1, -1],
      [-4, 0],
      [-1, 1],
    ],
    2,
  );
  prismCase(
    'prism-negative-coords',
    'triangle in negative quadrant extruded 7',
    [
      [-5, -5],
      [-1, -5],
      [-3, -1],
    ],
    7,
  );
  prismCase('prism-octagon', 'regular octagon R=3 extruded 0.5', regular(8, 3), 0.5);

  const rev = (name, description, formula, profile, extraParams, p, extra = {}) =>
    addCase(out, {
      family: 'revolve',
      name,
      description,
      formula,
      actions: [{ command: 'revolve_profile', params: { profile, segments: 64, ...extraParams } }],
      p,
      ...extra,
    });
  const PAPPUS = 'Pappus-Guldin: V = 2 pi xbar A; lateral area = sum of 2 pi r_mid L';
  const meshArea = mesh(null, 0.02, AREA_MESH);
  rev(
    'revolve-washer',
    'rectangle (2..3, 0..1) revolved about Z',
    PAPPUS,
    [
      [2, 0],
      [3, 0],
      [3, 1],
      [2, 1],
    ],
    {},
    revolvePolygon([
      [2, 0],
      [3, 0],
      [3, 1],
      [2, 1],
    ]),
    { mesh: meshArea },
  );
  rev(
    'revolve-pappus-triangle',
    'triangle (2,0)(4,0)(2,3) revolved: xbar = 8/3',
    PAPPUS,
    [
      [2, 0],
      [4, 0],
      [2, 3],
    ],
    {},
    revolvePolygon([
      [2, 0],
      [4, 0],
      [2, 3],
    ]),
    { mesh: meshArea },
  );
  rev(
    'revolve-cone',
    'right triangle on the axis gives a cone r=2 h=3',
    'V = pi r^2 h / 3',
    [
      [0, 0],
      [2, 0],
      [0, 3],
    ],
    {},
    cone(2, 3),
    { mesh: meshArea },
  );
  rev(
    'revolve-frustum',
    'trapezoid on the axis gives a frustum r1=3 r2=2 h=4',
    'V = pi h (r1^2 + r1 r2 + r2^2) / 3',
    [
      [0, 0],
      [3, 0],
      [2, 4],
      [0, 4],
    ],
    {},
    frustum(3, 2, 4),
    { mesh: meshArea },
  );
  rev(
    'revolve-hollow-tube',
    'tube profile (1..2, 0..5) revolved',
    PAPPUS,
    [
      [1, 0],
      [2, 0],
      [2, 5],
      [1, 5],
    ],
    {},
    revolvePolygon([
      [1, 0],
      [2, 0],
      [2, 5],
      [1, 5],
    ]),
    { mesh: meshArea },
  );
  const shaft = [
    [0, 0],
    [2, 0],
    [2, 3],
    [1, 3],
    [1, 5],
    [0, 5],
  ];
  rev(
    'revolve-stepped-shaft',
    'stepped shaft: cylinder r2 h3 + cylinder r1 h2',
    'V = pi (r1^2 h1 + r2^2 h2)',
    shaft,
    {},
    union([cylinder(2, 3, [0, 0, 1.5]), cylinder(1, 2, [0, 0, 4])]),
    { mesh: mesh(null, null, AREA_MESH), area: null },
  );
  rev(
    'revolve-offset-axis',
    'washer revolved about an axis through (1,2,3)',
    PAPPUS,
    [
      [2, 0],
      [3, 0],
      [3, 1],
      [2, 1],
    ],
    { position: [1, 2, 3] },
    revolvePolygon(
      [
        [2, 0],
        [3, 0],
        [3, 1],
        [2, 1],
      ],
      [1, 2, 3],
    ),
    { mesh: meshArea },
  );
  rev(
    'revolve-bell',
    'conical washer (trapezoid 1..3 at the bottom, 1..2 at the top)',
    PAPPUS,
    [
      [1, 0],
      [3, 0],
      [2, 2],
      [1, 2],
    ],
    {},
    revolvePolygon([
      [1, 0],
      [3, 0],
      [2, 2],
      [1, 2],
    ]),
    { mesh: meshArea },
  );
  const half = revolvePolygon(
    [
      [2, 0],
      [3, 0],
      [3, 1],
      [2, 1],
    ],
    [0, 0, 0],
    PI,
  );
  rev(
    'revolve-half-turn',
    'washer revolved a half turn: V = pi xbar A; centroid and bbox not checked',
    'V = angle * xbar * A',
    [
      [2, 0],
      [3, 0],
      [3, 1],
      [2, 1],
    ],
    { angle: PI },
    half,
    { mesh: mesh(null, 0.02, AREA_MESH), centroid: false, area: null },
  );
}
