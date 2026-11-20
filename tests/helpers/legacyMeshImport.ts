/**
 * The readers and measures `import_mesh_file` used before PERF1 item 6 (per-line regex OBJ reader, pushed binary STL arrays, one sort of every
 * edge key, per-character base64), copied unchanged: the specification the faster ones are compared against. USE IN TESTS ONLY.
 */

import type { FastMeasure } from '@core/geometry/mesh/fastMeasure';
import type { MeshData } from '@core/model/types';
import { type MeshParseFailure, type ParsedBody, type ParsedMeshFile, parseFailure } from '@lib/meshFormats/types';
import type { Point2 } from '@lib/polygon';
import { triangulatePolygon } from '@lib/triangulate';

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

/** `text` is the whole file decoded as UTF-8 (`new TextDecoder().decode(bytes)`), as the entry point did. */
export function legacyParseObj(text: string): ParsedMeshFile | MeshParseFailure {
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

const BINARY_HEADER = 84;
const FACET_BYTES = 50;

function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < BINARY_HEADER) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return BINARY_HEADER + FACET_BYTES * count === bytes.length;
}

export function legacyParseBinaryStl(bytes: Uint8Array): ParsedMeshFile | MeshParseFailure {
  if (!isBinaryStl(bytes)) return parseFailure('MESH_IMPORT_PARSE', 'binary STL: the byte length is not 84 + 50 x the facet count');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const positions: number[] = [];
  const triangles: number[] = [];
  for (let facet = 0; facet < count; facet++) {
    const base = BINARY_HEADER + facet * FACET_BYTES + 12;
    for (let corner = 0; corner < 3; corner++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = view.getFloat32(base + corner * 12 + axis * 4, true);
        if (!Number.isFinite(value))
          return parseFailure('MESH_IMPORT_PARSE', `non-finite coordinate in facet ${facet} (byte ${base + corner * 12 + axis * 4})`);
        positions.push(value);
      }
      triangles.push(facet * 3 + corner);
    }
  }
  return { format: 'stl-binary', bodies: [{ positions, triangles, groups: [] }], dropped: count > 0 ? [`normals: ${count}`] : [] };
}

export function legacyFastMeasure(mesh: MeshData): FastMeasure {
  const { positions, indices } = mesh;
  const faces = Math.floor(indices.length / 3);
  const vertexCount = positions.length / 3;
  const referenced = new Uint8Array(vertexCount);
  const keys = new Float64Array(faces * 3);
  let area = 0;
  let volume = 0;
  let [cxSum, cySum, czSum] = [0, 0, 0];
  let degenerateFaces = 0;
  for (let f = 0; f < faces; f++) {
    const [a, b, c] = [indices[f * 3] as number, indices[f * 3 + 1] as number, indices[f * 3 + 2] as number];
    referenced[a] = 1;
    referenced[b] = 1;
    referenced[c] = 1;
    if (a === b || b === c || a === c) degenerateFaces++;
    const [ax, ay, az] = [positions[a * 3] as number, positions[a * 3 + 1] as number, positions[a * 3 + 2] as number];
    const [bx, by, bz] = [positions[b * 3] as number, positions[b * 3 + 1] as number, positions[b * 3 + 2] as number];
    const [cx, cy, cz] = [positions[c * 3] as number, positions[c * 3 + 1] as number, positions[c * 3 + 2] as number];
    const [ux, uy, uz, vx, vy, vz] = [bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    const signed = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    volume += signed;
    cxSum += (signed * (ax + bx + cx)) / 4;
    cySum += (signed * (ay + by + cy)) / 4;
    czSum += (signed * (az + bz + cz)) / 4;
    keys[f * 3] = (Math.min(a, b) * vertexCount + Math.max(a, b)) * 2 + (a < b ? 1 : 0);
    keys[f * 3 + 1] = (Math.min(b, c) * vertexCount + Math.max(b, c)) * 2 + (b < c ? 1 : 0);
    keys[f * 3 + 2] = (Math.min(c, a) * vertexCount + Math.max(c, a)) * 2 + (c < a ? 1 : 0);
  }
  keys.sort();
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (let i = 0; i < keys.length; ) {
    const edge = Math.floor((keys[i] as number) / 2);
    let end = i + 1;
    while (end < keys.length && Math.floor((keys[end] as number) / 2) === edge) end++;
    const uses = end - i;
    if (uses === 1) boundaryEdges++;
    else if (uses > 2) nonManifoldEdges++;
    else if ((keys[i] as number) % 2 === (keys[i + 1] as number) % 2) inconsistentEdges++;
    i = end;
  }
  let vertices = 0;
  for (const used of referenced) vertices += used;
  const closed = faces > 0 && degenerateFaces === 0 && boundaryEdges === 0 && nonManifoldEdges === 0;
  const measured = closed && inconsistentEdges === 0;
  return {
    faces,
    vertices,
    area,
    volume: measured ? volume : null,
    centroid: measured && volume !== 0 ? [cxSum / volume, cySum / volume, czSum / volume] : null,
    closed,
    degenerateFaces,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
  };
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** char code → sextet value; -1 for characters outside the alphabet. */
const B64_VALUES: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i;
  return table;
})();

/** `text` is not valid base64. */
export function legacyBase64ToUint8Array(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const dataLength = text.length - padding;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let triple = 0;
  let out = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = i < dataLength && code < 128 ? (B64_VALUES[code] ?? -1) : i < dataLength ? -1 : 0;
    if (value < 0) return null;
    triple = (triple << 6) | value;
    if (i % 4 === 3) {
      for (const shift of [16, 8, 0]) if (out < bytes.length) bytes[out++] = (triple >> shift) & 0xff;
      triple = 0;
    }
  }
  return bytes;
}
