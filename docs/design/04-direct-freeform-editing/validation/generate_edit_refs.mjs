// Drag -> command round-trip references for pack 04 DIR: soft-selection falloff curves, today's edit_subdivision_cage arithmetic on a
// llull box cage, minimum-norm "drag a point on the curve / surface" pole updates, mirror-symmetric cage edits, and a latency probe.
// Run: node generate_edit_refs.mjs   (writes data/falloff_curves.csv, data/falloff_curves.json, data/cage_edit_cases.json,
//      data/point_drag_cases.json, data/symmetry_cases.json, data/latency_probe.json)

import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { boxCage, meshVolume, subdivide, vec } from './ref_catmull_clark.mjs';

const here = new URL('.', import.meta.url);
const write = (name, text) => writeFileSync(new URL(`data/${name}`, here), text);
const out = (name, value) => write(name, JSON.stringify(value, null, 1) + '\n');
const r12 = (x) => Number(x.toPrecision(12));
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// 1. Falloff curves f(t), t = (R - d) / R in [0, 1] (Blender transform_generics.cc calculatePropRatio, S9); llull today = smooth.
const FALLOFF = {
  constant: () => 1,
  linear: (t) => t,
  sharp: (t) => t * t,
  root: (t) => Math.sqrt(t),
  sphere: (t) => Math.sqrt(2 * t - t * t),
  smooth: (t) => Math.min(1, 3 * t * t - 2 * t * t * t),
  inverse_square: (t) => t * (2 - t),
};
const rows = ['dOverR,' + Object.keys(FALLOFF).join(',')];
const table = [];
for (let k = 0; k <= 20; k++) {
  const dOverR = k / 20;
  const t = 1 - dOverR;
  const values = Object.fromEntries(Object.entries(FALLOFF).map(([name, f]) => [name, r12(dOverR >= 1 ? 0 : f(t))]));
  table.push({ dOverR, ...values });
  rows.push([dOverR, ...Object.values(values)].join(','));
}
write('falloff_curves.csv', rows.join('\n') + '\n');
out('falloff_curves.json', {
  generated: '2026-10-22',
  source:
    'Blender main 7a8f04b3 source/blender/editors/transform/transform_generics.cc (PROP_SHARP dist^2, PROP_SMOOTH 3d^2-2d^3, PROP_ROOT sqrt, PROP_LIN, PROP_CONST, PROP_SPHERE sqrt(2d-d^2), PROP_INVSQUARE d(2-d)), with dist = (R - d)/R; selected elements weight 1; d >= R weight 0',
  llullToday:
    'edit_subdivision_cage uses smooth (t*t*(3-2t)) on Euclidean distance to the nearest fully selected vertex (packages/core/src/commands/solids/subdivisionCage.ts selectionWeights)',
  invariants: [
    'f(0)=0 except constant (=1)',
    'f(1)=1',
    'monotone non-decreasing in t',
    "smooth and inverse_square have f'(1)=0 (no kink at the selection)",
  ],
  table,
});

// 2. Today's edit_subdivision_cage on a llull box cage (boxCage replicates geometry/subdivision.ts vertex and face order).
const smoothstepWeight = (d, falloff) => (d <= 1e-9 ? 1 : falloff <= 0 || d >= falloff ? 0 : ((t) => t * t * (3 - 2 * t))(1 - d / falloff));
const cage = boxCage([2, 2, 2], [2, 2, 2]);
const top = cage.vertices.findIndex((p) => p[0] === 0 && p[1] === 0 && p[2] === 1);
const falloff = 1.5;
const move = [0, 0, 0.5];
const weights = cage.vertices.map((p) => smoothstepWeight(vec.norm(vec.sub(p, cage.vertices[top])), falloff));
const edited = { ...cage, vertices: cage.vertices.map((p, v) => vec.add(p, vec.mul(move, weights[v]))) };
const cageCases = {
  generated: '2026-10-22',
  case: 'add_subdivision_solid box size [2,2,2] segments [2,2,2] levels 3 at [0,0,0]; edit_subdivision_cage vertexIndices [top] falloff 1.5 translate [0,0,0.5]',
  topVertexIndex: top,
  vertexCount: cage.vertices.length,
  faceCount: cage.faces.length,
  weightsNonZero: weights.flatMap((w, v) => (w > 0 ? [{ v, w: r12(w) }] : [])),
  verticesAfter: edited.vertices.map((p) => p.map(round6)),
  meshVolumeLevel3Before: r12(Math.abs(meshVolume(subdivide(cage, 3)))),
  meshVolumeLevel3After: r12(Math.abs(meshVolume(subdivide(edited, 3)))),
  boxSegments1Level3Volume: r12(Math.abs(meshVolume(subdivide(boxCage([2, 2, 2], [1, 1, 1]), 3)))),
  note: 'verticesAfter = data.vertices of edit_subdivision_cage (world, rounded to 1e-6 like llull roundTo); volumes = mass_properties data.volume of the level-3 mesh (same fan triangulation as subdivisionTriangles)',
};
out('cage_edit_cases.json', cageCases);

// 3. Minimum-norm point drag (move the surface point, not a pole): delta_P_i = N_i(u) * D / sum_j N_j(u)^2 (least-norm solution of
// sum_i N_i(u) dP_i = D). Non-rational clamped B-splines; Cox-de Boor basis.
function basis(knots, p, u) {
  const n = knots.length - p - 1;
  const N = Array.from({ length: n }, (_, i) =>
    (u >= knots[i] && u < knots[i + 1]) || (u === knots[knots.length - 1] && i === n - 1 && u > knots[i]) ? 1 : 0,
  );
  for (let d = 1; d <= p; d++)
    for (let i = 0; i < n; i++) {
      const a = knots[i + d] - knots[i] === 0 ? 0 : ((u - knots[i]) / (knots[i + d] - knots[i])) * N[i];
      const b =
        i + 1 >= n + p - d + 1 || knots[i + d + 1] - knots[i + 1] === 0
          ? 0
          : ((knots[i + d + 1] - u) / (knots[i + d + 1] - knots[i + 1])) * (N[i + 1] ?? 0);
      N[i] = a + b;
    }
  return N;
}
const curveKnots = [0, 0, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1, 1];
const curvePoles = [
  [0, 0, 0],
  [1, 1, 0],
  [2, -1, 0],
  [3, 1, 0],
  [4, -1, 0],
  [5, 1, 0],
  [6, 0, 0],
];
const evalCurve = (poles, u) => basis(curveKnots, 3, u).reduce((s, w, i) => vec.add(s, vec.mul(poles[i], w)), [0, 0, 0]);
const uDrag = 0.4;
const D = [0, 1, 0];
const Nu = basis(curveKnots, 3, uDrag);
const sumSq = Nu.reduce((s, w) => s + w * w, 0);
const movedPoles = curvePoles.map((p, i) => vec.add(p, vec.mul(D, Nu[i] / sumSq)));
const achieved = vec.sub(evalCurve(movedPoles, uDrag), evalCurve(curvePoles, uDrag));
const poleShift = curvePoles.map((p, i) => vec.norm(vec.sub(movedPoles[i], p)));
// Surface: bicubic 5 x 5 net on a plane, drag S(0.3, 0.6) by [0, 0, 1].
const surfKnots = [0, 0, 0, 0, 0.5, 1, 1, 1, 1];
const net = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => [i, j, 0]));
const su = 0.3;
const sv = 0.6;
const Bu = basis(surfKnots, 3, su);
const Bv = basis(surfKnots, 3, sv);
let s2 = 0;
for (const a of Bu) for (const b of Bv) s2 += (a * b) ** 2;
const Ds = [0, 0, 1];
const evalSurf = (poles, u, v) => {
  const bu = basis(surfKnots, 3, u);
  const bv = basis(surfKnots, 3, v);
  let p = [0, 0, 0];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) p = vec.add(p, vec.mul(poles[i][j], bu[i] * bv[j]));
  return p;
};
const net2 = net.map((row, i) => row.map((p, j) => vec.add(p, vec.mul(Ds, (Bu[i] * Bv[j]) / s2))));
const achievedS = vec.sub(evalSurf(net2, su, sv), evalSurf(net, su, sv));
out('point_drag_cases.json', {
  generated: '2026-10-22',
  method:
    'least-norm control point update for a prescribed displacement of one curve / surface point; same family as Piegl & Tiller "control point based shape modification" (S1) — derivation: minimise sum |dP_i|^2 s.t. sum N_i(u) dP_i = D gives dP_i = N_i(u) D / sum N_j(u)^2',
  curve: {
    degree: 3,
    knots: curveKnots,
    poles: curvePoles,
    u: uDrag,
    displacement: D,
    basisAtU: Nu.map(r12),
    poleDeltas: movedPoles.map((p, i) => vec.sub(p, curvePoles[i]).map(r12)),
    achievedDisplacement: achieved.map(r12),
    residual: vec.norm(vec.sub(achieved, D)),
    untouchedPoles: poleShift.flatMap((d, i) => (d === 0 ? [i] : [])),
  },
  surface: {
    degree: [3, 3],
    knots: surfKnots,
    net: '5 x 5 poles [i, j, 0]',
    uv: [su, sv],
    displacement: Ds,
    achievedDisplacement: achievedS.map(r12),
    residual: vec.norm(vec.sub(achievedS, Ds)),
    maxPoleDelta: r12(Math.max(...net2.flat().map((p, k) => vec.norm(vec.sub(p, net.flat()[k]))))),
  },
});

// 4. Mirror symmetry (plane x = 0) on a symmetric box cage segments [2,1,1]: drag vertex v by D; its mirror moves by (-Dx, Dy, Dz);
// vertices on the plane keep x. The cage and the level-2 surface stay mirror symmetric (max asymmetry 0).
const sym = boxCage([2, 2, 2], [2, 1, 1]);
const mirrorOf = sym.vertices.map((p) => sym.vertices.findIndex((q) => q[0] === -p[0] && q[1] === p[1] && q[2] === p[2]));
const dragged = sym.vertices.findIndex((p) => p[0] === 1 && p[1] === 1 && p[2] === 1);
const Dm = [0.3, 0.2, 0.4];
const symEdited = {
  ...sym,
  vertices: sym.vertices.map((p, v) => (v === dragged ? vec.add(p, Dm) : v === mirrorOf[dragged] ? vec.add(p, [-Dm[0], Dm[1], Dm[2]]) : p)),
};
const level2 = subdivide(symEdited, 2);
let asym = 0;
for (const p of level2.vertices) {
  const best = level2.vertices.reduce((m, q) => Math.min(m, vec.norm(vec.sub(q, [-p[0], p[1], p[2]]))), Infinity);
  asym = Math.max(asym, best);
}
out('symmetry_cases.json', {
  generated: '2026-10-22',
  cage: 'box size [2,2,2] segments [2,1,1] (plane x = 0 holds 4 cage vertices)',
  draggedVertex: dragged,
  mirrorVertex: mirrorOf[dragged],
  displacement: Dm,
  mirroredDisplacement: [-Dm[0], Dm[1], Dm[2]],
  everyVertexHasMirror: mirrorOf.every((m) => m >= 0),
  level2MaxAsymmetry: asym,
  level2Volume: r12(Math.abs(meshVolume(level2))),
});

// 5. Latency probe: wall time of the pure-JS reference subdivision (same algorithm class as llull's core subdivide) per cage size and
// level, median of 5 runs. Informational (machine dependent): it sizes the preview budget, it does not gate.
const probe = [];
for (const n of [1, 2, 4, 6, 8]) {
  const c = boxCage([2, 2, 2], [n, n, n]);
  for (const L of [1, 2, 3]) {
    const times = [];
    let quads = 0;
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      quads = subdivide(c, L).faces.length;
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    probe.push({
      segments: n,
      cageVertices: c.vertices.length,
      level: L,
      quads,
      triangles: quads * 2,
      medianMs: Number(times[2].toFixed(2)),
    });
  }
}
out('latency_probe.json', {
  generated: '2026-10-22',
  machine: { node: process.version, cpu: cpus()[0]?.model ?? 'unknown', platform: process.platform },
  grade: 'C (one machine, reference JS implementation, not llull code); re-measure with the llull bench of TECHNICAL_SPEC section 8',
  budgetsFrom: 'web.dev RAIL (S10): frame <= 16 ms (aim 10 ms), response to input <= 100 ms',
  probe,
});
process.stdout.write(
  JSON.stringify({
    top,
    cageCases: {
      before: cageCases.meshVolumeLevel3Before,
      after: cageCases.meshVolumeLevel3After,
      seg1: cageCases.boxSegments1Level3Volume,
    },
    residual: vec.norm(vec.sub(achieved, D)),
    asym,
    probe,
  }) + '\n',
);
