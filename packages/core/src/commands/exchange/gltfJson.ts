/** Untrusted glTF JSON access for import_gltf: typed narrowing helpers and the refusal error the reader throws (caught once in the command). */

export type GltfCode =
  | 'CMD_INVALID_PARAMS'
  | 'GLTF_MALFORMED'
  | 'GLTF_EXTERNAL_URI'
  | 'GLTF_EXTENSION_REQUIRED'
  | 'GLTF_UNSUPPORTED'
  | 'GLTF_BAD_ACCESSOR'
  | 'GLTF_LIMIT'
  | 'GLTF_NO_GEOMETRY';

/** One-line fix per refusal code (`CommandError.remediation`). */
export const GLTF_REMEDIATION: Readonly<Record<GltfCode, string>> = {
  CMD_INVALID_PARAMS: 'pass the file as dataBase64 (GLB or glTF JSON bytes) or as text (glTF JSON), not both',
  GLTF_MALFORMED: 'check the file is glTF 2.0 (a .glb, or .gltf JSON) and not truncated',
  GLTF_EXTERNAL_URI: 'embed the buffers: export a .glb, or a .gltf with data: URIs (external files are never read)',
  GLTF_EXTENSION_REQUIRED: 'export without Draco / meshopt compression: only EXT_mesh_gpu_instancing is understood',
  GLTF_UNSUPPORTED: 'export plain triangle meshes with FLOAT positions (no sparse, quantized or compressed accessors)',
  GLTF_BAD_ACCESSOR: 'the accessor / bufferView / index data is inconsistent: re-export the file',
  GLTF_LIMIT: 'split the file or export fewer / simpler objects (see the limits in the command description)',
  GLTF_NO_GEOMETRY: 'the scene holds no triangle mesh: nothing to import',
};

/** A refusal found while reading (never escapes `import_gltf`: its `run` turns it into a coded rejection). */
export class GltfError extends Error {
  constructor(
    readonly code: GltfCode,
    message: string,
    readonly path: string = 'dataBase64',
  ) {
    super(message);
  }
}

export type Json = Readonly<Record<string, unknown>>;

export const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The object under `key` of `json` (absent -> undefined; another type -> GLTF_MALFORMED). */
export function recordAt(json: Json, key: string, where: string): Json | undefined {
  const value = json[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new GltfError('GLTF_MALFORMED', `${where}.${key} must be an object`);
  return value;
}

/** The array under `key` of `json` (absent -> []; another type -> GLTF_MALFORMED). */
export function listAt(json: Json, key: string, where: string): readonly unknown[] {
  const value = json[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GltfError('GLTF_MALFORMED', `${where}.${key} must be an array`);
  return value;
}

/** An integer in [0, bound) (an index into a glTF array of `bound` items). */
export function indexOf(value: unknown, bound: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= bound)
    throw new GltfError('GLTF_MALFORMED', `${what} must be an integer in 0..${bound - 1}, got ${JSON.stringify(value)}`);
  return value;
}

/** `length` finite numbers (a vector / matrix). */
export function numbersOf(value: unknown, length: number, what: string): number[] {
  const numbers: number[] = [];
  if (Array.isArray(value) && value.length === length)
    for (const v of value satisfies readonly unknown[]) if (typeof v === 'number' && Number.isFinite(v)) numbers.push(v);
  if (numbers.length !== length) throw new GltfError('GLTF_MALFORMED', `${what} must be ${length} finite numbers`);
  return numbers;
}
