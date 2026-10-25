/**
 * Streamed 3MF mesh object and model sink: a mesh of millions of triangles is written straight from its indexed arrays in batches into a deflate
 * stream, never as `Triangle[]` or one string. The XML equals what `objectXml` writes for the same welded mesh; vertices are not welded here.
 */

import { escapeXml } from '../../lib/escapeXml';
import { CRC32_INIT, crc32Final, crc32Update } from '../../lib/crc32';
import { DeflateStream, MAX_DEFLATE_INPUT } from '../../lib/deflateStream';
import type { Vec3 } from '../../model/vectors';

/** An indexed mesh in document units: millimetres are `(position + offset) * scale`. */
export interface ThreeMfIndexedMesh {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  readonly offset: Vec3;
  readonly scale: number;
}

/** Largest deflated model part: the package travels as one base64 string (V8 strings stop near 536 million characters, so a ZIP above ~395 MB cannot be returned). */
export const MAX_3MF_BYTES = 375_000_000;

/** The model part would exceed `MAX_3MF_BYTES` deflated (or 2 GB of XML) after `bytes` of XML. */
export class ThreeMfTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`3MF model part passed its size limit after ${bytes} bytes of XML`);
  }
}

const BATCH = 4096;
const num = (value: number): string => String(Number(value.toFixed(6)));

/** A triangle of an indexed mesh names a vertex that does not exist. */
export class ThreeMfInvalidMeshError extends Error {
  constructor(
    readonly triangle: number,
    readonly index: number,
    readonly vertexCount: number,
  ) {
    super(`triangle ${triangle} uses vertex index ${index}, but the mesh has ${vertexCount} vertices`);
  }
}

/** The corner indices of the non-degenerate triangles of `mesh`; throws `ThreeMfInvalidMeshError` for an index outside the vertices. */
export function keptIndices(mesh: Pick<ThreeMfIndexedMesh, 'positions' | 'indices'>): Uint32Array {
  const { positions, indices } = mesh;
  const vertexCount = Math.floor(positions.length / 3);
  const out = new Uint32Array(Math.floor(indices.length / 3) * 3);
  const outside = (v: number): boolean => !(Number.isInteger(v) && v >= 0 && v < vertexCount);
  let written = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [a, b, c] = [indices[t] as number, indices[t + 1] as number, indices[t + 2] as number];
    if (outside(a)) throw new ThreeMfInvalidMeshError(t / 3, a, vertexCount);
    if (outside(b)) throw new ThreeMfInvalidMeshError(t / 3, b, vertexCount);
    if (outside(c)) throw new ThreeMfInvalidMeshError(t / 3, c, vertexCount);
    if (a === b || b === c || a === c) continue;
    out[written] = a;
    out[written + 1] = b;
    out[written + 2] = c;
    written += 3;
  }
  return out.subarray(0, written);
}

/**
 * The `<object>` of `mesh` in batches of text; concatenated they are the lines of `objectXml` joined by newlines. `kept` is `keptIndices(mesh)`.
 * @invariant vertices are written as they are (not welded): coincident vertices stay distinct, so a mesh whose shells are joined only by position is not edge-manifold
 */
export function* meshObjectChunks(
  id: number,
  materialIndex: number,
  name: string,
  mesh: Pick<ThreeMfIndexedMesh, 'positions' | 'offset' | 'scale'>,
  kept: Uint32Array,
): Generator<string> {
  const { positions, offset, scale } = mesh;
  const vertexCount = Math.floor(positions.length / 3);
  yield `  <object id="${id}" type="model" name="${escapeXml(name)}" pid="1" pindex="${materialIndex}">\n   <mesh>\n    <vertices>`;
  for (let first = 0; first < vertexCount; first += BATCH) {
    const lines: string[] = [];
    for (let v = first; v < Math.min(vertexCount, first + BATCH); v += 1) {
      const [x, y, z] = [0, 1, 2].map((axis) => ((positions[3 * v + axis] as number) + (offset[axis] as number)) * scale);
      lines.push(`     <vertex x="${num(x as number)}" y="${num(y as number)}" z="${num(z as number)}"/>`);
    }
    yield `\n${lines.join('\n')}`;
  }
  yield '\n    </vertices>\n    <triangles>';
  for (let first = 0; first < kept.length; first += 3 * BATCH) {
    const lines: string[] = [];
    for (let t = first; t < Math.min(kept.length, first + 3 * BATCH); t += 3)
      lines.push(`     <triangle v1="${kept[t]}" v2="${kept[t + 1]}" v3="${kept[t + 2]}"/>`);
    yield `\n${lines.join('\n')}`;
  }
  yield '\n    </triangles>\n   </mesh>\n  </object>';
}

/** Deflates the model text as it is pushed; throws `ThreeMfTooLargeError` past the limits. */
export function modelSink(limit: number = MAX_3MF_BYTES): {
  push(text: string): void;
  done(): { crc: number; size: number; chunks: Uint8Array[]; storedSize: number };
} {
  const deflate = new DeflateStream();
  const encoder = new TextEncoder();
  let crc = CRC32_INIT;
  let size = 0;
  return {
    push(text) {
      const bytes = encoder.encode(text);
      crc = crc32Update(crc, bytes);
      size += bytes.length;
      if (size > MAX_DEFLATE_INPUT || deflate.size() > limit) throw new ThreeMfTooLargeError(size);
      deflate.write(bytes);
    },
    done() {
      const result = deflate.finish();
      if (result.size > limit) throw new ThreeMfTooLargeError(size);
      return { crc: crc32Final(crc), size, chunks: result.chunks, storedSize: result.size };
    },
  };
}
