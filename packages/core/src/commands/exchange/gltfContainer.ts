/** glTF 2.0 container reader for import_gltf: GLB (header + JSON chunk + optional BIN chunk) or glTF JSON, bounds-checked, no fs / network. */

import { base64ToUint8Array } from '../../lib/base64';
import { GltfError, type Json, indexOf, isRecord, listAt } from './gltfJson';

export interface GltfFile {
  readonly json: Json;
  /** The GLB BIN chunk (the payload of the buffer without a uri), else null. */
  readonly bin: Uint8Array | null;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
/** The one extension the reader understands (a file may require it). */
export const SUPPORTED_EXTENSION = 'EXT_mesh_gpu_instancing';

function parseJson(bytes: Uint8Array): Json {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new GltfError('GLTF_MALFORMED', 'the content is neither a GLB container nor valid UTF-8 glTF JSON');
  }
  if (!isRecord(value)) throw new GltfError('GLTF_MALFORMED', 'the glTF JSON root must be an object');
  return value;
}

/** JSON chunk and BIN chunk of a GLB; every chunk must lie inside the declared total length. */
function parseGlb(bytes: Uint8Array): GltfFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20) throw new GltfError('GLTF_MALFORMED', 'GLB shorter than its header and first chunk');
  if (view.getUint32(4, true) !== 2) throw new GltfError('GLTF_MALFORMED', `GLB version ${view.getUint32(4, true)} is not 2`);
  const total = view.getUint32(8, true);
  if (total > bytes.length || total < 20) throw new GltfError('GLTF_MALFORMED', `GLB declares ${total} bytes but holds ${bytes.length}`);
  let json: Json | null = null;
  let bin: Uint8Array | null = null;
  for (let offset = 12; offset < total; ) {
    if (offset + 8 > total) throw new GltfError('GLTF_MALFORMED', 'GLB chunk header runs past the end of the file');
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (length > total - start) throw new GltfError('GLTF_MALFORMED', `GLB chunk of ${length} bytes runs past the end of the file`);
    const payload = bytes.subarray(start, start + length);
    if (type === CHUNK_JSON && json === null) json = parseJson(payload);
    else if (type === CHUNK_BIN && bin === null && json !== null) bin = payload;
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (json === null) throw new GltfError('GLTF_MALFORMED', 'GLB has no JSON chunk');
  return { json, bin };
}

/** Rejects a file that is not glTF 2.0 or that requires an extension other than EXT_mesh_gpu_instancing. */
function checkAsset(json: Json): void {
  const version = isRecord(json['asset']) ? json['asset']['version'] : undefined;
  if (typeof version !== 'string' || !/^2(\.|$)/.test(version))
    throw new GltfError('GLTF_MALFORMED', `asset.version must be "2.0", got ${JSON.stringify(version)}`);
  for (const required of listAt(json, 'extensionsRequired', 'glTF'))
    if (required !== SUPPORTED_EXTENSION)
      throw new GltfError('GLTF_EXTENSION_REQUIRED', `the file requires the extension ${JSON.stringify(required)}, which is not supported`);
}

/** Reads GLB or glTF JSON from raw bytes, or glTF JSON from text. */
export function readGltfFile(source: { readonly text: string } | { readonly bytes: Uint8Array }): GltfFile {
  const file =
    'text' in source
      ? { json: parseJson(new TextEncoder().encode(source.text)), bin: null }
      : source.bytes.length >= 4 && new DataView(source.bytes.buffer, source.bytes.byteOffset, 4).getUint32(0, true) === GLB_MAGIC
        ? parseGlb(source.bytes)
        : { json: parseJson(source.bytes), bin: null };
  checkAsset(file.json);
  return file;
}

/** Bytes of a `data:` URI (base64), or a refusal; any other uri is an external file and is never read. */
function dataUriBytes(uri: string, what: string): Uint8Array {
  const marker = ';base64,';
  const at = uri.indexOf(marker);
  if (!uri.startsWith('data:') || at < 0) {
    const shown = uri.length > 60 ? `${uri.slice(0, 60)}...` : uri;
    throw new GltfError(
      'GLTF_EXTERNAL_URI',
      `${what} uses ${JSON.stringify(shown)}: only embedded base64 data: URIs are read, never files or URLs`,
    );
  }
  const bytes = base64ToUint8Array(uri.slice(at + marker.length));
  if (bytes === null) throw new GltfError('GLTF_MALFORMED', `${what} holds invalid base64`);
  return bytes;
}

/** The decoded `buffers` of a glTF file, one decode per buffer. */
export class GltfBuffers {
  private readonly decoded = new Map<number, Uint8Array>();
  private readonly defs: readonly unknown[];

  constructor(
    json: Json,
    private readonly bin: Uint8Array | null,
  ) {
    this.defs = listAt(json, 'buffers', 'glTF');
  }

  bytes(buffer: number): Uint8Array {
    const known = this.decoded.get(buffer);
    if (known !== undefined) return known;
    const def = this.defs[indexOf(buffer, this.defs.length, 'bufferView.buffer')];
    if (!isRecord(def)) throw new GltfError('GLTF_MALFORMED', `buffers[${buffer}] must be an object`);
    const { uri, byteLength } = def;
    const what = `buffers[${buffer}]`;
    let data: Uint8Array;
    if (uri === undefined) {
      if (buffer !== 0 || this.bin === null) throw new GltfError('GLTF_MALFORMED', `${what} has no uri and no GLB BIN chunk to read`);
      data = this.bin;
    } else if (typeof uri === 'string') data = dataUriBytes(uri, what);
    else throw new GltfError('GLTF_MALFORMED', `${what}.uri must be a string`);
    if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength < 0 || byteLength > data.length)
      throw new GltfError('GLTF_BAD_ACCESSOR', `${what}.byteLength ${JSON.stringify(byteLength)} exceeds the ${data.length} bytes of data`);
    const bytes = data.subarray(0, byteLength);
    this.decoded.set(buffer, bytes);
    return bytes;
  }
}
