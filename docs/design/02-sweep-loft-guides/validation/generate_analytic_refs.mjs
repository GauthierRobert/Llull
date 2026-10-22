// SWG analytic reference generator (Node ESM, no dependencies).
//   node generate_analytic_refs.mjs        -> writes validation/data/*.json
// Every closed form below is cross-checked by an INDEPENDENT numeric construction: the swept / lofted solid is built as a
// parametric quad mesh, its volume integrated by the divergence theorem (sum of signed tetrahedra) at two resolutions and
// Richardson-extrapolated (second-order). Both numbers are written so a reader can see the closed form is right.
// Derivations are in validation/README.md section 4.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'data');
mkdirSync(out, { recursive: true });
const PI = Math.PI;
const GENERATED = '2026-10-22';

// ---------- vector helpers ----------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / norm(a));
const sig = (x, n = 12) => Number(x.toPrecision(n));

// ---------- mesh volume of a swept / lofted grid ----------
// grid[i][j]: i along the path (0..nt), j around the closed section (0..nu-1). closedPath: the last ring joins the first, no caps.
function gridVolume(grid, closedPath) {
  const nt = grid.length;
  const nu = grid[0].length;
  const tri = (a, b, c) => dot(a, cross(b, c)) / 6;
  let v = 0;
  const rows = closedPath ? nt : nt - 1;
  for (let i = 0; i < rows; i++) {
    const A = grid[i];
    const B = grid[(i + 1) % nt];
    for (let j = 0; j < nu; j++) {
      const k = (j + 1) % nu;
      v += tri(A[j], B[k], B[j]) + tri(A[j], A[k], B[k]);
    }
  }
  if (!closedPath) {
    for (const [ring, flip] of [
      [grid[0], 1],
      [grid[nt - 1], -1],
    ]) {
      const c = mul(
        ring.reduce((s, p) => add(s, p), [0, 0, 0]),
        1 / nu,
      );
      for (let j = 0; j < nu; j++) {
        const k = (j + 1) % nu;
        v += flip * tri(c, ring[k], ring[j]);
      }
    }
  }
  return Math.abs(v);
}

// Build a grid from place(t, u) (t in [0,1] along the path, u in [0,1) around the section) and Richardson-extrapolate.
function meshCheck(place, closedPath, nt = 200, nu = 128) {
  const build = (n, m) =>
    Array.from({ length: closedPath ? n : n + 1 }, (_, i) => Array.from({ length: m }, (_, j) => place(i / n, j / m)));
  const coarse = gridVolume(build(nt, nu), closedPath);
  const fine = gridVolume(build(2 * nt, 2 * nu), closedPath);
  return { meshCoarse: sig(coarse), meshFine: sig(fine), richardson: sig((4 * fine - coarse) / 3) };
}
const relErr = (a, b) => sig(Math.abs(a - b) / Math.abs(b), 3);

// ---------- sections (unit-free, centred at the path unless offset) ----------
const circle = (r) => (u) => [r * Math.cos(2 * PI * u), r * Math.sin(2 * PI * u)];
// square / rectangle traced at constant speed along the perimeter (closed, CCW), centred at (cx, cy)
const rect =
  (w, h, cx = 0, cy = 0) =>
  (u) => {
    const p = 2 * (w + h);
    let s = u * p;
    // start at (+w/2,-h/2) going up the right edge first
    const edges = [
      [[w / 2, -h / 2], [0, 1], h],
      [[w / 2, h / 2], [-1, 0], w],
      [[-w / 2, h / 2], [0, -1], h],
      [[-w / 2, -h / 2], [1, 0], w],
    ];
    for (const [o, d, len] of edges) {
      if (s <= len) return [cx + o[0] + d[0] * s, cy + o[1] + d[1] * s];
      s -= len;
    }
    return [cx + w / 2, cy - h / 2];
  };
const rot2 = (p, phi) => [p[0] * Math.cos(phi) - p[1] * Math.sin(phi), p[0] * Math.sin(phi) + p[1] * Math.cos(phi)];

// place a 2D section point in a frame {o, n, b}
const placeIn = (f, p) => add(f.o, add(mul(f.n, p[0]), mul(f.b, p[1])));

// ---------- frames ----------
const lineFrame = (L, dir = [0, 0, 1], n0 = [1, 0, 0]) => {
  const d = unit(dir);
  const n = unit(sub(n0, mul(d, dot(n0, d))));
  const b = cross(d, n);
  return (t) => ({ o: mul(d, L * t), n, b, tangent: d });
};
// circular arc in XY, radius R, angle theta; n = outward radial, b = +Z (RMF of a planar circle)
const arcFrame = (R, theta) => (t) => {
  const a = theta * t;
  return { o: [R * Math.cos(a), R * Math.sin(a), 0], n: [Math.cos(a), Math.sin(a), 0], b: [0, 0, 1] };
};
// helix radius R, pitch p, turns n (right hand, axis +Z); Frenet frame: n points to the axis, b = t x n
const helixFrenet = (R, p, turns) => (t) => {
  const c = p / (2 * PI);
  const a = 2 * PI * turns * t;
  const s = Math.hypot(R, c);
  const tangent = [(-R * Math.sin(a)) / s, (R * Math.cos(a)) / s, c / s];
  const nrm = [-Math.cos(a), -Math.sin(a), 0];
  return { o: [R * Math.cos(a), R * Math.sin(a), c * a], n: nrm, b: cross(tangent, nrm), tangent };
};

const results = {};

// ================= A. Pappus sweeps =================
{
  const R = 50;
  const r = 10;
  const torus = 2 * PI * PI * R * r * r;
  const torusMesh = meshCheck((t, u) => placeIn(arcFrame(R, 2 * PI)(t), circle(r)(u)), true);
  const quarter = PI * r * r * R * (PI / 2);
  const quarterMesh = meshCheck((t, u) => placeIn(arcFrame(R, PI / 2)(t), circle(r)(u)), false);
  // square side 10, centroid offset d = 5 toward the arc centre (section x = -5 along the outward normal)
  const side = 10;
  const d = 5;
  const theta = PI / 2;
  const offset = side * side * theta * (R - d);
  const offsetMesh = meshCheck((t, u) => placeIn(arcFrame(R, theta)(t), rect(side, side, -d, 0)(u)), false);
  results.pappus = {
    gap: 'SWG',
    generated: GENERATED,
    notes:
      'Pappus second theorem V = A * 2 pi * (centroid distance) * (angle / 2 pi). Mesh check = divergence-theorem volume of a quad grid, Richardson-extrapolated.',
    cases: [
      {
        id: 'torus_sweep',
        R,
        r,
        formula: '2 pi^2 R r^2',
        value: sig(torus),
        ...torusMesh,
        relErrRichardson: relErr(torusMesh.richardson, torus),
      },
      {
        id: 'quarter_torus_sweep',
        R,
        r,
        angleRad: PI / 2,
        formula: 'pi r^2 R theta',
        value: sig(quarter),
        ...quarterMesh,
        relErrRichardson: relErr(quarterMesh.richardson, quarter),
      },
      {
        id: 'offset_square_on_arc',
        R,
        side,
        centroidOffsetTowardCentre: d,
        angleRad: theta,
        formula: 'side^2 theta (R - d)',
        value: sig(offset),
        ...offsetMesh,
        relErrRichardson: relErr(offsetMesh.richardson, offset),
        centredValueForContrast: sig(side * side * theta * R),
      },
    ],
  };
}

// ================= B. Helical sweeps =================
function helixLength(R0, R1, p, turns, steps = 20000) {
  // conical helix r(phi) linear; length = integral sqrt(r^2 + (dr/dphi)^2 + c^2) dphi, composite Simpson
  const total = 2 * PI * turns;
  const c = p / (2 * PI);
  const slope = (R1 - R0) / total;
  const speed = (phi) => Math.hypot(R0 + slope * phi, slope, c);
  let s = speed(0) + speed(total);
  for (let i = 1; i < steps; i++) s += speed((i * total) / steps) * (i % 2 ? 4 : 2);
  return (s * total) / (3 * steps);
}
{
  const R = 20;
  const p = 10;
  const turns = 3;
  const r = 2;
  const c = p / (2 * PI);
  const L = turns * Math.hypot(2 * PI * R, p);
  const tube = PI * r * r * L;
  const tubeMesh = meshCheck((t, u) => placeIn(helixFrenet(R, p, turns)(t), circle(r)(u)), false, 600, 64);
  const kappa = R / (R * R + c * c);
  const tau = c / (R * R + c * c);
  // B2 axial-plane rectangle, screw motion: radial 18..22 (w 4, centroid 20), axial height 3
  const screw = (pitch) => {
    const w = 4;
    const h = 3;
    const rc = 20;
    const V = 2 * PI * turns * w * h * rc;
    const mesh = meshCheck(
      (t, u) => {
        const a = 2 * PI * turns * t;
        const [x, y] = rect(w, h, rc, 0)(u);
        return [x * Math.cos(a), x * Math.sin(a), y + (pitch * a) / (2 * PI)];
      },
      false,
      600,
      64,
    );
    return {
      pitch,
      radialWidth: w,
      axialHeight: h,
      centroidRadius: rc,
      turns,
      formula: '2 pi n A rbar (pitch-independent)',
      value: sig(V),
      ...mesh,
      relErrRichardson: relErr(mesh.richardson, V),
    };
  };
  // B3 conical helix (as add_coil endRadius)
  const conical = { R0: 20, R1: 10, pitch: 10, turns: 5, wireRadius: 1 };
  const Lc = helixLength(conical.R0, conical.R1, conical.pitch, conical.turns);
  // B4 RMF vs Frenet: integrate the RMF by double reflection along one turn and measure its angle to the Frenet normal
  const steps = 20000;
  const fr = helixFrenet(R, p, 1);
  let prev = fr(0);
  let nR = prev.n;
  for (let i = 1; i <= steps; i++) {
    const cur = fr(i / steps);
    const v1 = sub(cur.o, prev.o);
    const c1 = dot(v1, v1);
    const rL = sub(nR, mul(v1, (2 / c1) * dot(v1, nR)));
    const tL = sub(prev.tangent, mul(v1, (2 / c1) * dot(v1, prev.tangent)));
    const v2 = sub(cur.tangent, tL);
    const c2 = dot(v2, v2);
    nR = c2 > 1e-30 ? sub(rL, mul(v2, (2 / c2) * dot(v2, rL))) : rL;
    prev = cur;
  }
  const end = fr(1);
  const angle = Math.atan2(dot(cross(end.n, nR), end.tangent), dot(end.n, nR));
  const predicted = (2 * PI * c) / Math.hypot(R, c);
  results.helical = {
    gap: 'SWG',
    generated: GENERATED,
    notes: 'Helix x = R cos a, y = R sin a, z = c a, c = pitch / 2 pi. Curvature R/(R^2+c^2), torsion c/(R^2+c^2).',
    cases: [
      {
        id: 'round_tube_on_helix',
        R,
        pitch: p,
        turns,
        sectionRadius: r,
        centreLineLength: sig(L),
        formula: 'pi r^2 n sqrt((2 pi R)^2 + p^2)',
        value: sig(tube),
        ...tubeMesh,
        relErrRichardson: relErr(tubeMesh.richardson, tube),
        curvature: sig(kappa),
        minRadiusOfCurvature: sig(1 / kappa),
        torsion: sig(tau),
        localSelfIntersectionLimit: 'sectionRadius < 1/curvature',
      },
      { id: 'screw_rectangle_pitch10', ...screw(10) },
      { id: 'screw_rectangle_pitch5', ...screw(5) },
      {
        id: 'conical_helix_tube',
        ...conical,
        centreLineLength: sig(Lc),
        formula: 'pi r^2 L, L = integral sqrt(r(phi)^2 + r_phi^2 + c^2) dphi (Simpson 20000)',
        value: sig(PI * conical.wireRadius ** 2 * Lc),
      },
      {
        id: 'rmf_vs_frenet_one_turn',
        R,
        pitch: p,
        measuredAngleRad: sig(angle, 10),
        formula: 'Frenet frame turns by integral of torsion = 2 pi c / sqrt(R^2 + c^2) relative to the RMF per turn',
        value: sig(predicted, 10),
        sign: 'the RMF normal lags the Frenet normal (measured angle = -value: rotation about +tangent from Frenet n to RMF n)',
      },
    ],
  };
}

// ================= B5. add_coil baseline: Catmull-Rom helix approximation =================
{
  const R = 20;
  const p = 10;
  const turns = 3;
  const halfHeight = 1;
  const count = Math.max(8, Math.ceil(turns * 16));
  const pts = Array.from({ length: count + 1 }, (_, i) => {
    const t = i / count;
    const phi = 2 * PI * turns * t;
    return [R * Math.cos(phi), R * Math.sin(phi), p * turns * t + halfHeight];
  });
  // centripetal Catmull-Rom as packages/core/src/geometry/curveSegments.ts catmullRomBeziers (open)
  const n = pts.length;
  const at = (i) => (i < 0 ? sub(mul(pts[0], 2), pts[1]) : i >= n ? sub(mul(pts[n - 1], 2), pts[n - 2]) : pts[i]);
  const dist = (a, b) => norm(sub(a, b));
  let maxDev = 0;
  let maxRadial = 0;
  let maxInterior = 0;
  let length = 0;
  for (let i = 0; i < n - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    let dt0 = Math.sqrt(dist(p0, p1));
    let dt1 = Math.sqrt(dist(p1, p2));
    let dt2 = Math.sqrt(dist(p2, p3));
    if (dt1 < 1e-4) dt1 = 1;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;
    const tang = (a, b, c, d0, d1) => mul(add(sub(mul(sub(b, a), 1 / d0), mul(sub(c, a), 1 / (d0 + d1))), mul(sub(c, b), 1 / d1)), dt1);
    const m1 = tang(p0, p1, p2, dt0, dt1);
    const m2 = tang(p1, p2, p3, dt1, dt2);
    const B = [p1, add(p1, mul(m1, 1 / 3)), sub(p2, mul(m2, 1 / 3)), p2];
    const bez = (s) => {
      const q = 1 - s;
      return add(add(mul(B[0], q * q * q), mul(B[1], 3 * q * q * s)), add(mul(B[2], 3 * q * s * s), mul(B[3], s * s * s)));
    };
    let last = bez(0);
    for (let k = 1; k <= 400; k++) {
      const s = k / 400;
      const q = bez(s);
      length += dist(q, last);
      last = q;
      maxRadial = Math.max(maxRadial, Math.abs(Math.hypot(q[0], q[1]) - R));
      // nearest helix point: Newton on the helix angle starting from the atan2 guess unwrapped near the segment
      let a = Math.atan2(q[1], q[0]);
      const guess = ((i + s) / count) * 2 * PI * turns;
      a += 2 * PI * Math.round((guess - a) / (2 * PI));
      const c = p / (2 * PI);
      for (let it = 0; it < 30; it++) {
        const h = [R * Math.cos(a), R * Math.sin(a), c * a + halfHeight];
        const d1 = [-R * Math.sin(a), R * Math.cos(a), c];
        const d2 = [-R * Math.cos(a), -R * Math.sin(a), 0];
        const e = sub(h, q);
        const f = dot(e, d1);
        const fp = dot(d1, d1) + dot(e, d2);
        a -= f / fp;
      }
      const h = [R * Math.cos(a), R * Math.sin(a), (p / (2 * PI)) * a + halfHeight];
      maxDev = Math.max(maxDev, dist(h, q));
      if (i > 0 && i < n - 2) maxInterior = Math.max(maxInterior, dist(h, q));
    }
  }
  const exactL = turns * Math.hypot(2 * PI * R, p);
  results.coilBaseline = {
    gap: 'SWG',
    generated: GENERATED,
    notes:
      "Indicative measurement of TODAY's add_coil round-wire path: centripetal Catmull-Rom Beziers through 16 helix points per turn (packages/core/src/commands/solids/coil.ts helixPoints + catmullRomBeziers), re-implemented here. Not a llull run.",
    R,
    pitch: p,
    turns,
    samplesPerTurn: 16,
    maxDistanceToExactHelix: sig(maxDev, 6),
    maxRadialDeviation: sig(maxRadial, 6),
    maxDistanceInteriorSegments: sig(maxInterior, 6),
    endSegmentsNote: 'the end segments use the reflected phantom points 2 p0 - p1 of catmullRomBeziers, which bends the end tangent',
    relativeMaxDeviation: sig(maxDev / R, 4),
    chainLength: sig(length, 10),
    exactLength: sig(exactL, 10),
    lengthRelErr: sig((length - exactL) / exactL, 4),
  };
}

// ================= C. Twist invariance =================
{
  const side = 10;
  const L = 100;
  const A = side * side;
  const sStep = (u) => u * u * (3 - 2 * u);
  const twistCase = (id, law, sec = rect(side, side), path = 'line') => {
    const frame = path === 'line' ? lineFrame(L) : helixFrenet(20, 10, 3);
    const Lp = path === 'line' ? L : 3 * Math.hypot(40 * PI, 10);
    const V = A * Lp;
    const mesh = meshCheck((t, u) => placeIn(frame(t), rot2(sec(u), law(t))), false, path === 'line' ? 200 : 600, 128);
    return {
      id,
      path,
      pathLength: sig(Lp),
      formula: 'A L (in-plane rotation keeps the section centroid on the path)',
      value: sig(V),
      ...mesh,
      relErrRichardson: relErr(mesh.richardson, V),
    };
  };
  results.twist = {
    gap: 'SWG',
    generated: GENERATED,
    notes:
      'Square 10 x 10 swept with a twist law phi(t). Straight path: Cavalieri (every slice normal to the path is the same square) - true even for an off-centre section. Helix path: centroid on the path.',
    cases: [
      twistCase('linear_0_to_90deg', (t) => (PI / 2) * t),
      twistCase('linear_0_to_360deg', (t) => 2 * PI * t),
      twistCase('scurve_0_to_180deg', (t) => PI * sStep(t)),
      {
        ...twistCase('offset_rect_linear_0_to_180deg', (t) => PI * t, rect(20, 5, 6, 0)),
        note: 'rect 20 x 5 centred at (6, 0): A = 100, offset section on a straight path',
      },
      twistCase('helix_linear_0_to_720deg', (t) => 4 * PI * t, rect(side, side), 'helix'),
    ],
  };
}

// ================= D. Scale laws =================
{
  const L = 100;
  const r = 10;
  const A = PI * r * r;
  const scaleCase = (id, s, integral, formula, frame = lineFrame(L), Lp = L, sec = circle(r), Asec = A) => {
    const V = Asec * Lp * integral;
    const mesh = meshCheck((t, u) => {
      const q = sec(u);
      return placeIn(frame(t), [q[0] * s(t), q[1] * s(t)]);
    }, false);
    return { id, formula, integralOfScaleSquared: sig(integral), value: sig(V), ...mesh, relErrRichardson: relErr(mesh.richardson, V) };
  };
  const s0 = 1;
  const s1 = 0.5;
  const d = s1 - s0;
  const w = (t) => t * t * (3 - 2 * t);
  const R = 50;
  const th = PI / 2;
  const side = 10;
  const areaLawV = (L * (100 + 25)) / 2;
  const areaMesh = meshCheck((t, u) => {
    const At = 100 + (25 - 100) * t;
    const k = Math.sqrt(At) / 10;
    const q = rect(10, 10)(u);
    return placeIn(lineFrame(L)(t), [q[0] * k, q[1] * k]);
  }, false);
  results.scale = {
    gap: 'SWG',
    generated: GENERATED,
    notes:
      'V = A integral_0^L s(t)^2 ds for a section scaled about its centroid on the path (centroid on the path keeps the first-moment term zero).',
    cases: [
      scaleCase(
        'linear_1_to_0.5_straight',
        (t) => s0 + d * t,
        (s0 * s0 + s0 * s1 + s1 * s1) / 3,
        'A L (s0^2 + s0 s1 + s1^2) / 3 (cone frustum)',
      ),
      scaleCase(
        'smoothstep_1_to_0.5_straight',
        (t) => s0 + d * w(t),
        s0 * s0 + s0 * d + (d * d * 13) / 35,
        'A L (s0^2 + s0 d + 13 d^2 / 35), d = s1 - s0; integral w = 1/2, integral w^2 = 13/35',
      ),
      scaleCase('expression_1_plus_0.25sin2pit', (t) => 1 + 0.25 * Math.sin(2 * PI * t), 1 + 0.25 * 0.25 * 0.5, 'A L (1 + 0.25^2 / 2)'),
      scaleCase(
        'linear_1_to_0.5_quarter_arc_square',
        (t) => s0 + d * t,
        (s0 * s0 + s0 * s1 + s1 * s1) / 3,
        'side^2 R theta (s0^2 + s0 s1 + s1^2) / 3',
        arcFrame(R, th),
        R * th,
        rect(side, side),
        side * side,
      ),
      {
        id: 'area_law_linear_100_to_25',
        formula: 'L (A0 + A1) / 2 (area law, not scale law)',
        value: sig(areaLawV),
        ...areaMesh,
        relErrRichardson: relErr(areaMesh.richardson, areaLawV),
        contrastLinearScaleLaw: sig((100 * L * (1 + 0.5 + 0.25)) / 3),
      },
    ],
  };
}

// ================= E. Two-rail sweeps =================
{
  const L = 100;
  const d0 = 20;
  const d1 = 10;
  const width = (t) => d0 + (d1 - d0) * t;
  const scaleV = (PI * L * (d0 * d0 + d0 * d1 + d1 * d1)) / 12;
  const scaleMesh = meshCheck((t, u) => {
    const q = circle(0.5)(u);
    return placeIn(lineFrame(L, [1, 0, 0], [0, 1, 0])(t), [q[0] * width(t), q[1] * width(t)]);
  }, false);
  const heightV = (PI * d0 * L * (d0 + d1)) / 8;
  const heightMesh = meshCheck((t, u) => {
    const q = circle(0.5)(u);
    return placeIn(lineFrame(L, [1, 0, 0], [0, 1, 0])(t), [q[0] * width(t), q[1] * d0]);
  }, false);
  // helicoid strip between two helical rails at radius a, opposite each other: section = straight segment
  const a = 10;
  const p = 20;
  const turns = 2;
  const c = p / (2 * PI);
  const F = (u) => (u * Math.sqrt(u * u + c * c) + c * c * Math.log(u + Math.sqrt(u * u + c * c))) / 2; // integral sqrt(u^2+c^2)
  const helicoid = 2 * PI * turns * 2 * (F(a) - F(0));
  // numeric check by Gauss-Legendre in u (exact integrand along v is constant)
  results.twoRail = {
    gap: 'SWG',
    generated: GENERATED,
    notes:
      'Rails y = +-(d(x)/2), z = 0, x in [0, L], d linear d0 -> d1. Section: a circle of diameter equal to the rail spacing (uniform scale) or with its height kept (stretch in the rail direction only).',
    cases: [
      {
        id: 'two_rails_uniform_scale',
        L,
        d0,
        d1,
        formula: 'pi L (d0^2 + d0 d1 + d1^2) / 12 (cone frustum)',
        value: sig(scaleV),
        ...scaleMesh,
        relErrRichardson: relErr(scaleMesh.richardson, scaleV),
      },
      {
        id: 'two_rails_maintain_height',
        L,
        d0,
        d1,
        heightKept: d0,
        formula: 'pi d0 L (d0 + d1) / 8 (elliptic sections)',
        value: sig(heightV),
        ...heightMesh,
        relErrRichardson: relErr(heightMesh.richardson, heightV),
      },
      {
        id: 'helicoid_between_two_helical_rails',
        railRadius: a,
        pitch: p,
        turns,
        formula: 'area = 2 pi n integral_{-a}^{a} sqrt(u^2 + c^2) du, c = p / 2 pi',
        areaValue: sig(helicoid),
        developable: false,
        gaussianCurvatureAtAxis: sig(-1 / (c * c)),
        gaussianCurvatureFormula: 'K(u) = -c^2 / (u^2 + c^2)^2',
      },
    ],
  };
}

// ================= F. Orientation modes =================
{
  const L = 100;
  const r = 10;
  const alpha = PI / 4; // path angle from the vertical
  const dir = [Math.sin(alpha), 0, Math.cos(alpha)];
  const normalV = PI * r * r * L;
  const fixedV = PI * r * r * L * Math.cos(alpha);
  const fixedMesh = meshCheck((t, u) => add(mul(dir, L * t), [circle(r)(u)[0], circle(r)(u)[1], 0]), false);
  const normalMesh = meshCheck((t, u) => placeIn(lineFrame(L, dir, [0, 1, 0])(t), circle(r)(u)), false);
  results.orientation = {
    gap: 'SWG',
    generated: GENERATED,
    notes:
      'Straight path at 45 deg to +Z. "normal": section plane normal to the path. "fixed": section stays in the start plane z = const (SolidWorks Keep Normal Constant, OCCT fixed trihedron).',
    cases: [
      {
        id: 'normal_to_path',
        formula: 'pi r^2 L',
        value: sig(normalV),
        ...normalMesh,
        relErrRichardson: relErr(normalMesh.richardson, normalV),
      },
      {
        id: 'fixed_plane_oblique',
        formula: 'pi r^2 L cos(alpha) (Cavalieri: oblique cylinder)',
        value: sig(fixedV),
        ...fixedMesh,
        relErrRichardson: relErr(fixedMesh.richardson, fixedV),
      },
    ],
  };
}

// ================= G. Ruled and developable lofts =================
function gaussLegendre(n) {
  const x = [];
  const w = [];
  for (let i = 1; i <= n; i++) {
    let z = Math.cos((PI * (i - 0.25)) / (n + 0.5));
    let pp = 0;
    for (let it = 0; it < 100; it++) {
      let p1 = 1;
      let p2 = 0;
      for (let j = 1; j <= n; j++) {
        const p3 = p2;
        p2 = p1;
        p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j;
      }
      pp = (n * (z * p1 - p2)) / (z * z - 1);
      const z1 = z;
      z = z1 - p1 / pp;
      if (Math.abs(z - z1) < 1e-15) break;
    }
    x.push(z);
    w.push(2 / ((1 - z * z) * pp * pp));
  }
  return { x, w };
}
{
  const R = 10;
  const h = 50;
  const twisted = [0, PI / 3, PI / 2, (2 * PI) / 3, PI].map((phi) => {
    const V = PI * R * R * h * (1 - (1 - Math.cos(phi)) / 3);
    const mesh = meshCheck(
      (t, u) => {
        const a = 2 * PI * u;
        const p0 = [R * Math.cos(a), R * Math.sin(a), 0];
        const p1 = [R * Math.cos(a + phi), R * Math.sin(a + phi), h];
        return add(mul(p0, 1 - t), mul(p1, t));
      },
      false,
      200,
      256,
    );
    return {
      id: `ruled_circles_twist_${sig((phi * 180) / PI, 4)}deg`,
      R,
      h,
      twistRad: sig(phi),
      formula: 'pi R^2 h (1 - (1 - cos phi) / 3)',
      value: sig(V),
      ...mesh,
      relErrRichardson: relErr(mesh.richardson, V),
      waistRadius: sig(R * Math.cos(phi / 2)),
    };
  });
  const r1 = 10;
  const r2 = 5;
  const slant = Math.hypot(h, r1 - r2);
  const frustumV = (PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;
  const lateral = PI * (r1 + r2) * slant;
  const rho1 = (r1 * slant) / (r1 - r2);
  const rho2 = (r2 * slant) / (r1 - r2);
  const sector = (2 * PI * (r1 - r2)) / slant;
  // hyperbolic paraboloid z = xy over the unit square (ruled loft of two skew segments): area = integral sqrt(1 + x^2 + y^2)
  const gl = gaussLegendre(40);
  let hp = 0;
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 40; j++) {
      const x = (gl.x[i] + 1) / 2;
      const y = (gl.x[j] + 1) / 2;
      hp += (gl.w[i] * gl.w[j] * Math.sqrt(1 + x * x + y * y)) / 4;
    }
  results.ruled = {
    gap: 'SWG',
    generated: GENERATED,
    notes:
      'Ruled loft between two circles of radius R, height h, the top one rotated by phi: |p(t)|^2 = R^2 (1 - 2 t (1 - t)(1 - cos phi)) so V = pi R^2 h (1 - (1 - cos phi)/3) (hyperboloid of one sheet; phi = pi: double cone).',
    cases: [
      ...twisted,
      {
        id: 'ruled_frustum_developable',
        r1,
        r2,
        h,
        formula: 'V = pi h (r1^2 + r1 r2 + r2^2) / 3; lateral = pi (r1 + r2) s; s = sqrt(h^2 + (r1 - r2)^2)',
        value: sig(frustumV),
        lateralArea: sig(lateral),
        gaussianCurvature: 0,
        flatPattern: {
          innerRadius: sig(rho2),
          outerRadius: sig(rho1),
          sectorAngleRad: sig(sector),
          innerArc: sig(rho2 * sector),
          outerArc: sig(rho1 * sector),
          innerArcExpected: sig(2 * PI * r2),
          outerArcExpected: sig(2 * PI * r1),
        },
      },
      {
        id: 'hyperbolic_paraboloid_unit',
        rulings: 'segment (0,0,0)-(1,0,0) to segment (0,1,0)-(1,1,1)',
        formula: 'area = integral over [0,1]^2 of sqrt(1 + x^2 + y^2) (Gauss-Legendre 40 x 40)',
        areaValue: sig(hp),
        gaussianCurvatureAtCentre: sig(-1 / (1.5 * 1.5)),
        gaussianCurvatureFormula: 'K = -1 / (1 + x^2 + y^2)^2',
        developable: false,
      },
    ],
  };
}

// ================= H. Loft end conditions and centreline =================
{
  const r0 = 10;
  const r1 = 5;
  const h = 50;
  const d = r1 - r0;
  // cubic Hermite in v with both end derivatives = (0, 0, h) (normal to the profiles, magnitude 1 = section distance)
  const hermite = (v) => {
    const h00 = 2 * v ** 3 - 3 * v ** 2 + 1;
    const h10 = v ** 3 - 2 * v ** 2 + v;
    const h01 = -2 * v ** 3 + 3 * v ** 2;
    const h11 = v ** 3 - v ** 2;
    return { radial: (rr0, rr1) => h00 * rr0 + h01 * rr1, z: (m0, m1) => h10 * m0 + h01 * h + h11 * m1 };
  };
  const V = PI * h * (r0 * r0 + r0 * d + (13 * d * d) / 35);
  const mesh = meshCheck((t, u) => {
    const H = hermite(t);
    const rr = H.radial(r0, r1);
    const a = 2 * PI * u;
    return [rr * Math.cos(a), rr * Math.sin(a), H.z(h, h)];
  }, false);
  const free = (PI * h * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;
  // magnitude 2: z(v) no longer linear; volume by quadrature of pi r(v)^2 z'(v)
  const gl = gaussLegendre(40);
  const volMag = (m) => {
    let s = 0;
    for (let i = 0; i < 40; i++) {
      const v = (gl.x[i] + 1) / 2;
      const rr = r0 + d * (3 * v * v - 2 * v ** 3);
      const dz = m * h * (3 * v * v - 4 * v + 1) + h * (6 * v - 6 * v * v) + m * h * (3 * v * v - 2 * v);
      s += (gl.w[i] / 2) * PI * rr * rr * dz;
    }
    return s;
  };
  results.loftEnds = {
    gap: 'SWG',
    generated: GENERATED,
    notes:
      'Two circles r0 = 10 (z = 0), r1 = 5 (z = 50). Condition "normal" with magnitude m: dS/dv at the section = m * (distance between section centroids) * section normal; 2 sections, cubic Hermite in v. m = 1 gives z linear and radius smoothstep.',
    cases: [
      {
        id: 'normal_both_ends_m1',
        magnitude: 1,
        formula: 'pi h (r0^2 + r0 d + 13 d^2 / 35), d = r1 - r0',
        value: sig(V),
        ...mesh,
        relErrRichardson: relErr(mesh.richardson, V),
        endAngleToNormalRad: 0,
        contrastFreeRuled: sig(free),
      },
      {
        id: 'normal_both_ends_m2',
        magnitude: 2,
        formula: "integral pi r(v)^2 z'(v) dv (Gauss-Legendre 40)",
        value: sig(volMag(2)),
        endAngleToNormalRad: 0,
        checkM1ByQuadrature: sig(volMag(1)),
      },
      {
        id: 'centreline_quarter_arc',
        R: 50,
        sectionRadius: 10,
        formula: 'pi r^2 R pi/2 (sections normal to a circular centreline = quarter torus)',
        value: sig(PI * 100 * 50 * (PI / 2)),
      },
    ],
  };
}

// ================= I. Gordon reproduction =================
{
  // f(u, v) = sin(pi u) + v^3 on [0,1]^2 ; 3 sections u = 0, 0.5, 1 ; 3 guides v = 0, 0.5, 1.
  // Gordon boolean sum with ANY partition-of-unity cardinal blending reproduces g(u) + h(v) exactly; skinning alone does not.
  const f = (u, v) => Math.sin(PI * u) + v ** 3;
  const nodes = [0, 0.5, 1];
  const lag = (x, i) => nodes.reduce((acc, xj, j) => (j === i ? acc : (acc * (x - xj)) / (nodes[i] - xj)), 1);
  let gordon = 0;
  let skin = 0;
  for (let a = 0; a <= 40; a++)
    for (let b = 0; b <= 40; b++) {
      const u = a / 40;
      const v = b / 40;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let i = 0; i < 3; i++) {
        s1 += lag(u, i) * f(nodes[i], v);
        s2 += lag(v, i) * f(u, nodes[i]);
        for (let j = 0; j < 3; j++) s3 += lag(u, i) * lag(v, j) * f(nodes[i], nodes[j]);
      }
      gordon = Math.max(gordon, Math.abs(s1 + s2 - s3 - f(u, v)));
      skin = Math.max(skin, Math.abs(s1 - f(u, v)));
    }
  results.gordon = {
    gap: 'SWG',
    generated: GENERATED,
    surface: 'z = sin(pi x) + y^3 on [0,1]^2',
    sections: 'x = 0, 0.5, 1 (curves along y: exact cubics)',
    guides: 'y = 0, 0.5, 1 (curves along x: sin, fitted)',
    gordonMaxDeviation: sig(gordon, 3),
    skinThroughSectionsOnlyMaxDeviation: sig(skin, 6),
    theorem:
      'For f = g(u) + h(v) and cardinal blending functions that sum to 1 in each direction, L_sections + L_guides - tensor = g + h exactly (README section 4.9).',
  };
}

// ================= J. Corners, surface orientation, alignment, coupling =================
{
  // L-shaped path (0,0,0) -> (100,0,0) -> (100,100,0), circle r 5
  const r = 5;
  const A = PI * r * r;
  const Rb = 30;
  const round = A * (2 * (100 - Rb) + (PI / 2) * Rb);
  const miter = A * 200;
  // surface orientation: segment of length 10 along the reference-surface normal, swept round a circle R 50 in z = 0
  const band = 2 * PI * 50 * 10;
  const annulus = PI * (60 * 60 - 50 * 50);
  // square 10 x 10, h 50, second section's seam one corner on (90 deg), parameter coupling
  const side = 10;
  const h = 50;
  const twisted = side * side * h * (1 - (1 - Math.cos(PI / 2)) / 3);
  const twistedMesh = meshCheck(
    (t, u) => {
      const p0 = rect(side, side)(u);
      const p1 = rot2(p0, PI / 2);
      return [(1 - t) * p0[0] + t * p1[0], (1 - t) * p0[1] + t * p1[1], h * t];
    },
    false,
    50,
    256,
  );
  // ruled loft square side 20 (z 0) -> circle r 10 (z 50), arc-length coupling, seams at the corner (10,-10) and the circle angle -45 deg
  const sq = rect(20, 20);
  const ruledSqCircle = meshCheck(
    (t, u) => {
      const p0 = sq(u);
      const a = -PI / 4 + 2 * PI * u;
      return [(1 - t) * p0[0] + t * 10 * Math.cos(a), (1 - t) * p0[1] + t * 10 * Math.sin(a), 50 * t];
    },
    false,
    50,
    512,
  );
  results.misc = {
    gap: 'SWG',
    generated: GENERATED,
    notes:
      'Closed forms: corner handling (Pappus on the bend + straight legs; a mitre joint of a round section keeps V = A (L1 + L2) by symmetry about the mitre plane), surface-orientation sheets, seam mis-alignment (det((1-t) I + t R_phi) = 1 - 2 t (1 - t)(1 - cos phi) for ANY section under parameter coupling); plus a numeric (reference-code) square-to-circle ruled loft.',
    cases: [
      {
        id: 'l_path_round_corner',
        sectionRadius: r,
        bendRadius: Rb,
        legs: [100, 100],
        formula: 'A (2 (100 - Rb) + Rb pi / 2)',
        value: sig(round),
      },
      { id: 'l_path_miter_corner', sectionRadius: r, legs: [100, 100], formula: 'A (L1 + L2)', value: sig(miter) },
      {
        id: 'surface_mode_plane_band',
        pathRadius: 50,
        segment: 10,
        surface: 'plane z = 0 (normal +Z)',
        formula: '2 pi R w',
        areaValue: sig(band),
      },
      {
        id: 'surface_mode_cylinder_annulus',
        pathRadius: 50,
        segment: 10,
        surface: 'cylinder r 50 (normal radial)',
        formula: 'pi ((R + w)^2 - R^2)',
        areaValue: sig(annulus),
      },
      {
        id: 'square_seam_off_by_one_corner',
        side,
        h,
        formula: 'side^2 h (1 - (1 - cos(pi/2)) / 3) = 2/3 of the prism',
        value: sig(twisted),
        ...twistedMesh,
        relErrRichardson: relErr(twistedMesh.richardson, twisted),
        alignedValue: sig(side * side * h),
      },
      {
        id: 'ruled_square20_to_circle10_arc_length',
        h: 50,
        method: 'reference code: ruled grid, arc-length coupling, Richardson',
        value: ruledSqCircle.richardson,
        ...ruledSqCircle,
      },
    ],
  };
}

// ---------- self-check: a plain cylinder through the same machinery ----------
{
  const c = meshCheck((t, u) => placeIn(lineFrame(10)(t), circle(2)(u)), false);
  const exact = PI * 4 * 10;
  if (Math.abs(c.richardson - exact) / exact > 1e-6) throw new Error(`mesh volume self-check failed: ${c.richardson} vs ${exact}`);
  results.selfCheck = { cylinder: { exact: sig(exact), ...c } };
}

for (const [name, data] of Object.entries(results)) writeFileSync(join(out, `${name}.json`), `${JSON.stringify(data, null, 1)}\n`);
const lines = [`wrote ${Object.keys(results).length} files to ${out}`];
for (const [name, data] of Object.entries(results))
  for (const c of data.cases ?? [])
    lines.push(`${name.padEnd(12)} ${String(c.id).padEnd(40)} ${c.value ?? c.areaValue} ${c.relErrRichardson ?? ''}`);
lines.push(
  `coil max deviation ${results.coilBaseline.maxDistanceToExactHelix} (interior ${results.coilBaseline.maxDistanceInteriorSegments})`,
);
lines.push(`gordon ${results.gordon.gordonMaxDeviation} skin-only ${results.gordon.skinThroughSectionsOnlyMaxDeviation}`);
process.stdout.write(`${lines.join('\n')}\n`);
