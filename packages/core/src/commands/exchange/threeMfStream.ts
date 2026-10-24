/**
 * Streamed 3MF mesh object and model sink: a mesh of millions of triangles is written straight from its indexed arrays in batches into a deflate
 * stream, never as `Triangle[]` or one string. The XML equals what `objectXml` writes for the same welded mesh.
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

export interface IndexedStats {
  vertices: number;
  triangles: number;
}

/** The `<object>` of `mesh` in batches of text; concatenated they are the lines of `objectXml` joined by newlines. Degenerate triangles are skipped. */
export function* meshObjectChunks(
  id: number,
  materialIndex: number,
  name: string,
  mesh: ThreeMfIndexedMesh,
  stats: IndexedStats,
): Generator<string> {
  const { positions, indices, offset, scale } = mesh;
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
  stats.vertices = vertexCount;
  yield '\n    </vertices>\n    <triangles>';
  for (let first = 0; first + 2 < indices.length; first += 3 * BATCH) {
    const lines: string[] = [];
    for (let t = first; t + 2 < Math.min(indices.length, first + 3 * BATCH); t += 3) {
      const [a, b, c] = [indices[t] as number, indices[t + 1] as number, indices[t + 2] as number];
      if (a === b || b === c || a === c) continue;
      lines.push(`     <triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
    stats.triangles += lines.length;
    if (lines.length > 0) yield `\n${lines.join('\n')}`;
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
