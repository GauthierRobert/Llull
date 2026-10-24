/**
 * Predicted volume of a LOCAL deformation (point push, lattice), independent of the deformed surface (01 DEF §5.10): V + ∫ (det J − 1) dV over the source.
 * g = det J − 1 vanishes outside the zone Z the map acts in, so the volume integral becomes a boundary integral by the divergence theorem,
 * ∫_V g dV = ∮ G n_x dS with G(x, y, z) = ∫ g(t, y, z) dt from the body's least x to x (one-dimensional, over the chord of Z). The surface integral
 * runs on the source triangles, split to a fraction of the feature size wherever the shadow of Z falls on them, with the 7-point degree-5 rule.
 * @invariant exact for a polynomial g (lattice) up to the quadrature of the chord; converges for the push as the triangles shrink
 */

import type { DeformRegion } from '../../model/deform';
import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { type DeformNode, warpOf } from './laws';
import { toLocal } from './frame';
import { orientOutward, signedMeshVolume } from '../meshVolume';
import { type Soup, splitPass } from './meshWarp';
import { featureEdgeLength } from './influence';
import type { PredictedVolume } from './predictedVolume';
import { localDeterminant } from './laws';

const PLACEHOLDER: DeformRegion = { start: -Infinity, end: Infinity, falloff: 'none', beyond: 'rigid' };

/** Triangles above which the estimate is not attempted. */
const TRIANGLE_CAP = 300_000;

const GAUSS5: ReadonlyArray<readonly [number, number]> = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];

const SQRT15 = Math.sqrt(15);
const A1 = (6 - SQRT15) / 21;
const A2 = (6 + SQRT15) / 21;
/** Radon's 7-point degree-5 rule on a triangle: barycentric coordinates and weights (sum 1). */
const TRIANGLE_RULE: ReadonlyArray<readonly [number, number, number, number]> = [
  [1 / 3, 1 / 3, 1 / 3, 9 / 40],
  [A1, A1, 1 - 2 * A1, (155 - SQRT15) / 1200],
  [A1, 1 - 2 * A1, A1, (155 - SQRT15) / 1200],
  [1 - 2 * A1, A1, A1, (155 - SQRT15) / 1200],
  [A2, A2, 1 - 2 * A2, (155 + SQRT15) / 1200],
  [A2, 1 - 2 * A2, A2, (155 + SQRT15) / 1200],
  [1 - 2 * A2, A2, A2, (155 + SQRT15) / 1200],
];

interface Zone {
  /** The x interval of the zone along the line (y, z), or null when the line misses it. */
  readonly chord: (y: number, z: number) => readonly [number, number] | null;
  /** Whether the yz shadow of the zone, grown by `margin`, meets the segment of local points p, q. */
  readonly shadow: (p: Vec3, q: Vec3, margin: number) => boolean;
}

function zoneOf(node: Pick<DeformNode, 'law'>): Zone | null {
  const { law } = node;
  if (law.kind === 'point') {
    const [cx, cy, cz] = law.center;
    return {
      chord: (y, z) => {
        const rest = law.radius * law.radius - (y - cy) ** 2 - (z - cz) ** 2;
        return rest > 0 ? [cx - Math.sqrt(rest), cx + Math.sqrt(rest)] : null;
      },
      shadow: (p, q, margin) => {
        const d: [number, number] = [q[1] - p[1], q[2] - p[2]];
        const length2 = d[0] * d[0] + d[1] * d[1];
        const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((cy - p[1]) * d[0] + (cz - p[2]) * d[1]) / length2));
        return Math.hypot(p[1] + t * d[0] - cy, p[2] + t * d[1] - cz) < law.radius + margin;
      },
    };
  }
  if (law.kind !== 'lattice') return null;
  const { min, max } = law.box;
  return {
    chord: (y, z) => (y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2] ? [min[0], max[0]] : null),
    shadow: (p, q, margin) =>
      Math.max(p[1], q[1]) > min[1] - margin &&
      Math.min(p[1], q[1]) < max[1] + margin &&
      Math.max(p[2], q[2]) > min[2] - margin &&
      Math.min(p[2], q[2]) < max[2] + margin,
  };
}

/**
 * V and V + ∫ (det J − 1) dV of the point-push or lattice map over the closed triangle mesh `source`.
 * @failure another law, a degenerate frame, an empty mesh, or a refinement above the triangle cap -> null
 */
export function predictedLocalVolume(source: MeshData, node: Pick<DeformNode, 'law' | 'frame'>): PredictedVolume | null {
  const warp = warpOf({ ...node });
  const zone = zoneOf(node);
  if (warp === null || zone === null || source.indices.length === 0) return null;
  const indices = orientOutward(source.positions, source.indices);
  const volume = signedMeshVolume(source.positions, indices);
  const count = source.positions.length / 3;
  const local: number[] = new Array<number>(count * 3);
  let leastX = Infinity;
  for (let v = 0; v < count; v++) {
    const q = toLocal(warp.frame, [
      source.positions[v * 3] as number,
      source.positions[v * 3 + 1] as number,
      source.positions[v * 3 + 2] as number,
    ]);
    local[v * 3] = q[0];
    local[v * 3 + 1] = q[1];
    local[v * 3 + 2] = q[2];
    leastX = Math.min(leastX, q[0]);
  }
  const soup: Soup = { positions: local, indices: [...indices] };
  const limit = featureEdgeLength(node) * 1.5;
  const at = (v: number): Vec3 => [
    soup.positions[v * 3] as number,
    soup.positions[v * 3 + 1] as number,
    soup.positions[v * 3 + 2] as number,
  ];
  for (let pass = 0; pass < 30; pass++) {
    const split = splitPass(soup, (a, b) => {
      const [p, q] = [at(a), at(b)];
      const length = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      return length > limit && zone.shadow(p, q, length) ? 0.5 : null;
    });
    if (!split) break;
    if (soup.indices.length / 3 > TRIANGLE_CAP) return null;
  }
  const antiderivative = (x: number, y: number, z: number): number => {
    const chord = zone.chord(y, z);
    if (chord === null) return 0;
    const [lo, hi] = [Math.max(leastX, chord[0]), Math.min(x, chord[1])];
    if (!(hi > lo)) return 0;
    const pieces = 4;
    let sum = 0;
    for (let piece = 0; piece < pieces; piece++) {
      const a = lo + ((hi - lo) * piece) / pieces;
      const b = lo + ((hi - lo) * (piece + 1)) / pieces;
      for (const [node5, weight] of GAUSS5) {
        const t = (a + b) / 2 + ((b - a) / 2) * node5;
        sum += weight * ((b - a) / 2) * (localDeterminant(node.law, PLACEHOLDER, [t, y, z]) - 1);
      }
    }
    return sum;
  };
  let delta = 0;
  for (let t = 0; t + 2 < soup.indices.length; t += 3) {
    const [a, b, c] = [at(soup.indices[t] as number), at(soup.indices[t + 1] as number), at(soup.indices[t + 2] as number)];
    if (!zone.shadow(a, b, 0) && !zone.shadow(b, c, 0) && !zone.shadow(c, a, 0)) continue;
    const [u, w] = [
      [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
    ] as [Vec3, Vec3];
    const nx = (u[1] * w[2] - u[2] * w[1]) / 2;
    if (nx === 0) continue;
    let sum = 0;
    for (const [l0, l1, l2, weight] of TRIANGLE_RULE)
      sum +=
        weight * antiderivative(l0 * a[0] + l1 * b[0] + l2 * c[0], l0 * a[1] + l1 * b[1] + l2 * c[1], l0 * a[2] + l1 * b[2] + l2 * c[2]);
    delta += nx * sum;
  }
  return { source: volume, predicted: volume + delta };
}
