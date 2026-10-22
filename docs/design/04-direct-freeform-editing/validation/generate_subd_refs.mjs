// Analytic and numerical Catmull-Clark reference data for pack 04 DIR (VC-DIR-01..08, 20).
// Run: node generate_subd_refs.mjs   (writes data/subd_limit_masks.json, data/subd_cube_cases.json, data/subd_regular_torus.json)
// Every closed form is cross-checked numerically by an independent path (mask vs deep subdivision, formula vs convergence ratio).

import { writeFileSync } from 'node:fs';
import {
  SHARP_INFINITE,
  bsplineBasis,
  cubeCage,
  edgeKey,
  oneRing,
  lambdaOf,
  meshVolume,
  prismCage,
  smoothLimit,
  smoothLimitTangents,
  subdivide,
  subdivideOnce,
  torusCage,
  vec,
  withAllEdgesSharp,
} from './ref_catmull_clark.mjs';

const here = new URL('.', import.meta.url);
const out = (name, value) => writeFileSync(new URL(`data/${name}`, here), JSON.stringify(value, null, 1) + '\n');
const r12 = (x) => Number(x.toPrecision(12));
const p12 = (p) => p.map(r12);

// 1. Limit masks per valence + subdominant eigenvalue; numeric check of lambda on a perturbed prism cap (valence n after 1 step).
const masks = [];
for (let n = 3; n <= 12; n++) {
  const fw = 1 / (n * (n + 5));
  const lam = lambdaOf(n);
  // Numeric: cap-centre vertex of an n-gon prism after 1 step has valence n. Perturb one ring vertex, then follow the vertex down levels:
  // |p_k - L| ratio -> lambda (subdominant) when the perturbation excites the tangent eigenvectors.
  let cage = subdivideOnce(prismCage(n));
  const capCentre = cage.vertices.length - 2; // face point of the top n-gon (faces order: n sides, top, bottom)
  const ring = new Set();
  cage.faces.forEach((f) => f.includes(capCentre) && f.forEach((v) => v !== capCentre && ring.add(v)));
  const bumped = [...ring][0];
  cage = { ...cage, vertices: cage.vertices.map((p, i) => (i === bumped ? vec.add(p, [0.05, 0.02, 0.03]) : p)) };
  const limit = smoothLimit(cage, capCentre).point;
  // 1-ring radius about the limit point: the edge-neighbours of the centre contract by lambda per step (subdominant eigenvalue).
  const ringRadius = (cg) => {
    const { e } = oneRing(cg, capCentre);
    return e.reduce((sum, w) => sum + vec.norm(vec.sub(cg.vertices[w], limit)), 0) / e.length;
  };
  const radius = [];
  let c = cage;
  for (let k = 0; k < 7; k++) {
    radius.push(ringRadius(c));
    if (k < 6) c = subdivideOnce(c);
  }
  masks.push({
    valence: n,
    limitWeights: {
      vertex: r12(1 - n * 5 * fw),
      edgeEach: r12(4 * fw),
      faceEach: r12(fw),
      formula: '(n^2 v + 4 sum e_i + sum f_i) / (n (n + 5))',
    },
    lambdaFormula: r12(lam),
    lambdaMeasured: r12(radius[6] / radius[5]),
    maskVsLevel6Distance: r12(vec.norm(vec.sub(c.vertices[capCentre], limit))),
  });
}
out('subd_limit_masks.json', {
  generated: '2026-10-22',
  generator: 'generate_subd_refs.mjs',
  source:
    'OpenSubdiv sdc/catmarkScheme.h assignSmoothLimitMask / assignSmoothLimitTangentMasks (S3); lambda = 5/16 + (cos t + cos(t/2) sqrt(2(9 + cos t)))/16, t = 2 pi / n',
  check:
    'lambdaMeasured = ratio of successive mean 1-ring radii (edge-neighbour distance to the mask limit) around the cap-centre vertex on a perturbed n-gon prism (levels 5->6); maskVsLevel6Distance = how far 6 more subdivision steps still are from the mask limit',
  regularValence4: { lambda: 0.5, limitStencil: '1/36 [[1,4,1],[4,16,4],[1,4,1]]' },
  masks,
});

// 2. Cube cage (half-size 1): limit points, normals, volumes, creased variants, today's llull level-L volumes.
const cube = cubeCage(1);
const level1 = subdivideOnce(cube);
const cornerLimit0 = smoothLimit(cube, 6).point; // vertex (1,1,1)
const cornerLimit1 = smoothLimit(level1, 6).point; // same vertex after one step (vertices keep their index)
// After one step: edge points follow the vertices, face points follow the edges (llull order). Find the top-face point and the
// point of edge 6-7 by position.
const findNear = (cage, target) =>
  cage.vertices.reduce((best, p, i) => (vec.norm(vec.sub(p, target)) < vec.norm(vec.sub(cage.vertices[best], target)) ? i : best), 0);
const faceCentre1 = findNear(level1, [0, 0, 1]);
const edgeMid1 = findNear(level1, [0, 1, 1]);
const faceLimit = smoothLimit(level1, faceCentre1).point;
const edgeLimit = smoothLimit(level1, edgeMid1).point;
const deep = subdivide(cube, 7);
const cornerNormal = smoothLimitTangents(level1, 6).normal;
const smoothVolumes = [];
for (let L = 0; L <= 7; L++) smoothVolumes.push(r12(Math.abs(meshVolume(subdivide(cube, L)))));
// Richardson with the observed geometric rate q = (V_{L} - V_{L-1}) / (V_{L-1} - V_{L-2}).
const q = (smoothVolumes[7] - smoothVolumes[6]) / (smoothVolumes[6] - smoothVolumes[5]);
const volumeLimitEstimate = smoothVolumes[7] + ((smoothVolumes[7] - smoothVolumes[6]) * q) / (1 - q);
const sharpVolumes = (s) => [0, 1, 2, 3, 4, 5].map((L) => r12(Math.abs(meshVolume(subdivide(withAllEdgesSharp(cube, s), L)))));
const oneEdgeSharp = { ...cube, sharpness: new Map([[edgeKey(6, 7), SHARP_INFINITE]]) };
const oneEdge3 = subdivide(oneEdgeSharp, 3);
const midOfCreasedEdge = findNear(oneEdge3, [0, 1, 1]);
out('subd_cube_cases.json', {
  generated: '2026-10-22',
  generator: 'generate_subd_refs.mjs',
  cage: 'cube, vertices (+-1, +-1, +-1) = llull add_subdivision_solid box size [2,2,2] segments [1,1,1] at position [0,0,0]',
  cornerLimit: {
    closedForm: [0.5, 0.5, 0.5],
    derivation: 'valence 3: (9 v + 4 sum e + sum f) / 24 with v = (1,1,1), sum e = (1,1,1), sum f = (-1,-1,-1) -> 12/24 = 0.5 per axis',
    maskOnLevel0: p12(cornerLimit0),
    maskOnLevel1: p12(cornerLimit1),
    level7Vertex: p12(deep.vertices[6]),
  },
  cornerLimitNormal: {
    expected: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)].map(r12),
    tangentMask: p12(cornerNormal.map(Math.abs)),
  },
  faceCentreLimit: { maskOnLevel1: p12(faceLimit), level7Vertex: p12(deep.vertices[faceCentre1]) },
  edgeMidLimit: { maskOnLevel1: p12(edgeLimit), level7Vertex: p12(deep.vertices[edgeMid1]) },
  smoothMeshVolumeByLevel: smoothVolumes,
  smoothLimitVolumeEstimate: {
    value: r12(volumeLimitEstimate),
    method: 'geometric (Aitken) extrapolation of levels 5-7',
    observedRatio: r12(q),
    grade: 'B (numerical)',
  },
  allEdgesInfinitelySharpVolumeByLevel: {
    values: sharpVolumes(SHARP_INFINITE),
    closedForm: 8,
    why: 'every crease vertex has 3 sharp edges (corner rule) and crease edges are midpoints; all new points are affine combinations of coplanar face points, so each face stays its planar square',
  },
  allEdgesSharpness1VolumeByLevel: sharpVolumes(1),
  allEdgesSharpness2VolumeByLevel: sharpVolumes(2),
  allEdgesSharpness0p5VolumeByLevel: sharpVolumes(0.5),
  oneInfiniteCreaseEdge67: {
    note: 'edge between (1,1,1) and (-1,1,1) infinitely sharp; its two end vertices have 1 sharp edge (dart = smooth rule)',
    level3MidpointOfCrease: p12(oneEdge3.vertices[midOfCreasedEdge]),
    level3Volume: r12(Math.abs(meshVolume(oneEdge3))),
  },
});

// 3. Fully regular torus cage: Catmull-Clark limit = periodic uniform bicubic B-spline exactly (Stam S5). Compare B-spline patch
// evaluation with deep subdivision at patch corners (mask) and patch centres (level 8 face-point descendant).
const nu = 8;
const nv = 6;
const torus = torusCage(nu, nv);
const patch = (i, j, s, t) => {
  const bs = bsplineBasis(s);
  const bt = bsplineBasis(t);
  let p = [0, 0, 0];
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++) p = vec.add(p, vec.mul(torus.vertices[torus.at(i - 1 + a, j - 1 + b)], bs[a] * bt[b]));
  return p;
};
const torus1 = subdivideOnce(torus);
const torusEdges = new Set(torus.faces.flatMap((f) => f.map((a, k) => edgeKey(a, f[(k + 1) % 4])))).size;
const samples = [];
let worstCorner = 0;
let worstCentre = 0;
for (let i = 0; i < nu; i++)
  for (let j = 0; j < nv; j++) {
    const corner = patch(i, j, 0, 0); // = limit of cage vertex (i, j)
    const maskLimit = smoothLimit(torus, torus.at(i, j)).point;
    worstCorner = Math.max(worstCorner, vec.norm(vec.sub(corner, maskLimit)));
    const centre = patch(i, j, 0.5, 0.5);
    const nearest = smoothLimit(torus1, torus.vertices.length + torusEdges + i * nv + j).point;
    worstCentre = Math.max(worstCentre, vec.norm(vec.sub(centre, nearest)));
    if (i === 0 && j < 3) samples.push({ i, j, bsplineCorner: p12(corner), maskLimit: p12(maskLimit), bsplineCentre: p12(centre) });
  }
out('subd_regular_torus.json', {
  generated: '2026-10-22',
  generator: 'generate_subd_refs.mjs',
  cage: `torus cage ${nu} x ${nv} quads, R = 3, r = 1, every vertex valence 4 (fully regular)`,
  claim:
    'limit surface = periodic uniform bicubic B-spline with the cage vertices as poles (Stam 1998: on the regular part the eigenbasis is the power basis of bicubic B-splines)',
  maxCornerDeviation_bsplineVsMask: worstCorner,
  maxCentreDeviation_bsplineVsFacePointMask: r12(worstCentre),
  meshVolumeLevel4: r12(Math.abs(meshVolume(subdivide(torus, 4)))),
  samples,
});

process.stdout.write(
  JSON.stringify({
    lambda3: lambdaOf(3),
    cornerLimit0,
    faceLimit,
    edgeLimit,
    smoothVolumes,
    volumeLimitEstimate,
    worstCorner,
    worstCentre,
  }) + '\n',
);
