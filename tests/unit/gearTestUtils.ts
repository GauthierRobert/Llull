import type { CadDocument, ExtrusionEntity, MeshSolidEntity, Vec3 } from '@core/model/types';
import { pointInPolygon } from '@lib/polygon';

export type Tri = readonly [Vec3, Vec3, Vec3];

const key = (v: Vec3): string => v.map((n) => n.toFixed(6)).join(',');

export function triArea2D(t: Tri): number {
  const [a, b, c] = t;
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

/** Signed volume of a closed triangle soup (positive when wound outward). */
export function signedVolume(tris: ReadonlyArray<Tri>): number {
  let v = 0;
  for (const [a, b, c] of tris) {
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return v;
}

/** Every directed edge must be matched by exactly one opposite directed edge (closed, consistently wound). */
export function isWatertight(tris: ReadonlyArray<Tri>): boolean {
  const directed = new Map<string, number>();
  for (const [a, b, c] of tris) {
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      if (key(p) === key(q)) continue;
      const k = `${key(p)}>${key(q)}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of directed) {
    const [p, q] = k.split('>') as [string, string];
    if (n !== 1 || directed.get(`${q}>${p}`) !== 1) return false;
  }
  return true;
}

/** Triangle soup from indexed mesh data. */
export function meshTris(mesh: {
  positions: ReadonlyArray<number>;
  indices: ReadonlyArray<number>;
}): Tri[] {
  const v = (i: number): Vec3 => [
    mesh.positions[i * 3]!,
    mesh.positions[i * 3 + 1]!,
    mesh.positions[i * 3 + 2]!,
  ];
  const out: Tri[] = [];
  for (let n = 0; n + 2 < mesh.indices.length; n += 3) {
    out.push([v(mesh.indices[n]!), v(mesh.indices[n + 1]!), v(mesh.indices[n + 2]!)]);
  }
  return out;
}

/** Ray-parity point-in-closed-mesh test (ray along +X, slightly skewed to dodge edges). */
export function pointInMesh(tris: ReadonlyArray<Tri>, p: Vec3): boolean {
  const dir: Vec3 = [1, 0.000731, 0.000419];
  let hits = 0;
  for (const [a, b, c] of tris) {
    const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const h: Vec3 = [
      dir[1] * e2[2] - dir[2] * e2[1],
      dir[2] * e2[0] - dir[0] * e2[2],
      dir[0] * e2[1] - dir[1] * e2[0],
    ];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-12) continue;
    const s: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
    if (u < 0 || u > 1) continue;
    const q: Vec3 = [
      s[1] * e1[2] - s[2] * e1[1],
      s[2] * e1[0] - s[0] * e1[2],
      s[0] * e1[1] - s[1] * e1[0],
    ];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (t > 1e-9) hits++;
  }
  return hits % 2 === 1;
}

/** Vertices (as points) of an indexed mesh. */
export function meshVertices(mesh: { positions: ReadonlyArray<number> }): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    out.push([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
  }
  return out;
}

export function insideTriangle(p: readonly [number, number], t: Tri, margin = 1e-7): boolean {
  const [a, b, c] = t;
  const side = (u: Vec3, v: Vec3): number =>
    (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const [s1, s2, s3] = [side(a, b), side(b, c), side(c, a)];
  return (
    (s1 > margin && s2 > margin && s3 > margin) || (s1 < -margin && s2 < -margin && s3 < -margin)
  );
}

type P2 = readonly [number, number];

function densify(poly: ReadonlyArray<P2>, steps = 4): P2[] {
  return poly.flatMap((p, i) => {
    const q = poly[(i + 1) % poly.length]!;
    return Array.from(
      { length: steps },
      (_, k): P2 => [p[0] + ((q[0] - p[0]) * k) / steps, p[1] + ((q[1] - p[1]) * k) / steps],
    );
  });
}

/**
 * Sample-based interference count of a planetary set lying in the XY plane (axis z):
 * planet boundary samples inside the sun polygon / ring material, and sun samples inside a planet.
 * `twist` rotates every planet about its own centre first (negative control).
 */
export function planetaryInterference(
  doc: CadDocument,
  ids: ReadonlyArray<string>,
  twist = 0,
): { sun: number; ring: number } {
  const sunId = ids[0]!;
  const ringId = ids[ids.length - 1]!;
  const world = (id: string): P2[] => {
    const e = doc.entities[id] as ExtrusionEntity;
    return e.profile.map(([x, y]): P2 => [x + e.position[0], y + e.position[1]]);
  };
  const sun = world(sunId);
  const ringBottom = meshTris((doc.entities[ringId] as MeshSolidEntity).mesh).filter((t) =>
    t.every((v) => v[2] === 0),
  );
  const counts = { sun: 0, ring: 0 };
  for (const id of ids.slice(1, -1)) {
    const e = doc.entities[id] as ExtrusionEntity;
    const planet = world(id).map(([x, y]): P2 => {
      const [dx, dy] = [x - e.position[0], y - e.position[1]];
      const [c, s] = [Math.cos(twist), Math.sin(twist)];
      return [e.position[0] + dx * c - dy * s, e.position[1] + dx * s + dy * c];
    });
    for (const p of densify(planet)) {
      if (pointInPolygon(p, sun)) counts.sun++;
      if (ringBottom.some((t) => insideTriangle(p, t))) counts.ring++;
    }
    for (const p of densify(sun)) if (pointInPolygon(p, planet)) counts.sun++;
  }
  return counts;
}
