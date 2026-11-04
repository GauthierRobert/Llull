/** Hostile-input table: glTF 2.0 JSON and GLB files (plant 09 VIS-M8d), through `import_gltf`. */
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { uint8ArrayToBase64 } from '@lib/base64';
import { dataUri, glb, triangleBytes, triangleGltf } from '../gltfFixtures';
import { asBytes, type HostileReader } from './types';

/** A valid file whose scene lists `records` mesh nodes (each one a world-space body), as glTF JSON text. */
const nodesFile = (records: number): string =>
  JSON.stringify(
    triangleGltf({
      nodes: Array.from({ length: records }, () => ({ mesh: 0 })),
      scenes: [{ nodes: Array.from({ length: records }, (_, k) => k) }],
    }),
  );

const nested = (depth: number): string =>
  JSON.stringify(triangleGltf({ nodes: Array.from({ length: depth + 1 }, (_, k) => (k === depth ? { mesh: 0 } : { children: [k + 1] })) }));

export const GLTF_READERS: readonly HostileReader[] = [
  {
    name: 'gltf: import_gltf (execute, glTF JSON with embedded buffer)',
    covers: ['import_gltf', 'core/src/commands/exchange/gltfContainer.ts:readGltfFile'],
    input: 'bytes',
    build: (records) => new TextEncoder().encode(nodesFile(records)),
    nest: (depth) => new TextEncoder().encode(nested(depth)),
    read: (input) => execute(createEmptyDocument(), 'import_gltf', { dataBase64: uint8ArrayToBase64(asBytes(input)) }),
    accepts: (result) => (result as { affected: string[] }).affected.length === 3,
    maxRecords: 1 << 12,
    extra: [
      {
        name: 'GLB whose chunk lengths run past the file',
        input: () => {
          const bytes = glb(triangleGltf({ buffers: [{ byteLength: 44 }] }), triangleBytes());
          new DataView(bytes.buffer).setUint32(12, 0xffffff00, true);
          return bytes;
        },
      },
      {
        name: 'buffer byteLength and accessor counts of 2^31',
        input: () =>
          new TextEncoder().encode(
            JSON.stringify(
              triangleGltf({
                buffers: [{ byteLength: 2 ** 31, uri: dataUri(triangleBytes()) }],
                accessors: [{ bufferView: 0, componentType: 5126, count: 2 ** 31, type: 'VEC3' }],
              }),
            ),
          ),
      },
    ],
  },
];
