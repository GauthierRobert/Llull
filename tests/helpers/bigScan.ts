/** A 327,680-triangle sphere imported through import_mesh_file into a memory asset store (display mesh of about 50k triangles). USE IN TESTS ONLY. */

import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { icosphere } from './meshFixtures';
import { memoryMeshAssets } from './memoryMeshAssets';

export function bigScan(): { doc: CadDocument; ctx: ExecutionContext; id: string; assets: ReturnType<typeof memoryMeshAssets> } {
  const assets = memoryMeshAssets();
  const ctx: ExecutionContext = { ...defaultContext(), meshAssets: assets };
  const sphere = icosphere(10, 7);
  const triangles = sphere.indices.length / 3;
  const bytes = new Uint8Array(84 + triangles * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles, true);
  for (let t = 0; t < triangles; t++)
    for (let k = 0; k < 3; k++)
      for (let a = 0; a < 3; a++)
        view.setFloat32(84 + t * 50 + 12 + k * 12 + a * 4, sphere.positions[(sphere.indices[t * 3 + k] as number) * 3 + a] as number, true);
  const imported = execute(createEmptyDocument(), 'import_mesh_file', { fileKey: assets.putFile(bytes), units: 'mm', name: 'scan' }, ctx);
  return { doc: imported.document, ctx, id: imported.affected[0] as string, assets };
}
