/** Triangle meshes of ply pieces on the tool face (06 CMP FR-CMP-54): refined chart triangulation mapped to the surface, closed prisms by ply thickness. */

import type { CompositePart } from '@core/model/composites';
import type { MeshData, Vec2, Vec3 } from '@core/model/types';
import { polygonArea } from '@lib/polygon';
import { add3, cross3, dot3, len3, scale3, sub3 } from '@lib/vec3';
import { chartMesh } from './chartMesh';
import { fromFlat, isDoublyCurved, normalAt } from './surface';

const area3 = (a: Vec3, b: Vec3, c: Vec3): number => len3(cross3(sub3(b, a), sub3(c, a))) / 2;

/** True area of the piece on the tool face (the chart area on developable faces, the refined triangle sum on sphere / nurbs faces). */
export function pieceSurfaceArea(part: CompositePart, piece: readonly Vec2[], maxEdge: number): number {
  if (!isDoublyCurved(part.surface)) return polygonArea(piece);
  const mesh = chartMesh(piece, [], maxEdge, true);
  if (mesh === null) return polygonArea(piece);
  const points = mesh.uv.map((p) => fromFlat(part.surface, p));
  return mesh.triangles.reduce((sum, [a, b, c]) => sum + area3(points[a] as Vec3, points[b] as Vec3, points[c] as Vec3), 0);
}

/** Signed volume of a closed triangle mesh (positive when the winding faces outward). */
export function meshVolume(mesh: MeshData): number {
  let volume = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const at = (k: number): Vec3 => [
      mesh.positions[3 * (mesh.indices[t + k] as number)] as number,
      mesh.positions[3 * (mesh.indices[t + k] as number) + 1] as number,
      mesh.positions[3 * (mesh.indices[t + k] as number) + 2] as number,
    ];
    volume += dot3(at(0), cross3(at(1), at(2))) / 6;
  }
  return volume;
}

/**
 * A closed prism over `face`: the tool-face region offset along the face normal to heights `z0(uv)` and `z0(uv) + thickness` (laminate side applied).
 * `refine` bounds the chart edges by `maxEdge` (needed on curved faces and where `z0` varies).
 * @invariant outward-facing winding; vertices welded by position and coincident wall edges cancelled (a full-turn cylinder seam disappears); null when the polygon cannot be triangulated
 */
export function plyPieceMesh(
  part: CompositePart,
  face: { readonly outer: readonly Vec2[]; readonly holes: readonly (readonly Vec2[])[] },
  thickness: number,
  baseHeight: (uv: Vec2) => number,
  maxEdge: number,
  refine: boolean,
): MeshData | null {
  const chart = chartMesh(face.outer, face.holes, maxEdge, refine);
  if (chart === null) return null;
  const side = part.laminateSide === 'positive_normal' ? 1 : -1;
  const count = chart.uv.length;
  const bottom: Vec3[] = [];
  const top: Vec3[] = [];
  for (const uv of chart.uv) {
    const p = fromFlat(part.surface, uv);
    const n = scale3(normalAt(part.surface, uv), side);
    const z0 = baseHeight(uv);
    bottom.push(add3(p, scale3(n, z0)));
    top.push(add3(p, scale3(n, z0 + thickness)));
  }
  const { positions, remap } = weldPoints([...bottom, ...top]);
  const bottomOf = (i: number): number => remap[i] as number;
  const topOf = (i: number): number => remap[i + count] as number;
  const indices: number[] = [];
  const add = (a: number, b: number, c: number): void => {
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  };
  const flip = side < 0;
  const boundary = new Map<string, [number, number]>();
  for (const [a, b, c] of chart.triangles) {
    if (flip) {
      add(topOf(a), topOf(c), topOf(b));
      add(bottomOf(a), bottomOf(b), bottomOf(c));
    } else {
      add(topOf(a), topOf(b), topOf(c));
      add(bottomOf(a), bottomOf(c), bottomOf(b));
    }
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const [wp, wq] = [bottomOf(p), bottomOf(q)];
      if (wp === wq) continue;
      if (boundary.has(`${wq}:${wp}`)) boundary.delete(`${wq}:${wp}`);
      else boundary.set(`${wp}:${wq}`, [p, q]);
    }
  }
  for (const [p, q] of boundary.values()) {
    const [bp, bq, tp, tq] = [bottomOf(p), bottomOf(q), topOf(p), topOf(q)];
    if (flip) {
      add(bp, tq, bq);
      add(bp, tp, tq);
    } else {
      add(bp, bq, tq);
      add(bp, tq, tp);
    }
  }
  return { positions, indices };
}

/** Welds coincident points (quantum 1e-9 of the extent): the welded positions and the welded index of each input point. */
function weldPoints(points: readonly Vec3[]): { positions: number[]; remap: number[] } {
  const quantum = Math.max(1e-9, ...points.flatMap((p) => p.map(Math.abs))) * 1e-9;
  const index = new Map<string, number>();
  const positions: number[] = [];
  const remap = points.map((p) => {
    const key = p.map((v) => Math.round(v / quantum)).join(',');
    const known = index.get(key);
    if (known !== undefined) return known;
    positions.push(p[0], p[1], p[2]);
    index.set(key, positions.length / 3 - 1);
    return positions.length / 3 - 1;
  });
  return { positions, remap };
}
