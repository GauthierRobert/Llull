// 07 MSH analytic references (closed forms + exact polyhedral values). Run: node generate_analytic_refs.mjs  -> data/*.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHI, icosahedron, icosphere, torus, area, volume, eulerCharacteristic, edgeUse, hullArea2d, grid, round } from './lib_mesh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (name, data) => {
  fs.writeFileSync(path.join(here, 'data', name), JSON.stringify(data, null, 1) + '\n');
  process.stdout.write(`wrote data/${name}\n`);
};
const PI = Math.PI;

// 1. Icosphere refinement convergence (VC-MSH-01): A -> 4 pi R^2, V -> 4/3 pi R^3, error ~ h^2 (ratio -> 4 per level).
{
  const R = 10;
  const A = 4 * PI * R * R;
  const V = (4 / 3) * PI * R ** 3;
  const levels = [];
  let prev = null;
  for (let level = 0; level <= 6; level++) {
    const m = icosphere(R, level);
    const a = area(m);
    const v = volume(m);
    const e = edgeUse(m);
    const row = {
      level,
      vertices: m.positions.length,
      edges: e.size,
      faces: m.faces.length,
      eulerCharacteristic: eulerCharacteristic(m),
      boundaryEdges: [...e.values()].filter((c) => c === 1).length,
      area: round(a),
      volume: round(v),
      areaRelError: round((A - a) / A, 8),
      volumeRelError: round((V - v) / V, 8),
      volumeErrorRatioToPrevious: prev === null ? null : round((V - prev) / (V - v), 6),
    };
    prev = v;
    levels.push(row);
  }
  out('icosphere_convergence.json', {
    what: 'Icosphere (icosahedron + 1-to-4 midpoint subdivision, vertices projected on the sphere) of radius R; inscribed, so A < 4 pi R^2 and V < 4/3 pi R^3',
    radius: R,
    unit: 'mm',
    closedForm: { area: round(A), volume: round(V), formula: 'A = 4 pi R^2, V = 4/3 pi R^3' },
    counts: 'V = 10*4^k + 2, E = 30*4^k, F = 20*4^k, chi = 2',
    levels,
  });
}

// 2. Convex hull references (VC-MSH-11).
{
  const ico = icosahedron(); // edge 2
  const vIco = volume(ico);
  const vIcoClosed = ((5 * PHI * PHI) / 6) * 8;
  const R = 5;
  const r = 2;
  const torusHull = 2 * PI * R * R * r + PI * PI * R * r * r + (4 / 3) * PI * r ** 3;
  const torusVolume = 2 * PI * PI * R * r * r;
  // Inscribed-polygon area deficit of an n-gon (per cross-section direction), used as the discretisation bound of a mesh torus hull.
  const deficit = (n) => 1 - Math.sin((2 * PI) / n) / ((2 * PI) / n);
  out('convex_hull_cases.json', {
    cases: [
      {
        id: 'cube_plus_interior',
        input: 'the 8 corners of [0,10]^3 plus 1000 points from mulberry32(seed 7) uniform in (0.5, 9.5)^3',
        expected: { volume: 1000, area: 600, hullVertices: 8, hullTriangles: 12 },
        derivation: 'interior points cannot be hull vertices; hull = the cube; 6 square faces = 12 triangles',
      },
      {
        id: 'icosahedron_vertices',
        input: '12 vertices (0, ±1, ±phi) and cyclic permutations, edge 2',
        expected: { volume: round(vIcoClosed), area: round(20 * Math.sqrt(3)), hullVertices: 12, hullTriangles: 20 },
        polyhedralCheck: { volumeFromTriangles: round(vIco) },
        derivation: 'V = 5 phi^2 / 6 a^3, A = 5 sqrt(3) a^2, a = 2',
      },
      {
        id: 'torus_hull',
        input: 'torus R 5, r 2 (continuous); mesh torus 64 x 32 segments for the test',
        expected: { volume: round(torusHull), torusVolume: round(torusVolume) },
        derivation:
          'hull = { |z| <= r, rho <= R + sqrt(r^2 - z^2) }; V = pi * int_{-r}^{r} (R + sqrt(r^2 - z^2))^2 dz = 2 pi R^2 r + pi^2 R r^2 + 4/3 pi r^3',
        discretisation: {
          note: 'a mesh torus with nu x nv segments is inscribed; its hull volume is below the continuous value by at most about 2*deficit(nu) + 2*deficit(nv) (relative), deficit(n) = 1 - sin(2 pi / n) / (2 pi / n)',
          relBound_64x32: round(2 * deficit(64) + 2 * deficit(32), 6),
        },
      },
    ],
  });
}

// 3. Minkowski sums (VC-MSH-12..14). Box B = [0,a]^3 (sum of 3 axis segments) and convex P:
//    V(P + B) = V(P) + a (A_x + A_y + A_z) + a^2 (w_x + w_y + w_z) + a^3, A_i = area of the projection of P along axis i, w_i = width of P along i.
{
  const a = 10;
  const r = 2;
  const continuous = a ** 3 + 6 * a * a * r + 3 * PI * a * r * r + (4 / 3) * PI * r ** 3;
  const rows = [];
  for (const level of [1, 2, 3]) {
    const ball = icosphere(r, level);
    const P = ball.positions;
    const proj = (i, j) => hullArea2d(P.map((p) => [p[i], p[j]]));
    const Ax = proj(1, 2);
    const Ay = proj(0, 2);
    const Az = proj(0, 1);
    const width = (k) => Math.max(...P.map((p) => p[k])) - Math.min(...P.map((p) => p[k]));
    const w = [width(0), width(1), width(2)];
    const vP = volume(ball);
    const exact = vP + a * (Ax + Ay + Az) + a * a * (w[0] + w[1] + w[2]) + a ** 3;
    rows.push({
      structuringElement: `icosphere r ${r} level ${level} (${P.length} vertices)`,
      ballVolume: round(vP),
      projectedAreas: [round(Ax), round(Ay), round(Az)],
      widths: w.map((x) => round(x)),
      expectedVolumeExactPolyhedral: round(exact),
      relDiffToContinuous: round((continuous - exact) / continuous, 6),
    });
  }
  out('minkowski_cases.json', {
    formula: 'V(P + [0,a]^3) = V(P) + a*(Ax+Ay+Az) + a^2*(wx+wy+wz) + a^3 (P convex; derivation in validation/README.md section 4.3)',
    cube_plus_ball: {
      a,
      r,
      continuousVolume: round(continuous),
      continuousFormula: 'a^3 + 6 a^2 r + 3 pi a r^2 + 4/3 pi r^3 (Steiner formula of the cube)',
      polyhedral: rows,
    },
    cube_plus_cube: { a: 10, b: 3, expectedVolume: 13 ** 3, derivation: '[0,a]^3 + [0,b]^3 = [0,a+b]^3' },
    cube_minus_cube: {
      a: 10,
      b: 3,
      expectedVolume: 7 ** 3,
      derivation: 'erosion of [0,a]^3 by the centred cube of side b is a cube of side a - b',
    },
    cube_minus_ball: {
      a: 10,
      r: 2,
      expectedVolume: 6 ** 3,
      derivation:
        'erosion of a convex box by a ball of radius r is the box shrunk by r on every face (flat faces: the support function of the ball is r in every direction)',
    },
  });
}

// 4. Offset / shell / plane cut / booleans (VC-MSH-15..18).
{
  const sphereV = (x) => (4 / 3) * PI * x ** 3;
  const a = 10;
  const d = 1;
  const roundedCube = a ** 3 + 6 * a * a * d + 3 * PI * a * d * d + (4 / 3) * PI * d ** 3;
  const offsetEps = 0.01;
  out('offset_shell_cases.json', {
    unit: 'mm',
    cases: [
      {
        id: 'sphere_out',
        input: 'sphere R 10, offset +1',
        expectedVolume: round(sphereV(11)),
        derivation: 'parallel body of a sphere is a sphere R + d',
      },
      { id: 'sphere_in', input: 'sphere R 10, offset -1', expectedVolume: round(sphereV(9)) },
      {
        id: 'cube_out_round',
        input: 'cube 10, offset +1, rounded corners',
        expectedVolume: round(roundedCube),
        derivation: 'equals the Minkowski sum with a ball',
      },
      { id: 'cube_in_sharp', input: 'cube 10, offset -1', expectedVolume: 512, derivation: '(a - 2d)^3' },
      { id: 'sphere_shell', input: 'sphere R 10, hollow, wall 1 inward, sealed cavity', expectedVolume: round(sphereV(10) - sphereV(9)) },
    ],
    tolerance: {
      rule: 'a level-set result whose vertices lie within eps of the exact offset surface has |dV| <= A_exact * eps',
      eps: offsetEps,
      sphere_out_absBound: round(4 * PI * 121 * offsetEps, 6),
      sphere_out_relBound: round((4 * PI * 121 * offsetEps) / sphereV(11), 6),
    },
  });
  const cutBelow = (c) => (c <= 1 ? c ** 3 / 6 : (c ** 3 - 3 * (c - 1) ** 3) / 6);
  out('plane_cut_cases.json', {
    unit: 'mm',
    body: 'unit cube [0,1]^3 (12 triangles)',
    cases: [
      {
        plane: 'x+y+z = 1.5',
        keep: 'below',
        expectedVolume: round(cutBelow(1.5)),
        capArea: round((3 * Math.sqrt(3)) / 4),
        capShape: 'regular hexagon, side sqrt(2)/2',
      },
      {
        plane: 'x+y+z = 1',
        keep: 'below',
        expectedVolume: round(cutBelow(1)),
        capArea: round(Math.sqrt(3) / 2),
        capShape: 'equilateral triangle, side sqrt(2)',
      },
      { plane: 'x = 0.25', keep: 'both', expectedVolumes: [0.25, 0.75], capArea: 1 },
    ],
    derivation: 'volume of {x+y+z <= c} in the unit cube: c^3/6 for c <= 1, (c^3 - 3(c-1)^3)/6 for 1 <= c <= 2',
  });
  out('boolean_cases.json', {
    unit: 'mm',
    A: '[0,2]^3',
    B: '[1,3]^3',
    cases: [
      { op: 'union', expectedVolume: 15, expectedArea: 42 },
      { op: 'subtract', expectedVolume: 7, expectedArea: 24 },
      { op: 'intersect', expectedVolume: 1, expectedArea: 6 },
    ],
    derivation:
      'overlap = [1,2]^3 (volume 1); each cube has 3 unit faces inside the other; union area 48 - 2*3 = 42; A - B keeps 21 of A and gains 3 of B',
  });
}

// 5. Sculpt brush displaced volumes (VC-MSH-19): continuous int_0^rho s f(r/rho) 2 pi r dr and the exact piecewise-linear value on a grid.
{
  const falloffs = {
    constant: { f: () => 1, integral: 1 / 2 },
    linear: { f: (t) => 1 - t, integral: 1 / 6 },
    smooth: { f: (t) => (1 - t * t) ** 2, integral: 1 / 6 },
    sphere: { f: (t) => Math.sqrt(1 - t * t), integral: 1 / 3 },
  };
  const rho = 4;
  const s = 0.5;
  const g = grid(20, 80, () => 0, -10);
  const h = g.h;
  const cases = [];
  for (const [name, { f, integral }] of Object.entries(falloffs)) {
    const disp = g.positions.map(([x, y]) => {
      const t = Math.hypot(x, y) / rho;
      return t < 1 ? s * f(t) : 0;
    });
    let discrete = 0;
    for (const [i, j, k] of g.faces) discrete += ((h * h) / 2) * ((disp[i] + disp[j] + disp[k]) / 3);
    cases.push({
      falloff: name,
      continuousVolume: round(2 * PI * s * rho * rho * integral),
      discreteVolumeOnGrid: round(discrete),
      formula: `2 pi s rho^2 * ${name === 'constant' ? '1/2' : name === 'sphere' ? '1/3' : '1/6'}`,
    });
  }
  out('sculpt_cases.json', {
    brush:
      'draw / inflate on the flat grid [-10,10]^2, 80 x 80 cells (h 0.25), two triangles per cell, displacement s*f(r/rho) along +Z at every vertex',
    rho,
    strength: s,
    unit: 'mm',
    falloff: { constant: '1', linear: '1 - t', smooth: '(1 - t^2)^2', sphere: 'sqrt(1 - t^2)', t: 'distance / radius' },
    cases,
    discreteRule: 'volume under a piecewise-linear surface = sum over triangles of area * mean vertex height (exact)',
    symmetry: 'a stroke mirrored about x = 0 must give |z(x,y) - z(-x,y)| <= 1e-12 at every vertex',
  });
}

// 6. Remesh / smoothing closed forms (VC-MSH-08, 10).
{
  const R = 10;
  const L = 1;
  const lmax = (4 / 3) * L;
  const rc = lmax / Math.sqrt(3);
  const lambda = 0.6307;
  const kPB = 0.1;
  const mu = 1 / (kPB - 1 / lambda);
  const f = (k) => (1 - lambda * k) * (1 - mu * k);
  out('remesh_smooth_refs.json', {
    remesh: {
      algorithm:
        'Botsch-Kobbelt 2004: split > 4/3 L, collapse < 4/5 L, flip toward valence 6 (4 on boundary), tangential relaxation, project',
      sphereRadius: R,
      targetEdge: L,
      edgeBand: [round(0.8 * L), round(lmax)],
      chordDeviationBound: round(R - Math.sqrt(R * R - rc * rc), 9),
      derivation:
        'Jung (plane): a triangle with all edges <= l lies in a disc of radius l/sqrt(3); with its vertices on the sphere it is within R - sqrt(R^2 - l^2/3) of it',
    },
    taubin: {
      lambda,
      kPB,
      mu: round(mu, 10),
      relation: 'kPB = 1/lambda + 1/mu (Taubin 1995 eq. 9); f(k) = (1 - lambda k)(1 - mu k)',
      transfer: { 'f(0)': f(0), 'f(kPB)': round(f(kPB), 12), 'f(0.5)': round(f(0.5), 9), 'f(1)': round(f(1), 9), 'f(2)': round(f(2), 9) },
      paperValues: 'kPB = 0.1 and lambda = 0.6307 (figures 3, 4); kPB from 0.01 to 0.1 recommended',
    },
  });
}

// 7. Topology fingerprints (VC-MSH-02).
{
  const t = torus(5, 2, 32, 16);
  const ico = icosphere(10, 3);
  const half = {
    positions: ico.positions,
    faces: ico.faces.filter(([a, b, c]) => ico.positions[a][2] + ico.positions[b][2] + ico.positions[c][2] > 0),
  };
  const be = [...edgeUse(half).values()].filter((c) => c === 1).length;
  out('topology_cases.json', {
    cases: [
      {
        id: 'icosphere_l3',
        vertices: 642,
        faces: 1280,
        eulerCharacteristic: eulerCharacteristic(ico),
        genus: 0,
        boundaryLoops: 0,
        closed: true,
      },
      {
        id: 'torus_32x16',
        vertices: t.positions.length,
        faces: t.faces.length,
        eulerCharacteristic: eulerCharacteristic(t),
        genus: 1,
        boundaryLoops: 0,
        closed: true,
        volumeMesh: round(volume(t)),
        areaMesh: round(area(t)),
      },
      {
        id: 'icosphere_l3_upper_faces',
        faces: half.faces.length,
        boundaryEdges: be,
        boundaryLoops: 1,
        closed: false,
        note: 'faces whose centroid has z > 0',
      },
    ],
    rule: 'closed orientable: chi = V - E + F = 2 - 2g per component',
  });
}
