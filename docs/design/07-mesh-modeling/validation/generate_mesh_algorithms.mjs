// 07 MSH reference implementations, run on synthetic meshes: Laplacian vs Taubin smoothing, QEM decimation of planar grids,
// minimum-area hole triangulation (Liepa stage 2), a defect mesh with its ground truth, small STL fixtures.
// Run: node generate_mesh_algorithms.mjs  -> data/*.json, data/*.stl
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { icosphere, grid, area, volume, edgeUse, neighbours, norm, sub, cross, dot, add, scale, rng, round, triArea } from './lib_mesh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const write = (name, text) => {
  fs.writeFileSync(path.join(here, 'data', name), text);
  process.stdout.write(`wrote data/${name}\n`);
};
const json = (name, data) => write(name, JSON.stringify(data, null, 1) + '\n');

// ---------- 1. Smoothing (VC-MSH-08, 09) ----------
function umbrellaStep(positions, nbr, factor) {
  return positions.map((p, i) => {
    const n = nbr[i];
    let c = [0, 0, 0];
    for (const j of n) c = add(c, positions[j]);
    c = scale(c, 1 / n.length);
    return add(p, scale(sub(c, p), factor));
  });
}
function smooth(mesh, lambda, mu, iterations) {
  const nbr = neighbours(mesh);
  let p = mesh.positions;
  for (let k = 0; k < iterations; k++) {
    p = umbrellaStep(p, nbr, lambda);
    if (mu !== 0) p = umbrellaStep(p, nbr, mu);
  }
  return { positions: p, faces: mesh.faces };
}
const radii = (m) => m.positions.map((p) => norm(p));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const rms = (a, c) => Math.sqrt(a.reduce((s, x) => s + (x - c) ** 2, 0) / a.length);
{
  const R = 10;
  const lambda = 0.6307;
  const kPB = 0.1;
  const mu = 1 / (kPB - 1 / lambda);
  const base = icosphere(R, 4);
  const rows = [];
  for (const iterations of [1, 10, 50]) {
    const lap = smooth(base, lambda, 0, iterations);
    const tau = smooth(base, lambda, mu, iterations);
    rows.push({
      iterations,
      laplacian: { meanRadius: round(mean(radii(lap)), 10), volume: round(volume(lap), 10) },
      taubin: { meanRadius: round(mean(radii(tau)), 10), volume: round(volume(tau), 10) },
    });
  }
  // Noisy sphere: radial noise uniform in [-0.1, 0.1] mm, seed 42.
  const random = rng(42);
  const noisy = { positions: base.positions.map((p) => scale(p, (R + (random() * 2 - 1) * 0.1) / R)), faces: base.faces };
  const r0 = radii(noisy);
  const tau10 = smooth(noisy, lambda, mu, 10);
  const lap10 = smooth(noisy, lambda, 0, 10);
  const rt = radii(tau10);
  const rl = radii(lap10);
  json('smoothing_reference.json', {
    mesh: 'icosphere R 10 level 4 (2562 vertices, 5120 faces), uniform umbrella operator (mean of the 1-ring minus the vertex)',
    lambda,
    kPB,
    mu: round(mu, 10),
    clean: { meanRadius: round(mean(radii(base)), 10), volume: round(volume(base), 10), runs: rows },
    noisy: {
      noise: 'radial, uniform in [-0.1, 0.1] mm, mulberry32 seed 42',
      before: { meanRadius: round(mean(r0), 10), rmsAboutMean: round(rms(r0, mean(r0)), 10) },
      taubin10: { meanRadius: round(mean(rt), 10), rmsAboutMean: round(rms(rt, mean(rt)), 10) },
      laplacian10: { meanRadius: round(mean(rl), 10), rmsAboutMean: round(rms(rl, mean(rl)), 10) },
    },
    note: 'reference code run (this script); an implementation using the same operator and order must match to 1e-9 relative',
  });
}

// ---------- 2. QEM on planar grids (VC-MSH-06) ----------
function planeOf(a, b, c) {
  const n = cross(sub(b, a), sub(c, a));
  const l = norm(n);
  if (l === 0) return null;
  const u = scale(n, 1 / l);
  return [u[0], u[1], u[2], -dot(u, a)];
}
function quadricOf(pl) {
  const q = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) q.push(pl[i] * pl[j]);
  return q;
}
const qAdd = (a, b) => a.map((x, i) => x + b[i]);
const qErr = (q, v) => {
  const h = [v[0], v[1], v[2], 1];
  let s = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s += h[i] * q[i * 4 + j] * h[j];
  return s;
};
/** Garland-Heckbert edge collapse with endpoint placement (subset placement), boundary vertices locked, fold-over rejected. */
function qemDecimate(mesh, targetFaces) {
  const pos = mesh.positions.map((p) => p.slice());
  let faces = mesh.faces.map((f) => f.slice());
  const Q = pos.map(() => new Array(16).fill(0));
  for (const [a, b, c] of faces) {
    const pl = planeOf(pos[a], pos[b], pos[c]);
    if (pl === null) continue;
    const k = quadricOf(pl);
    for (const v of [a, b, c]) Q[v] = qAdd(Q[v], k);
  }
  const boundary = new Set();
  for (const [key, count] of edgeUse({ faces })) if (count === 1) for (const v of key.split(',')) boundary.add(Number(v));
  let collapses = 0;
  let maxCost = 0;
  while (faces.length > targetFaces) {
    const candidates = [];
    for (const key of edgeUse({ faces }).keys()) {
      const [a, b] = key.split(',').map(Number);
      const q = qAdd(Q[a], Q[b]);
      for (const [keep, drop] of [
        [a, b],
        [b, a],
      ]) {
        if (boundary.has(drop)) continue;
        candidates.push({ keep, drop, cost: qErr(q, pos[keep]) });
      }
    }
    candidates.sort((x, y) => x.cost - y.cost || x.keep - y.keep || x.drop - y.drop);
    let done = false;
    for (const { keep, drop, cost } of candidates) {
      const next = [];
      let ok = true;
      for (const f of faces) {
        if (f.includes(drop) && f.includes(keep)) continue;
        if (f.includes(drop)) {
          const g = f.map((v) => (v === drop ? keep : v));
          const n0 = cross(sub(pos[f[1]], pos[f[0]]), sub(pos[f[2]], pos[f[0]]));
          const n1 = cross(sub(pos[g[1]], pos[g[0]]), sub(pos[g[2]], pos[g[0]]));
          if (dot(n0, n1) <= 0 || norm(n1) < 1e-12) {
            ok = false;
            break;
          }
          next.push(g);
        } else next.push(f);
      }
      if (!ok) continue;
      // reject collapses that create a non-manifold edge
      if ([...edgeUse({ faces: next }).values()].some((c) => c > 2)) continue;
      faces = next;
      Q[keep] = qAdd(Q[keep], Q[drop]);
      collapses++;
      maxCost = Math.max(maxCost, cost);
      done = true;
      break;
    }
    if (!done) break;
  }
  return { positions: pos, faces, collapses, maxCost };
}
{
  const cases = [];
  for (const [id, z] of [
    ['flat', () => 0],
    ['tilted', (x, y) => 0.3 * x + 0.2 * y],
  ]) {
    const g = grid(10, 12, z);
    const before = area(g);
    const dec = qemDecimate(g, 40);
    const used = new Set(dec.faces.flat());
    let maxPlane = 0;
    for (const v of used) {
      const p = dec.positions[v];
      maxPlane = Math.max(maxPlane, Math.abs(p[2] - z(p[0], p[1])) / Math.sqrt(1 + 0.3 ** 2 + 0.2 ** 2));
    }
    cases.push({
      id,
      surface: id === 'flat' ? 'z = 0' : 'z = 0.3 x + 0.2 y',
      input: { faces: g.faces.length, vertices: g.positions.length, area: round(before) },
      expectedArea: round(id === 'flat' ? 100 : 100 * Math.sqrt(1 + 0.09 + 0.04)),
      result: {
        faces: dec.faces.length,
        verticesUsed: used.size,
        area: round(area(dec)),
        areaAbsError: Math.abs(area(dec) - before),
        maxDistanceFromPlane: maxPlane,
        maxQuadricCost: dec.maxCost,
        boundaryEdges: [...edgeUse(dec).values()].filter((c) => c === 1).length,
      },
    });
  }
  json('qem_planar_reference.json', {
    algorithm:
      'Garland-Heckbert 1997 quadrics, endpoint placement, boundary vertices locked, fold-over and non-manifold collapses rejected, lowest cost first (ties by vertex index)',
    input: '12 x 12 cell grid on [0,10]^2 (288 triangles, 169 vertices), target 40 triangles',
    claim:
      'every interior vertex lies on the planes of its faces, so all quadric costs are 0; area and planarity are kept exactly (to round-off)',
    cases,
  });
}

// ---------- 3. Hole filling: minimum-area triangulation of a boundary loop (VC-MSH-05) ----------
function fillMinArea(pos, loop) {
  const n = loop.length;
  const W = Array.from({ length: n }, () => new Array(n).fill(0));
  const K = Array.from({ length: n }, () => new Array(n).fill(-1));
  for (let len = 2; len < n; len++)
    for (let i = 0; i + len < n; i++) {
      const j = i + len;
      let best = Infinity;
      let arg = -1;
      for (let m = i + 1; m < j; m++) {
        const w = W[i][m] + W[m][j] + triArea(pos[loop[i]], pos[loop[m]], pos[loop[j]]);
        if (w < best - 1e-15) {
          best = w;
          arg = m;
        }
      }
      W[i][j] = best;
      K[i][j] = arg;
    }
  const tris = [];
  const rec = (i, j) => {
    if (j - i < 2) return;
    const m = K[i][j];
    tris.push([loop[i], loop[m], loop[j]]);
    rec(i, m);
    rec(m, j);
  };
  rec(0, n - 1);
  return tris;
}
function boundaryLoops(mesh) {
  const directed = new Map();
  const use = edgeUse(mesh);
  for (const f of mesh.faces)
    for (let k = 0; k < 3; k++) {
      const a = f[k];
      const b = f[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (use.get(key) === 1) directed.set(b, a); // reversed so the fill is wound like the surface
    }
  const loops = [];
  const seen = new Set();
  for (const start of [...directed.keys()].sort((x, y) => x - y)) {
    if (seen.has(start)) continue;
    const loop = [];
    let v = start;
    while (!seen.has(v)) {
      seen.add(v);
      loop.push(v);
      v = directed.get(v);
    }
    loops.push(loop);
  }
  return loops;
}
{
  const g = grid(10, 10);
  // remove the 2 x 2 central cells (cells i, j in {4, 5}) = 8 triangles; hole boundary = square [4,6]^2 with 8 edges
  const holed = {
    positions: g.positions,
    faces: g.faces.filter((_, idx) => {
      const cell = Math.floor(idx / 2);
      const i = cell % 10;
      const j = Math.floor(cell / 10);
      return !(i >= 4 && i <= 5 && j >= 4 && j <= 5);
    }),
  };
  const loopsPlanar = boundaryLoops(holed);
  const inner = loopsPlanar.find((l) => l.length === 8);
  const patch = fillMinArea(holed.positions, inner);
  const filled = { positions: holed.positions, faces: holed.faces.concat(patch) };
  // sphere: remove the faces of an icosphere l3 within 2.5 mm of the +Z pole, fill, report the flat-patch volume deficit
  const s = icosphere(10, 3);
  const cap = {
    positions: s.positions,
    faces: s.faces.filter((f) => !f.every((v) => Math.hypot(s.positions[v][0], s.positions[v][1]) < 2.5 && s.positions[v][2] > 0)),
  };
  const sl = boundaryLoops(cap);
  const sp = fillMinArea(cap.positions, sl[0]);
  const sf = { positions: cap.positions, faces: cap.faces.concat(sp) };
  json('hole_fill_reference.json', {
    algorithm:
      'Liepa 2003 stage 2 (triangulation) as minimum-area dynamic programming over the boundary loop (O(n^3)); refinement and fairing not applied here',
    planar: {
      input: '10 x 10 cell grid on [0,10]^2 with the 2 x 2 centre cells removed (192 triangles, one 8-edge inner loop)',
      boundaryLoopsBefore: loopsPlanar.length,
      innerLoopEdges: inner.length,
      patchTriangles: patch.length,
      expectedPatchTriangles: inner.length - 2,
      areaAfter: round(area(filled)),
      expectedArea: 100,
      boundaryEdgesAfter: [...edgeUse(filled).values()].filter((c) => c === 1).length,
      expectedBoundaryEdgesAfter: 40,
    },
    sphere: {
      input: 'icosphere R 10 level 3 with the faces near the +Z pole removed (all vertices within 2.5 mm of the axis, z > 0)',
      removedFaces: s.faces.length - cap.faces.length,
      loops: sl.length,
      loopEdges: sl[0].length,
      patchTriangles: sp.length,
      closedAfter: [...edgeUse(sf).values()].every((c) => c === 2),
      volumeOriginal: round(volume(s)),
      volumeAfterFlatFill: round(volume(sf)),
      note: 'without refinement + fairing the patch is flat; with Liepa refinement + fairing the volume must move back toward the original (VC-MSH-05 sphere tolerance TBD — measure with fill_mesh_holes fairing "curvature")',
    },
  });
}

// ---------- 4. Defect mesh with ground truth (VC-MSH-04) ----------
{
  const base = icosphere(10, 2); // 162 V, 320 F, closed
  const faces = base.faces.map((f) => f.slice());
  const removed = faces.splice(17, 1)[0]; // one hole of 3 edges
  for (const k of [40, 41, 42]) faces[k] = [faces[k][0], faces[k][2], faces[k][1]]; // 3 flipped faces
  faces.push(faces[100].slice(), faces[200].slice()); // 2 duplicate faces
  faces.push([5, 5, 6]); // 1 degenerate face (repeated vertex)
  const positions = base.positions.map((p) => p.slice());
  const o = positions.length;
  positions.push([30, 0, 0], [30.5, 0, 0], [30, 0.5, 0], [30, 0, 0.5]); // tiny disjoint tetrahedron (4 faces)
  faces.push([o, o + 2, o + 1], [o, o + 1, o + 3], [o, o + 3, o + 2], [o + 1, o + 2, o + 3]);
  json('defect_mesh.json', {
    what: 'icosphere R 10 level 2 with injected defects; indexed mesh (positions, faces), vertex indices 0-based',
    truth: {
      faces: faces.length,
      duplicateFaces: 2,
      flippedFaces: 3,
      degenerateFaces: 1,
      boundaryLoops: 1,
      boundaryLoopEdges: 3,
      removedFace: removed,
      components: 2,
      smallComponent: { faces: 4, volume: round(0.5 ** 3 / 6) },
      afterRepair: {
        faces: 320,
        closed: true,
        consistentOrientation: true,
        volume: round(volume(base)),
        area: round(area(base)),
        note: 'repair_mesh mode "stitch" + remove_small_components + fill_holes: the 3-edge hole is refilled with exactly the removed triangle',
      },
    },
    positions: positions.map((p) => p.map((x) => round(x, 15))),
    faces,
  });
}

// ---------- 5. STL fixtures (VC-MSH-03) ----------
{
  const m = icosphere(10, 1); // 80 triangles
  const fmt = (v) => v.map((x) => x.toExponential(9)).join(' ');
  const lines = ['solid icosphere_r10_l1'];
  for (const [a, b, c] of m.faces) {
    const n = cross(sub(m.positions[b], m.positions[a]), sub(m.positions[c], m.positions[a]));
    const u = scale(n, 1 / norm(n));
    lines.push(
      `  facet normal ${fmt(u)}`,
      '    outer loop',
      `      vertex ${fmt(m.positions[a])}`,
      `      vertex ${fmt(m.positions[b])}`,
      `      vertex ${fmt(m.positions[c])}`,
      '    endloop',
      '  endfacet',
    );
  }
  lines.push('endsolid icosphere_r10_l1');
  const ascii = lines.join('\n') + '\n';
  write('icosphere_r10_l1_ascii.stl', ascii);
  const buf = Buffer.alloc(84 + m.faces.length * 50);
  buf.write('llull 07 MSH fixture icosphere r10 l1 (binary)', 0, 'ascii');
  buf.writeUInt32LE(m.faces.length, 80);
  let off = 84;
  for (const [a, b, c] of m.faces) {
    const n = cross(sub(m.positions[b], m.positions[a]), sub(m.positions[c], m.positions[a]));
    const u = scale(n, 1 / norm(n));
    for (const x of [...u, ...m.positions[a], ...m.positions[b], ...m.positions[c]]) {
      buf.writeFloatLE(x, off);
      off += 4;
    }
    off += 2;
  }
  fs.writeFileSync(path.join(here, 'data', 'icosphere_r10_l1_binary.stl'), buf);
  process.stdout.write('wrote data/icosphere_r10_l1_binary.stl\n');
  // float32 values of the binary file, for the expected volume after import
  const f32 = (x) => Math.fround(x);
  const m32 = { positions: m.positions.map((p) => p.map(f32)), faces: m.faces };
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  json('stl_fixtures.json', {
    files: [
      {
        file: 'icosphere_r10_l1_ascii.stl',
        sha256: sha(Buffer.from(ascii)),
        bytes: Buffer.byteLength(ascii),
        triangles: 80,
        weldedVertices: 42,
        expectedVolume: round(volume(m)),
        expectedArea: round(area(m)),
      },
      {
        file: 'icosphere_r10_l1_binary.stl',
        sha256: sha(buf),
        bytes: buf.length,
        triangles: 80,
        weldedVertices: 42,
        expectedVolume: round(volume(m32)),
        expectedArea: round(area(m32)),
        note: 'coordinates are float32 in the file',
      },
    ],
    unit: 'unitless in the file; the VCs import with units "mm"',
    tolerance: '1e-9 relative (ascii, 10 significant digits written) / exact on the float32 values (binary)',
  });
}

// ---------- 6. Binary STL inputs of the plans (not part of stl_fixtures.json) ----------
// A fine icosphere for the offset / hollow / wrap cases (the display tessellation of an exact sphere is too coarse for the VC-MSH-15 bound)
// and a small ball for the Minkowski case (plans/target_hull_minkowski_offset.json).
{
  const binaryStl = (m, header) => {
    const buf = Buffer.alloc(84 + m.faces.length * 50);
    buf.write(header, 0, 'ascii');
    buf.writeUInt32LE(m.faces.length, 80);
    let off = 84;
    for (const [a, b, c] of m.faces) {
      const n = cross(sub(m.positions[b], m.positions[a]), sub(m.positions[c], m.positions[a]));
      const u = scale(n, 1 / norm(n));
      for (const x of [...u, ...m.positions[a], ...m.positions[b], ...m.positions[c]]) {
        buf.writeFloatLE(x, off);
        off += 4;
      }
      off += 2;
    }
    return buf;
  };
  fs.writeFileSync(
    path.join(here, 'data', 'icosphere_r10_l5_binary.stl'),
    binaryStl(icosphere(10, 5), 'llull 07 MSH plan input icosphere r10 l5'),
  );
  fs.writeFileSync(
    path.join(here, 'data', 'icosphere_r2_l2_binary.stl'),
    binaryStl(icosphere(2, 2), 'llull 07 MSH plan input icosphere r2 l2'),
  );
  process.stdout.write('wrote data/icosphere_r10_l5_binary.stl, data/icosphere_r2_l2_binary.stl\n');
}
