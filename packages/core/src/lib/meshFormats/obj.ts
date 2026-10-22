/** Wavefront OBJ reader: `v`, `f` (polygons fan-triangulated, negative indices), `g` / `o` become named triangle ranges; texture, normals and materials are dropped. */

import { triangulatePolygon } from '../triangulate';
import type { Point2 } from '../polygon';
import { type MeshParseFailure, type ParsedBody, type ParsedMeshFile, parseFailure } from './types';

const IGNORED = new Map<string, string>([
  ['vt', 'texture coordinates'],
  ['vn', 'normals'],
  ['usemtl', 'material references'],
  ['mtllib', 'material libraries'],
  ['vp', 'parameter vertices'],
]);

/**
 * Triangles of the polygon with corner indices `corners` over flat `positions`: a convex or triangle polygon fans, a concave one is ear-clipped in the
 * plane of its Newell normal (orientation kept); falls back to the fan when the clipper cannot finish.
 */
function triangulateFace(positions: number[], corners: number[]): number[] {
  const fan = (): number[] =>
    corners.slice(2).flatMap((_, k) => [corners[0] as number, corners[k + 1] as number, corners[k + 2] as number]);
  if (corners.length <= 3) return fan();
  const at = (i: number, axis: number): number => positions[i * 3 + axis] as number;
  const normal = [0, 0, 0];
  corners.forEach((current, k) => {
    const next = corners[(k + 1) % corners.length] as number;
    normal[0] = (normal[0] as number) + (at(current, 1) - at(next, 1)) * (at(current, 2) + at(next, 2));
    normal[1] = (normal[1] as number) + (at(current, 2) - at(next, 2)) * (at(current, 0) + at(next, 0));
    normal[2] = (normal[2] as number) + (at(current, 0) - at(next, 0)) * (at(current, 1) + at(next, 1));
  });
  const drop = [0, 1, 2].reduce((best, axis) => (Math.abs(normal[axis] as number) > Math.abs(normal[best] as number) ? axis : best), 0);
  if (normal[drop] === 0) return fan();
  const sign = (normal[drop] as number) < 0 ? -1 : 1;
  const [u, v] = [(drop + 1) % 3, (drop + 2) % 3];
  const points: Point2[] = corners.map((i): Point2 => [sign * at(i, u), at(i, v)]);
  const clipped = triangulatePolygon(points);
  if (!clipped.complete) return fan();
  const cornerOf = new Map<Point2, number>(points.map((point, k) => [point, corners[k] as number]));
  return clipped.triangles.flatMap((triangle) => triangle.map((index) => cornerOf.get(clipped.vertices[index] as Point2) ?? 0));
}

export function parseObj(text: string): ParsedMeshFile | MeshParseFailure {
  const positions: number[] = [];
  const triangles: number[] = [];
  const groups: ParsedBody['groups'] = [];
  const dropped = new Map<string, number>();
  let open: { name: string; start: number } | null = null;
  const closeGroup = (): void => {
    const triangleCount = triangles.length / 3;
    if (open !== null && triangleCount > open.start) groups.push({ name: open.name, start: open.start, end: triangleCount });
    open = null;
  };
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [keyword = '', ...fields] = line.split(/\s+/);
    if (keyword === 'v') {
      const values = fields.slice(0, 3).map(Number);
      if (values.length !== 3 || !values.every(Number.isFinite)) {
        return parseFailure('MESH_IMPORT_PARSE', `bad vertex at line ${index + 1}: "${line.slice(0, 60)}"`);
      }
      positions.push(...values);
    } else if (keyword === 'f') {
      const vertexCount = positions.length / 3;
      const corners: number[] = [];
      for (const field of fields) {
        const reference = Number.parseInt(field.split('/')[0] ?? '', 10);
        const resolved = reference < 0 ? vertexCount + reference : reference - 1;
        if (!Number.isInteger(resolved) || resolved < 0 || resolved >= vertexCount) {
          return parseFailure('MESH_IMPORT_PARSE', `face at line ${index + 1} references vertex "${field}" outside 1..${vertexCount}`);
        }
        corners.push(resolved);
      }
      if (corners.length < 3) return parseFailure('MESH_IMPORT_PARSE', `face at line ${index + 1} has fewer than 3 vertices`);
      triangles.push(...triangulateFace(positions, corners));
    } else if (keyword === 'g' || keyword === 'o') {
      closeGroup();
      open = { name: fields.join(' ') || `group${groups.length}`, start: triangles.length / 3 };
    } else {
      const kind = IGNORED.get(keyword);
      if (kind !== undefined) dropped.set(kind, (dropped.get(kind) ?? 0) + 1);
    }
  }
  closeGroup();
  return { format: 'obj', bodies: [{ positions, triangles, groups }], dropped: [...dropped].map(([kind, count]) => `${kind}: ${count}`) };
}
