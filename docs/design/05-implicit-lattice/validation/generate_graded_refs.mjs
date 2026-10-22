// IMP validation — composite references built on the TPMS definitions of generate_tpms_refs.mjs:
//   1. shell + gyroid infill of a cube (exact by symmetry)
//   2. graded distance-normalised gyroid sheet, wall thickness ramped along z (quadrature reference)
//   3. cylindrical cell map: seam continuity for integer / non-integer cell counts around
// Run: node generate_graded_refs.mjs -> data/composites.json
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const r7 = (x) => Number(x.toPrecision(7));
const TAU = 2 * Math.PI;
const G = (X, Y, Z) => Math.sin(X) * Math.cos(Y) + Math.sin(Y) * Math.cos(Z) + Math.sin(Z) * Math.cos(X);
const gradG = (X, Y, Z) => [
  Math.cos(X) * Math.cos(Y) - Math.sin(Z) * Math.sin(X),
  -Math.sin(X) * Math.sin(Y) + Math.cos(Y) * Math.cos(Z),
  -Math.sin(Y) * Math.sin(Z) + Math.cos(Z) * Math.cos(X),
];

// 1. Cube side 40 centred at the origin, wall 2 (shell inward), infill = gyroid network {G ≤ 0}, a = 12, inner cube 36 = 3a centred at
//    the origin. G(−x) = −G(x) and the inner cube is symmetric about the origin, so the infill is exactly half the inner cube.
const shellInfill = (() => {
  const side = 40;
  const wall = 2;
  const a = 12;
  const inner = side - 2 * wall;
  const exact = side ** 3 - inner ** 3 + 0.5 * inner ** 3;
  // quadrature cross-check of the infill fraction inside the inner cube
  const N = 180;
  let count = 0;
  for (let k = 0; k < N; k += 1)
    for (let j = 0; j < N; j += 1)
      for (let i = 0; i < N; i += 1) {
        const p = [i, j, k].map((q) => -inner / 2 + (inner * (q + 0.5)) / N);
        if (G((TAU * p[0]) / a, (TAU * p[1]) / a, (TAU * p[2]) / a) <= 0) count += 1;
      }
  return {
    side,
    wall,
    cellSize: a,
    innerSide: inner,
    volumeExact: exact,
    infillFractionQuadrature180: r7(count / N ** 3),
    derivation: 'V = s³ − (s − 2w)³ + ½ (s − 2w)³ ; the shell and the infill are disjoint (infill clipped to the inner cube)',
  };
})();

// 2. Graded sheet: column of 1 × 1 × 4 cells (a = 10), wall w(z) = 0.5 + 2 z / 40 (0.5 mm at z = 0 to 2.5 mm at z = 40),
//    solid = {|G| / |∇G| ≤ w(z)/2} with ∇ in physical units. Reference = midpoint quadrature (two resolutions).
const graded = (() => {
  const a = 10;
  const H = 40;
  const w = (z) => 0.5 + (2 * z) / H;
  const run = (n) => {
    let count = 0;
    const nz = 4 * n;
    for (let k = 0; k < nz; k += 1) {
      const z = (H * (k + 0.5)) / nz;
      const Z = (TAU * z) / a;
      const half = w(z) / 2;
      for (let j = 0; j < n; j += 1) {
        const Y = (TAU * (j + 0.5)) / n;
        for (let i = 0; i < n; i += 1) {
          const X = (TAU * (i + 0.5)) / n;
          const g = gradG(X, Y, Z);
          const gn = (TAU / a) * Math.hypot(g[0], g[1], g[2]);
          if (Math.abs(G(X, Y, Z)) <= half * gn) count += 1;
        }
      }
    }
    return count / (nz * n * n);
  };
  const coarse = run(80);
  const fine = run(160);
  return {
    cellSize: a,
    height: H,
    wallLaw: 'w(z) = 0.5 + 2 z / 40 (mm), linear ramp',
    fraction: r7(fine),
    convergence: r7(Math.abs(fine - coarse)),
    volumePerColumn: r7(fine * a * a * H),
    note: 'relative density of the graded column; the agent-facing check is implicit_properties.relativeDensity of the same plan',
  };
})();

// 3. Cylindrical map: u = n θ / 2π (cells around), v = z / a, w = (ρ − ρ0) / a. Seam mismatch at θ = 0 vs 2π.
const seam = [6, 6.5, 8].map((n) => {
  let maxJump = 0;
  for (let s = 0; s < 200; s += 1) {
    const zz = (s / 200) * 3;
    const ww = ((s * 7) % 200) / 200;
    const at = (theta) => G(TAU * ((n * theta) / TAU), TAU * zz, TAU * ww);
    maxJump = Math.max(maxJump, Math.abs(at(0) - at(TAU)));
  }
  return { cellsAround: n, maxSeamJump: r7(maxJump), continuous: maxJump < 1e-9 };
});

writeFileSync(
  path.join(here, 'data', 'composites.json'),
  JSON.stringify({ generated: 'generate_graded_refs.mjs', shellInfill, graded, cylindricalSeam: seam }, null, 1) + '\n',
);
process.stdout.write('composite refs written\n');
