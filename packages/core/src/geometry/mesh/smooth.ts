/**
 * Umbrella-operator smoothing of an indexed triangle mesh (07 MSH FR-MSH-10, Taubin 1995): Laplacian x += lambda dx, or the Taubin pair
 * lambda then mu with mu = 1 / (kPB - 1 / lambda), simultaneous (Jacobi) updates, uniform or cotangent weights normalised to sum 1.
 * @invariant boundary vertices (fixBoundary) and vertices outside the region never move
 * @invariant volumeCorrection rescales a closed result about its volume centroid so the volume equals the input's
 */

import type { Vec3 } from '../../model/vectors';
import { fastMeasure } from './fastMeasure';
import { type SphereRegion, insideRegion } from './region';
import { buildTopology } from './topology';

export interface SmoothParams {
  readonly method: 'laplacian' | 'taubin';
  readonly lambda: number;
  /** Pass-band frequency kPB of Taubin (mu is derived from it). */
  readonly passBand: number;
  readonly iterations: number;
  readonly weights: 'uniform' | 'cotangent';
  readonly fixBoundary: boolean;
  readonly volumeCorrection: boolean;
  readonly region?: SphereRegion;
}

export interface SmoothResult {
  readonly positions: number[];
  readonly mu: number | null;
  readonly volumeBefore: number | null;
  readonly volumeAfter: number | null;
  readonly volumeCorrected: boolean;
  readonly meanDisplacement: number;
  readonly maxDisplacement: number;
}

/** Taubin mu from lambda and the pass-band frequency (kPB = 1 / lambda + 1 / mu). */
export const taubinMu = (lambda: number, passBand: number): number => 1 / (passBand - 1 / lambda);

interface Weighted {
  readonly neighbours: number[][];
  readonly weights: number[][];
}

function uniformWeights(vertexCount: number, triangles: ReadonlyArray<number>): Weighted {
  const sets = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let f = 0; f + 2 < triangles.length; f += 3) {
    const c = [triangles[f] as number, triangles[f + 1] as number, triangles[f + 2] as number];
    for (const a of c) for (const b of c) if (a !== b) sets[a]?.add(b);
  }
  const neighbours = sets.map((s) => [...s].sort((x, y) => x - y));
  return { neighbours, weights: neighbours.map((n) => n.map(() => 1 / n.length)) };
}

const cotangent = (p: Vec3, q: Vec3, r: Vec3): number => {
  const [ux, uy, uz] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const [vx, vy, vz] = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  return cross > 1e-300 ? (ux * vx + uy * vy + uz * vz) / cross : 0;
};

function cotangentWeights(positions: ReadonlyArray<number>, triangles: ReadonlyArray<number>): Weighted {
  const vertexCount = positions.length / 3;
  const raw = Array.from({ length: vertexCount }, () => new Map<number, number>());
  const point = (i: number): Vec3 => [positions[i * 3] as number, positions[i * 3 + 1] as number, positions[i * 3 + 2] as number];
  for (let f = 0; f + 2 < triangles.length; f += 3) {
    const c = [triangles[f] as number, triangles[f + 1] as number, triangles[f + 2] as number];
    for (let k = 0; k < 3; k++) {
      const [apex, a, b] = [c[k] as number, c[(k + 1) % 3] as number, c[(k + 2) % 3] as number];
      const w = Math.max(cotangent(point(apex), point(a), point(b)), 1e-6);
      raw[a]?.set(b, (raw[a]?.get(b) ?? 0) + w);
      raw[b]?.set(a, (raw[b]?.get(a) ?? 0) + w);
    }
  }
  const neighbours = raw.map((m) => [...m.keys()].sort((x, y) => x - y));
  const weights = neighbours.map((n, v) => {
    const row = n.map((j) => raw[v]?.get(j) ?? 0);
    const sum = row.reduce((s, w) => s + w, 0);
    return row.map((w) => w / sum);
  });
  return { neighbours, weights };
}

function umbrellaStep(positions: number[], graph: Weighted, factor: number, free: Uint8Array): number[] {
  const next = positions.slice();
  for (let v = 0; v < free.length; v++) {
    if (free[v] !== 1) continue;
    const row = graph.neighbours[v] as number[];
    const weights = graph.weights[v] as number[];
    if (row.length === 0) continue;
    for (let axis = 0; axis < 3; axis++) {
      let mean = 0;
      row.forEach((j, k) => (mean += (weights[k] as number) * (positions[j * 3 + axis] as number)));
      next[v * 3 + axis] = (positions[v * 3 + axis] as number) + factor * (mean - (positions[v * 3 + axis] as number));
    }
  }
  return next;
}

function freeVertices(positions: ReadonlyArray<number>, triangles: ReadonlyArray<number>, params: SmoothParams): Uint8Array {
  const vertexCount = positions.length / 3;
  const topology = buildTopology(vertexCount, triangles);
  const free = new Uint8Array(vertexCount).fill(1);
  const referenced = new Uint8Array(vertexCount);
  for (const v of triangles) referenced[v] = 1;
  for (let v = 0; v < vertexCount; v++) {
    const at: Vec3 = [positions[v * 3] as number, positions[v * 3 + 1] as number, positions[v * 3 + 2] as number];
    if (referenced[v] !== 1 || !insideRegion(params.region, at)) free[v] = 0;
  }
  if (params.fixBoundary) {
    for (const [a, b] of topology.boundaryEdges) {
      free[a] = 0;
      free[b] = 0;
    }
  }
  for (const edge of topology.nonManifoldEdges) {
    free[edge.a] = 0;
    free[edge.b] = 0;
  }
  return free;
}

/** Smooth `positions` (welded, `triangles`); returns the new positions and the change report. */
export function smoothMesh(positions: ReadonlyArray<number>, triangles: ReadonlyArray<number>, params: SmoothParams): SmoothResult {
  const vertexCount = positions.length / 3;
  const free = freeVertices(positions, triangles, params);
  const graph = params.weights === 'cotangent' ? cotangentWeights(positions, triangles) : uniformWeights(vertexCount, triangles);
  const mu = params.method === 'taubin' ? taubinMu(params.lambda, params.passBand) : null;
  let current = [...positions];
  for (let k = 0; k < params.iterations; k++) {
    current = umbrellaStep(current, graph, params.lambda, free);
    if (mu !== null) current = umbrellaStep(current, graph, mu, free);
  }
  const before = fastMeasure({ positions, indices: triangles });
  let volumeCorrected = false;
  if (params.volumeCorrection && before.closed && before.volume !== null && before.volume !== 0) {
    const smoothed = fastMeasure({ positions: current, indices: triangles });
    if (smoothed.volume !== null && smoothed.volume * before.volume > 0 && smoothed.centroid !== null) {
      const factor = Math.cbrt(before.volume / smoothed.volume);
      const centre = smoothed.centroid;
      current = current.map((value, i) => {
        if (free[Math.floor(i / 3)] !== 1) return value;
        const c = centre[i % 3] as number;
        return c + factor * (value - c);
      });
      volumeCorrected = true;
    }
  }
  const after = fastMeasure({ positions: current, indices: triangles });
  let sum = 0;
  let max = 0;
  let moved = 0;
  const referenced = new Uint8Array(vertexCount);
  for (const v of triangles) referenced[v] = 1;
  for (let v = 0; v < vertexCount; v++) {
    if (referenced[v] !== 1) continue;
    const d = Math.hypot(
      (current[v * 3] as number) - (positions[v * 3] as number),
      (current[v * 3 + 1] as number) - (positions[v * 3 + 1] as number),
      (current[v * 3 + 2] as number) - (positions[v * 3 + 2] as number),
    );
    sum += d;
    max = Math.max(max, d);
    moved++;
  }
  return {
    positions: current,
    mu,
    volumeBefore: before.volume,
    volumeAfter: after.volume,
    volumeCorrected,
    meanDisplacement: moved > 0 ? sum / moved : 0,
    maxDisplacement: max,
  };
}
