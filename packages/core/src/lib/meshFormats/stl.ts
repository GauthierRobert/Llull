/** STL readers: ASCII (several `solid` blocks = several bodies) and binary (80-byte header, u32 count, 50 bytes per facet). Normals are ignored. */

import { type MeshParseFailure, type ParsedBody, type ParsedMeshFile, parseFailure } from './types';
import { appendAll } from '../appendAll';

const BINARY_HEADER = 84;
const FACET_BYTES = 50;

/** True when the byte length is exactly header + 50 x count: binary even if the header starts with "solid". */
export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < BINARY_HEADER) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return BINARY_HEADER + FACET_BYTES * count === bytes.length;
}

export function parseBinaryStl(bytes: Uint8Array): ParsedMeshFile | MeshParseFailure {
  if (!isBinaryStl(bytes)) return parseFailure('MESH_IMPORT_PARSE', 'binary STL: the byte length is not 84 + 50 x the facet count');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  // The facet count is known: both arrays are allocated once (growing a 9-million-value array by pushes copies it several times).
  const positions = new Array<number>(count * 9);
  const triangles = new Array<number>(count * 3);
  let write = 0;
  for (let facet = 0; facet < count; facet++) {
    const base = BINARY_HEADER + facet * FACET_BYTES + 12;
    for (let offset = base; offset < base + 36; offset += 4) {
      const value = view.getFloat32(offset, true);
      if (!Number.isFinite(value)) return parseFailure('MESH_IMPORT_PARSE', `non-finite coordinate in facet ${facet} (byte ${offset})`);
      positions[write++] = value;
    }
    triangles[facet * 3] = facet * 3;
    triangles[facet * 3 + 1] = facet * 3 + 1;
    triangles[facet * 3 + 2] = facet * 3 + 2;
  }
  return { format: 'stl-binary', bodies: [{ positions, triangles, groups: [] }], dropped: count > 0 ? [`normals: ${count}`] : [] };
}

export function parseAsciiStl(text: string): ParsedMeshFile | MeshParseFailure {
  const bodies: ParsedBody[] = [];
  let current: { name?: string; positions: number[]; triangles: number[] } | null = null;
  const flush = (): void => {
    if (current !== null && current.positions.length > 0) bodies.push({ ...current, groups: [] });
    current = null;
  };
  const lines = text.split(/\r?\n/);
  let facetVertices = 0;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const token = line.split(/\s+/, 1)[0]?.toLowerCase();
    if (token === 'solid') {
      flush();
      const name = line.slice(5).trim();
      current = { ...(name !== '' ? { name } : {}), positions: [], triangles: [] };
    } else if (token === 'vertex') {
      const values = line.split(/\s+/).slice(1).map(Number);
      if (values.length !== 3 || !values.every(Number.isFinite))
        return parseFailure('MESH_IMPORT_PARSE', `bad vertex at line ${index + 1}: "${line.slice(0, 60)}"`);
      current ??= { positions: [], triangles: [] };
      appendAll(current.positions, values);
      current.triangles.push(current.positions.length / 3 - 1);
      facetVertices++;
    } else if (token === 'facet') {
      facetVertices = 0;
    } else if (token === 'endfacet' && facetVertices !== 3) {
      return parseFailure('MESH_IMPORT_PARSE', `facet ending at line ${index + 1} has ${facetVertices} vertices, expected 3`);
    }
  }
  flush();
  return { format: 'stl-ascii', bodies, dropped: [] };
}
