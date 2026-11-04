/** VIS-M8a baseline, opt-in: `VIS_PERF=1 npx vitest run tests/unit/exportGltfPerf.test.ts --disableConsoleIntercept` (no hard gate; numbers go in the 09 spec). */
import { describe, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, DEFAULT_LAYER_ID, type CadDocument, type Entity } from '@core/model/types';
import { synRackDocument } from '../helpers/synRack';

/** `count` instances of a 2-solid component, each at its own position / rotation (every 3rd also scaled). */
function instanceFarm(count: number): CadDocument {
  const base = createEmptyDocument();
  const common = { layerId: DEFAULT_LAYER_ID, color: '#808080', rotation: [0, 0, 0] as const };
  const box: Entity = { ...common, id: 'b', kind: 'box', size: [10, 20, 30], position: [0, 0, 0], rotation: [0, 0, 0] };
  const pipe: Entity = { ...common, id: 'p', kind: 'cylinder', radius: 4, height: 50, position: [20, 0, 0], rotation: [0, 0, 0] };
  const entities: Record<string, Entity> = {};
  const order: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `i${i}`;
    order.push(id);
    entities[id] = {
      ...common,
      id,
      kind: 'instance',
      componentId: 'c',
      position: [(i % 100) * 100, Math.floor(i / 100) * 100, 0],
      rotation: [0, 0, (i % 7) * 0.3],
      ...(i % 3 === 0 ? { scale: [1 + (i % 5) * 0.1, 1, 2] as [number, number, number] } : {}),
    };
  }
  return { ...base, entities, order, components: { c: { id: 'c', name: 'C', entities: { b: box, p: pipe }, order: ['b', 'p'] } } };
}

function measure(label: string, doc: CadDocument, modes: readonly ('expand' | 'gpu')[] = ['gpu', 'expand']): void {
  const cells: string[] = [];
  for (const instancing of modes) {
    const t0 = performance.now();
    const data = execute(doc, 'export_gltf', { instancing }).data as { text: string; nodeCount: number };
    const ms = performance.now() - t0;
    console.warn(`GLTF-PERF-PART ${label} ${instancing}: ${ms.toFixed(0)} ms`);
    cells.push(`${instancing}: ${ms.toFixed(0)} ms, ${(data.text.length / 1e6).toFixed(2)} MB JSON, ${data.nodeCount} nodes`);
  }
  console.warn(`GLTF-PERF ${label} | ${cells.join(' | ')}`);
}

describe.skipIf(process.env['VIS_PERF'] === undefined)('export_gltf expand vs gpu', () => {
  it.each([8, 44, 437])(
    'SYN-RACK bays = %i',
    (bays) => measure(`SYN-RACK bays=${bays}`, synRackDocument(bays), bays > 44 ? ['gpu'] : ['gpu', 'expand']),
    600_000,
  );
  it.each([1_000, 10_000, 100_000])(
    'instance farm n = %i',
    (n) => measure(`farm n=${n}`, instanceFarm(n), n >= 100_000 ? ['gpu'] : ['gpu', 'expand']),
    600_000,
  );
  it(
    'instance farm n = 1 000 000 (gpu only: expanded does not fit in memory)',
    () => measure('farm n=1000000', instanceFarm(1_000_000), ['gpu']),
    600_000,
  );
});
