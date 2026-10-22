// IMP validation — strut (beam) lattice references, cubic cell of size a, struts = cylinders of radius r (x = r/a), periodic.
//   * total strut length per cell L (closed form) and the first-order relative density ρ1 = π r² L / a³ (node overlap ignored)
//   * the exact relative density of the periodic union, by quasi-Monte Carlo quadrature of the strut-union indicator (two sample counts)
//   * the simple-cubic closed form with node overlap by inclusion–exclusion (Steinmetz solids): ρ = 3π x² − 8√2 x³ (x < 1/2)
//   * beam-lattice bookkeeping for an n×n×n block (nodes, beams) and a single conical-frustum beam volume (3MF beam geometry)
// Run: node generate_strut_refs.mjs  (about a minute) -> data/strut_lattices.json
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const r7 = (x) => Number(x.toPrecision(7));
const S2 = Math.SQRT2;
const S3 = Math.sqrt(3);

// Struts of one cell in unit coordinates; the periodic lattice is these translated by every integer vector.
const corners = [];
for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) corners.push([x, y, z]);
const faceCentres = [
  [0.5, 0.5, 0],
  [0.5, 0, 0.5],
  [0, 0.5, 0.5],
  [0.5, 0.5, 1],
  [0.5, 1, 0.5],
  [1, 0.5, 0.5],
];
const LATTICES = {
  cubic: {
    struts: [
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 1],
      ],
    ],
    lengthPerCell: 3,
    lengthFormula: '3a',
    stretchDominated: false,
  },
  bcc: {
    struts: corners.map((c) => [[0.5, 0.5, 0.5], c]),
    lengthPerCell: 4 * S3,
    lengthFormula: '4√3 a (8 half body diagonals)',
    stretchDominated: false,
  },
  fcc: {
    // face crosses: both diagonals of the 3 faces through the origin (the other 3 faces are their periodic images)
    struts: [
      [
        [0, 0, 0],
        [1, 1, 0],
      ],
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, 0],
        [1, 0, 1],
      ],
      [
        [1, 0, 0],
        [0, 0, 1],
      ],
      [
        [0, 0, 0],
        [0, 1, 1],
      ],
      [
        [0, 1, 0],
        [0, 0, 1],
      ],
    ],
    lengthPerCell: 6 * S2,
    lengthFormula: '6√2 a (face diagonals, each face shared by 2 cells)',
    stretchDominated: false,
  },
  octet: {
    // FCC face crosses + the 12 edges of the octahedron joining the face centres of the cell
    struts: (() => {
      const s = [
        [
          [0, 0, 0],
          [1, 1, 0],
        ],
        [
          [1, 0, 0],
          [0, 1, 0],
        ],
        [
          [0, 0, 0],
          [1, 0, 1],
        ],
        [
          [1, 0, 0],
          [0, 0, 1],
        ],
        [
          [0, 0, 0],
          [0, 1, 1],
        ],
        [
          [0, 1, 0],
          [0, 0, 1],
        ],
      ];
      for (let i = 0; i < 6; i += 1)
        for (let j = i + 1; j < 6; j += 1) {
          const a = faceCentres[i];
          const b = faceCentres[j];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          if (Math.abs(d - Math.SQRT1_2) < 1e-9) s.push([a, b]);
        }
      return s;
    })(),
    lengthPerCell: 12 * S2,
    lengthFormula: '12√2 a (24 struts of a/√2: 12 on face diagonals, 12 octahedron edges)',
    stretchDominated: true,
  },
};

function segDist2(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  let t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const d = [ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t];
  return d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
}

/** Periodic images of the cell struts that come within `rMax` of the unit cell. */
function nearbySegments(struts, rMax) {
  const out = [];
  for (let i = -1; i <= 1; i += 1)
    for (let j = -1; j <= 1; j += 1)
      for (let k = -1; k <= 1; k += 1)
        for (const [a, b] of struts) {
          const A = [a[0] + i, a[1] + j, a[2] + k];
          const B = [b[0] + i, b[1] + j, b[2] + k];
          const lo = [0, 1, 2].map((q) => Math.min(A[q], B[q]) - rMax);
          const hi = [0, 1, 2].map((q) => Math.max(A[q], B[q]) + rMax);
          if (lo.every((v) => v < 1) && hi.every((v) => v > 0)) out.push([A, B]);
        }
  // de-duplicate (images of a strut that coincide)
  const key = ([A, B]) => [...A, ...B].map((v) => v.toFixed(6)).join(',');
  const seen = new Set();
  return out.filter((s) => {
    const k1 = key(s);
    const k2 = key([s[1], s[0]]);
    if (seen.has(k1) || seen.has(k2)) return false;
    seen.add(k1);
    return true;
  });
}

// Quasi-Monte Carlo (Roberts R3 low-discrepancy sequence): an axis-aligned midpoint grid aliases with axis-aligned struts
// (1 % error on the cubic closed form at 160³), the R3 points do not.
const PHI3 = 1.2207440846057596; // root of x⁴ = x + 1
const R3 = [1 / PHI3, 1 / PHI3 ** 2, 1 / PHI3 ** 3];
function density(struts, x, count) {
  const segs = nearbySegments(struts, x);
  const r2 = x * x;
  let inside = 0;
  const p = [0, 0, 0];
  for (let n = 1; n <= count; n += 1) {
    for (let q = 0; q < 3; q += 1) p[q] = (0.5 + R3[q] * n) % 1;
    for (const [a, b] of segs)
      if (segDist2(p, a, b) <= r2) {
        inside += 1;
        break;
      }
  }
  return inside / count;
}

const X_VALUES = [0.02, 0.05, 0.08, 0.1, 0.15];
const lattices = {};
for (const [name, lat] of Object.entries(LATTICES)) {
  const rows = X_VALUES.map((x) => {
    const coarse = density(lat.struts, x, 2 ** 20);
    const fine = density(lat.struts, x, 2 ** 22);
    const rho1 = Math.PI * x * x * lat.lengthPerCell;
    const row = {
      rOverA: x,
      rho1: r7(rho1),
      rhoQuadrature: r7(fine),
      convergence: r7(Math.abs(fine - coarse)),
      overlapLoss: r7(rho1 - fine),
    };
    if (name === 'cubic') row.rhoClosedForm = r7(3 * Math.PI * x * x - 8 * S2 * x ** 3);
    return row;
  });
  lattices[name] = {
    strutsPerCell: lat.struts.length,
    lengthPerCell: r7(lat.lengthPerCell),
    lengthFormula: lat.lengthFormula,
    rho1Formula: `π (r/a)² · ${lat.lengthFormula.split(' ')[0]}`,
    maxwellStretchDominated: lat.stretchDominated,
    rows,
  };
}

// Beam bookkeeping for an n×n×n block of simple-cubic cells: nodes (n+1)³, beams 3 n (n+1)².
const block = [1, 2, 3, 4].map((n) => ({ n, nodes: (n + 1) ** 3, beams: 3 * n * (n + 1) ** 2 }));
// BCC block: nodes (n+1)³ + n³, beams 8 n³.
const bccBlock = [1, 2, 3, 4].map((n) => ({ n, nodes: (n + 1) ** 3 + n ** 3, beams: 8 * n ** 3 }));
// 3MF beam = conical frustum between radii r1, r2 over length h (spec: radii interpolated linearly), caps excluded.
const frustum = (h, r1, r2) => (Math.PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;

writeFileSync(
  path.join(here, 'data', 'strut_lattices.json'),
  JSON.stringify(
    {
      generated: 'generate_strut_refs.mjs',
      method:
        'quasi-Monte Carlo quadrature (R3 sequence) of the periodic strut-union indicator, 2²² points per cell ("convergence" = |2²² − 2²⁰|); struts are cylinders through the nodes (caps are inside neighbouring struts in a periodic lattice: every node lies on a strut that continues through it)',
      cubicClosedForm: {
        formula: 'ρ = 3π x² − 8√2 x³, x = r/a < 1/2',
        derivation:
          'inclusion–exclusion at the node: 3 cylinders of length a (3π r² a) − 3 pairwise bicylinders (3 · 16/3 r³) + 1 tricylinder (8(2 − √2) r³) = 3π r² a − 8√2 r³',
      },
      lattices,
      cubicBlocks: block,
      bccBlocks: bccBlock,
      frustumExamples: [
        { h: 10, r1: 1, r2: 1, volume: r7(frustum(10, 1, 1)) },
        { h: 10, r1: 1, r2: 0.5, volume: r7(frustum(10, 1, 0.5)) },
      ],
    },
    null,
    1,
  ) + '\n',
);
process.stdout.write('strut refs written\n');
