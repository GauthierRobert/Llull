/** Wavefront OBJ reader: `v`, `f` (polygons fan-triangulated, negative indices), `g` / `o` become named triangle ranges; texture, normals and materials are dropped. */

import { triangulatePolygon } from '../triangulate';
import type { Point2 } from '../polygon';
import { type MeshParseFailure, type ParsedBody, type ParsedMeshFile, parseFailure } from './types';
import { ObjLineScanner } from './objScan';

const TEXTURE_COORDINATES = 'texture coordinates';
const NORMALS = 'normals';
const IGNORED = new Map<string, string>([
  ['vt', TEXTURE_COORDINATES],
  ['vn', NORMALS],
  ['usemtl', 'material references'],
  ['mtllib', 'material libraries'],
  ['vp', 'parameter vertices'],
]);

const LINE_FEED = 10;
const HASH = 35;
const LOWER_F = 102;
const LOWER_N = 110;
const LOWER_T = 116;
const LOWER_V = 118;

/** The ASCII characters `String.prototype.trim` and `\s` treat as blank inside one line (tab, vertical tab, form feed, carriage return, space). */
const isBlank = (code: number): boolean => code === 32 || (code >= 9 && code <= 13);

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

/** What the reader has built so far; the byte scanner and the general line reader both append to it. */
class ObjBuild {
  readonly positions: number[] = [];
  readonly triangles: number[] = [];
  readonly groups: ParsedBody['groups'] = [];
  readonly dropped = new Map<string, number>();
  private open: { name: string; start: number } | null = null;

  closeGroup(): void {
    const triangleCount = this.triangles.length / 3;
    if (this.open !== null && triangleCount > this.open.start)
      this.groups.push({ name: this.open.name, start: this.open.start, end: triangleCount });
    this.open = null;
  }

  drop(kind: string): void {
    this.dropped.set(kind, (this.dropped.get(kind) ?? 0) + 1);
  }

  addFace(corners: number[]): void {
    for (const corner of triangulateFace(this.positions, corners)) this.triangles.push(corner);
  }

  /**
   * One line by the general rules (any blank characters, any keyword): the reader of every line the byte scanner does not recognise, and
   * the only source of refusals.
   */
  readLine(raw: string, index: number): MeshParseFailure | null {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return null;
    const [keyword = '', ...fields] = line.split(/\s+/);
    if (keyword === 'v') {
      const values = fields.slice(0, 3).map(Number);
      if (values.length !== 3 || !values.every(Number.isFinite)) {
        return parseFailure('MESH_IMPORT_PARSE', `bad vertex at line ${index + 1}: "${line.slice(0, 60)}"`);
      }
      this.positions.push(...values);
    } else if (keyword === 'f') {
      const vertexCount = this.positions.length / 3;
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
      this.addFace(corners);
    } else if (keyword === 'g' || keyword === 'o') {
      this.closeGroup();
      this.open = { name: fields.join(' ') || `group${this.groups.length}`, start: this.triangles.length / 3 };
    } else {
      const kind = IGNORED.get(keyword);
      if (kind !== undefined) this.drop(kind);
    }
    return null;
  }
}

/**
 * Read OBJ bytes (UTF-8). Plain `v x y z`, `f a b c` (also `a/b/c` forms, negative references, polygons), `vn`, `vt` and comment lines
 * are read from the bytes; every other line, and every line with anything unusual in it, is decoded and read by `ObjBuild.readLine`.
 * @invariant the result is the one `readLine` alone gives on every line of the decoded text split at line feeds
 */
export function parseObj(bytes: Uint8Array): ParsedMeshFile | MeshParseFailure {
  const build = new ObjBuild();
  const { positions, triangles } = build;
  const scanner = new ObjLineScanner(bytes);
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const corners: number[] = [];
  const length = bytes.length;
  let start = 0;
  for (let index = 0; start <= length; index++) {
    const feed = bytes.indexOf(LINE_FEED, start);
    const end = feed < 0 ? length : feed;
    let at = start;
    while (at < end && isBlank(bytes[at] as number)) at++;
    const keyword = at < end ? (bytes[at] as number) : HASH;
    const second = at + 1 < end ? (bytes[at + 1] as number) : 0;
    let done = keyword === HASH;
    if (keyword === LOWER_V && isBlank(second)) {
      const x = scanner.number(at + 2, end);
      const y = Number.isNaN(x) ? x : scanner.number(scanner.cursor, end);
      const z = Number.isNaN(y) ? y : scanner.number(scanner.cursor, end);
      if (!Number.isNaN(z)) {
        positions.push(x, y, z);
        done = true;
      }
    } else if (keyword === LOWER_F && isBlank(second)) {
      const vertexCount = positions.length / 3;
      if (scanner.corners(at + 2, end, vertexCount, corners)) {
        if (corners.length === 3) triangles.push(corners[0] as number, corners[1] as number, corners[2] as number);
        else build.addFace(corners);
        done = true;
      }
    } else if (keyword === LOWER_V && (second === LOWER_N || second === LOWER_T) && (at + 2 >= end || isBlank(bytes[at + 2] as number))) {
      build.drop(second === LOWER_N ? NORMALS : TEXTURE_COORDINATES);
      done = true;
    }
    if (!done) {
      const failure = build.readLine(decoder.decode(bytes.subarray(start, end)), index);
      if (failure !== null) return failure;
    }
    start = end + 1;
  }
  build.closeGroup();
  return {
    format: 'obj',
    bodies: [{ positions, triangles, groups: build.groups }],
    dropped: [...build.dropped].map(([kind, count]) => `${kind}: ${count}`),
  };
}
