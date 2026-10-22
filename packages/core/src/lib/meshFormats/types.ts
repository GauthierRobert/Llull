/** Shared result types of the mesh file readers (STL, OBJ, PLY, 3MF). Triangles index into `positions`; nothing is welded here. */

type MeshFileFormat = 'stl-ascii' | 'stl-binary' | 'obj' | 'ply' | '3mf';

export interface ParsedBody {
  readonly name?: string;
  /** Flat xyz in FILE units. */
  readonly positions: number[];
  /** Triangle corner indices into `positions / 3`. */
  readonly triangles: number[];
  /** Named triangle ranges `[start, end)` in triangle numbers (OBJ groups). */
  readonly groups: Array<{ readonly name: string; readonly start: number; readonly end: number }>;
}

export interface ParsedMeshFile {
  readonly format: MeshFileFormat;
  readonly bodies: ParsedBody[];
  /** Metres per file unit when the format states one (3MF); undefined for unitless formats. */
  readonly unitMetres?: number;
  /** Attribute kinds read and discarded, e.g. `normals: 12`. */
  readonly dropped: string[];
}

export type MeshParseCode = 'MESH_IMPORT_FORMAT_UNKNOWN' | 'MESH_IMPORT_PARSE' | 'MESH_IMPORT_EMPTY' | 'MESH_IMPORT_TOO_LARGE';

/** Size limits a reader enforces while expanding (3MF components can multiply bodies); Infinity = none. */
export interface ParseLimits {
  readonly maxBodies: number;
  readonly maxTriangles: number;
  /** Largest decompressed size of the archive parts a reader inflates (3MF). */
  readonly maxBytes: number;
}

export const NO_LIMITS: ParseLimits = { maxBodies: Infinity, maxTriangles: Infinity, maxBytes: 1 << 30 };

export interface MeshParseFailure {
  readonly code: MeshParseCode;
  readonly message: string;
}

export const isParseFailure = (value: ParsedMeshFile | MeshParseFailure): value is MeshParseFailure => 'code' in value;

export const parseFailure = (code: MeshParseCode, message: string): MeshParseFailure => ({ code, message });
