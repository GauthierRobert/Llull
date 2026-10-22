/** Mesh file readers behind one sniffing entry point; pure bytes in, arrays out (the host reads the file). */

import { parseObj } from './obj';
import { parsePly } from './ply';
import { isBinaryStl, parseAsciiStl, parseBinaryStl } from './stl';
import { parse3mf } from './threeMf';
import { type MeshParseFailure, type ParseLimits, type ParsedMeshFile, NO_LIMITS, isParseFailure, parseFailure } from './types';

export type MeshFileKind = 'stl' | 'obj' | 'ply' | '3mf';

/** The format named by the content: ZIP magic = 3mf, "ply" = ply, binary STL by its size rule, "solid" = ascii STL, `v`/`f` lines = obj; null when none. */
export function sniffMeshFormat(bytes: Uint8Array): MeshFileKind | null {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return '3mf';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  if (head.startsWith('ply')) return 'ply';
  if (isBinaryStl(bytes)) return 'stl';
  if (head.trimStart().toLowerCase().startsWith('solid')) return 'stl';
  if (/^(v|vt|vn|f|g|o|#|mtllib)\s/m.test(head)) return 'obj';
  return null;
}

/**
 * Parse a mesh file; `kind` overrides the sniffed format.
 * @failure unknown format / malformed record (with line or byte offset) / no triangles -> MeshParseFailure, never a throw
 */
export function parseMeshFile(bytes: Uint8Array, kind?: MeshFileKind, limits: ParseLimits = NO_LIMITS): ParsedMeshFile | MeshParseFailure {
  const format = kind ?? sniffMeshFormat(bytes);
  if (format === null) return parseFailure('MESH_IMPORT_FORMAT_UNKNOWN', 'the content is not STL, OBJ, PLY or 3MF');
  const text = (): string => new TextDecoder().decode(bytes);
  const parsed =
    format === 'stl'
      ? isBinaryStl(bytes)
        ? parseBinaryStl(bytes)
        : parseAsciiStl(text())
      : format === 'obj'
        ? parseObj(text())
        : format === 'ply'
          ? parsePly(bytes)
          : parse3mf(bytes, limits);
  if (isParseFailure(parsed)) return parsed;
  if (parsed.bodies.every((body) => body.triangles.length === 0)) return parseFailure('MESH_IMPORT_EMPTY', 'the file holds no triangles');
  return parsed;
}
