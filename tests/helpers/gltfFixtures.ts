import { uint8ArrayToBase64 } from '@lib/base64';

export type JsonObject = Record<string, unknown>;

/** Bytes of a unit triangle: 3 x VEC3 float32 positions (36 bytes), 3 x uint16 indices (6 bytes), 2 bytes of padding. */
export function triangleBytes(): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => view.setFloat32(i * 4, v, true));
  [0, 1, 2].forEach((v, i) => view.setUint16(36 + i * 2, v, true));
  return bytes;
}

export const dataUri = (bytes: Uint8Array): string => `data:application/octet-stream;base64,${uint8ArrayToBase64(bytes)}`;

/** A one-triangle glTF 2.0 JSON (buffer embedded as a data: URI) whose top-level fields `patch` replaces. */
export function triangleGltf(patch: JsonObject = {}): JsonObject {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'tri', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 44, uri: dataUri(triangleBytes()) }],
    ...patch,
  };
}

/** GLB container of `json` and an optional BIN payload. */
export function glb(json: JsonObject, bin?: Uint8Array): Uint8Array {
  const pad = (n: number): number => (4 - (n % 4)) % 4;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = jsonBytes.length + pad(jsonBytes.length);
  const binLength = bin === undefined ? 0 : bin.length + pad(bin.length);
  const total = 12 + 8 + jsonLength + (bin === undefined ? 0 : 8 + binLength);
  const out = new Uint8Array(total).fill(0x20);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  if (bin !== undefined) {
    const at = 20 + jsonLength;
    out.fill(0, at, at + 8 + binLength);
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, 0x004e4942, true);
    out.set(bin, at + 8);
  }
  return out;
}
