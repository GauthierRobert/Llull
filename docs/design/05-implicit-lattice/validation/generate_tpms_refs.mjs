// IMP validation — TPMS references (nodal / level-set approximations, unit cell a = 1, X = 2πx/a):
//   gyroid  G = sin X cos Y + sin Y cos Z + sin Z cos X
//   P       P = cos X + cos Y + cos Z
//   D       D = cos X cos Y cos Z − sin X sin Y sin Z
// Solid conventions (TECHNICAL_SPEC §5.4): network ("skeletal") solid = {F ≤ t}; sheet ("matrix") solid = {|F| ≤ t};
// distance-normalised sheet = {|F/|∇F|| ≤ w/2} (wall thickness ≈ w, physical units).
// Outputs data/tpms_volume_fraction.json (fraction vs t / w), data/tpms_surface.json (area per cell, |∇F| on the surface).
// Run: node generate_tpms_refs.mjs   (about a minute)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { marchingTetrahedra, meshMeasures } from './isosurface_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const r = (x) => Number(x.toPrecision(7));
const TAU = 2 * Math.PI;

const surfaces = {
  gyroid: {
    f: (X, Y, Z) => Math.sin(X) * Math.cos(Y) + Math.sin(Y) * Math.cos(Z) + Math.sin(Z) * Math.cos(X),
    g: (X, Y, Z) => [
      Math.cos(X) * Math.cos(Y) - Math.sin(Z) * Math.sin(X),
      -Math.sin(X) * Math.sin(Y) + Math.cos(Y) * Math.cos(Z),
      -Math.sin(Y) * Math.sin(Z) + Math.cos(Z) * Math.cos(X),
    ],
  },
  schwarzP: { f: (X, Y, Z) => Math.cos(X) + Math.cos(Y) + Math.cos(Z), g: (X, Y, Z) => [-Math.sin(X), -Math.sin(Y), -Math.sin(Z)] },
  diamond: {
    f: (X, Y, Z) => Math.cos(X) * Math.cos(Y) * Math.cos(Z) - Math.sin(X) * Math.sin(Y) * Math.sin(Z),
    g: (X, Y, Z) => [
      -Math.sin(X) * Math.cos(Y) * Math.cos(Z) - Math.cos(X) * Math.sin(Y) * Math.sin(Z),
      -Math.cos(X) * Math.sin(Y) * Math.cos(Z) - Math.sin(X) * Math.cos(Y) * Math.sin(Z),
      -Math.cos(X) * Math.cos(Y) * Math.sin(Z) - Math.sin(X) * Math.sin(Y) * Math.cos(Z),
    ],
  },
};

const T_VALUES = [-1.2, -1, -0.8, -0.6, -0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1, 1.2];
const SHEET_T = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];
const W_VALUES = [0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3];

/** Midpoint-rule fractions on an N³ grid over one cell (exact symmetry of the grid under X -> −X keeps t = 0 at 1/2). */
function fractions(s, N) {
  const net = new Float64Array(T_VALUES.length);
  const sheet = new Float64Array(SHEET_T.length);
  const norm = new Float64Array(W_VALUES.length);
  let fMin = Infinity;
  let fMax = -Infinity;
  for (let k = 0; k < N; k += 1) {
    const Z = (TAU * (k + 0.5)) / N;
    for (let j = 0; j < N; j += 1) {
      const Y = (TAU * (j + 0.5)) / N;
      for (let i = 0; i < N; i += 1) {
        const X = (TAU * (i + 0.5)) / N;
        const F = s.f(X, Y, Z);
        if (F < fMin) fMin = F;
        if (F > fMax) fMax = F;
        for (let q = 0; q < T_VALUES.length; q += 1) if (F <= T_VALUES[q]) net[q] += 1;
        const a = Math.abs(F);
        for (let q = 0; q < SHEET_T.length; q += 1) if (a <= SHEET_T[q]) sheet[q] += 1;
        const gr = s.g(X, Y, Z);
        const gn = TAU * Math.hypot(gr[0], gr[1], gr[2]); // physical gradient, a = 1
        const d = gn > 0 ? a / gn : Infinity;
        for (let q = 0; q < W_VALUES.length; q += 1) if (d <= W_VALUES[q] / 2) norm[q] += 1;
      }
    }
  }
  const total = N ** 3;
  return {
    net: [...net].map((c) => c / total),
    sheet: [...sheet].map((c) => c / total),
    norm: [...norm].map((c) => c / total),
    fMin,
    fMax,
  };
}

const vf = {};
const surf = {};
for (const [name, s] of Object.entries(surfaces)) {
  const coarse = fractions(s, 120);
  const fine = fractions(s, 240);
  const pack = (values, key, label) =>
    values.map((v, q) => ({ [label]: v, fraction: r(fine[key][q]), convergence: r(Math.abs(fine[key][q] - coarse[key][q])) }));
  vf[name] = {
    fRange: [r(fine.fMin), r(fine.fMax)],
    network: pack(T_VALUES, 'net', 't'),
    sheet: pack(SHEET_T, 'sheet', 't'),
    sheetDistanceNormalised: pack(W_VALUES, 'norm', 'wOverA'),
  };
  // surface F = 0: area per cell from the reference mesher at two resolutions, |∇F| statistics on the mesh vertices
  const area = {};
  let gradStats = null;
  for (const n of [96, 192]) {
    const mesh = marchingTetrahedra((p) => s.f(TAU * p[0], TAU * p[1], TAU * p[2]), [0, 0, 0], [1, 1, 1], [n, n, n]);
    area[n] = meshMeasures(mesh).area;
    if (n === 192) {
      let gMin = Infinity;
      let gMax = 0;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const gr = s.g(TAU * mesh.positions[i], TAU * mesh.positions[i + 1], TAU * mesh.positions[i + 2]);
        const gn = TAU * Math.hypot(gr[0], gr[1], gr[2]);
        gMin = Math.min(gMin, gn);
        gMax = Math.max(gMax, gn);
      }
      gradStats = { min: r(gMin), max: r(gMax), ratio: r(gMax / gMin) };
    }
  }
  const richardson = area[192] + (area[192] - area[96]) / 3; // second-order extrapolation
  surf[name] = {
    areaPerCell_a1: {
      n96: r(area[96]),
      n192: r(area[192]),
      extrapolated: r(richardson),
      unit: 'a² per cell of volume a³ (specific surface a⁻¹)',
    },
    gradientOnSurface_a1: gradStats,
    rawSheetThicknessRatio: gradStats.ratio,
    note: 'raw sheet {|F| ≤ t} has local wall thickness ≈ 2t/|∇F|: it varies by the ratio max|∇F|/min|∇F| over the surface; the distance-normalised sheet removes this to first order',
  };
}

// Slope of the sheet fraction at t -> 0 (descriptive): fraction ≈ slope · t
for (const name of Object.keys(vf)) vf[name].sheetSlopeAtSmallT = r(vf[name].sheet[0].fraction / SHEET_T[0]);

writeFileSync(
  path.join(here, 'data', 'tpms_volume_fraction.json'),
  JSON.stringify(
    {
      generated: 'generate_tpms_refs.mjs',
      definitions: {
        gyroid: 'sin X cos Y + sin Y cos Z + sin Z cos X',
        schwarzP: 'cos X + cos Y + cos Z',
        diamond: 'cos X cos Y cos Z − sin X sin Y sin Z',
        X: '2π x / a (a = cell size)',
        network: 'solid = {F ≤ t}',
        sheet: 'solid = {|F| ≤ t}',
        sheetDistanceNormalised: 'solid = {|F|/|∇F| ≤ w/2}, w = wall thickness, here as w/a',
      },
      symmetry:
        't = 0 network fraction is exactly 1/2: gyroid G(−x) = −G(x); P(x + a/2·(1,1,1)) = −P(x); D(x + (a/2, 0, 0)) = −D(x) — each a volume-preserving map exchanging {F < 0} and {F > 0}',
      method: 'midpoint rule on 240³ points per cell; "convergence" = |240³ − 120³| difference',
      surfaces: vf,
    },
    null,
    1,
  ) + '\n',
);
writeFileSync(
  path.join(here, 'data', 'tpms_surface.json'),
  JSON.stringify({ generated: 'generate_tpms_refs.mjs', surfaces: surf }, null, 1) + '\n',
);
process.stdout.write('tpms refs written\n');
