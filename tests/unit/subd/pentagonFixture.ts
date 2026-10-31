import type { Cage } from '@core/geometry/subdivision';
import type { Vec3 } from '@core/model/types';

/** A pentagonal cap: a valence-5 vertex (the apex) and valence-3 vertices around it. */
export function pentagonCap(): Cage {
  const ring = (z: number): Vec3[] =>
    Array.from({ length: 5 }, (_, i): Vec3 => [Math.cos((2 * Math.PI * i) / 5), Math.sin((2 * Math.PI * i) / 5), z]);
  const mid = Array.from(
    { length: 5 },
    (_, i): Vec3 => [0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / 5), 0.5 * Math.sin((2 * Math.PI * (i + 0.5)) / 5), 1.2],
  );
  const vertices: Vec3[] = [...ring(1), ...mid, [0, 0, 1.4], ...ring(-1)];
  const faces: number[][] = [];
  for (let i = 0; i < 5; i++) faces.push([10, 5 + ((i + 4) % 5), i, 5 + i].reverse());
  for (let i = 0; i < 5; i++) faces.push([i, (i + 1) % 5, 11 + ((i + 1) % 5), 11 + i].reverse());
  faces.push([11, 12, 13, 14, 15].reverse());
  return { vertices, faces, creases: [] };
}

const ring = (n: number, z: number): Vec3[] =>
  Array.from({ length: n }, (_, i): Vec3 => [Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n), z]);

/** A closed pentagonal pyramid: the apex has valence 5, the base corners valence 3, and after one subdivision the pentagon face point has valence 5. */
export function pentagonalPyramid(): Cage {
  const vertices: Vec3[] = [...ring(5, 0), [0, 0, 1.2]];
  const faces: number[][] = [];
  for (let i = 0; i < 5; i++) faces.push([i, (i + 1) % 5, 5]);
  faces.push([4, 3, 2, 1, 0]);
  return { vertices, faces, creases: [] };
}

/** A closed pentagonal bipyramid: two valence-5 apexes over an equator of valence-4 vertices. */
export function pentagonalBipyramid(): Cage {
  const vertices: Vec3[] = [...ring(5, 0), [0, 0, 1.2], [0, 0, -1.2]];
  const faces: number[][] = [];
  for (let i = 0; i < 5; i++) faces.push([i, (i + 1) % 5, 5]);
  for (let i = 0; i < 5; i++) faces.push([(i + 1) % 5, i, 6]);
  return { vertices, faces, creases: [] };
}
