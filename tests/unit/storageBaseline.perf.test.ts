import { describe, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { planSceneOf } from '@core/geometry/planSceneCache';
import { synRackDocument } from '../helpers/synRack';

const mb = (): string =>
  `${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB heap, ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB rss`;
describe.skipIf(process.env['VIS_PERF'] === undefined)('storage baseline', () => {
  it.each([437, 4367])(
    'SYN-RACK bays=%i',
    (bays) => {
      globalThis.gc?.();
      const m0 = mb();
      let t = performance.now();
      const doc = synRackDocument(bays);
      const tBuild = performance.now() - t;
      globalThis.gc?.();
      const m1 = mb();
      t = performance.now();
      const json = serializeDocument(doc);
      const tSer = performance.now() - t;
      t = performance.now();
      const back = deserializeDocument(json);
      const tDe = performance.now() - t;
      globalThis.gc?.();
      const m2 = mb();
      t = performance.now();
      const { scene } = planSceneOf(back);
      const tPlan = performance.now() - t;
      globalThis.gc?.();
      const m3 = mb();
      console.warn(
        `STORAGE-BASE bays=${bays} n=${scene.instances.length} | build ${tBuild.toFixed(0)} ms | doc ${m1} (before ${m0}) | save ${tSer.toFixed(0)} ms ${(json.length / 1e6).toFixed(1)} MB | load ${tDe.toFixed(0)} ms | +loaded ${m2} | planScene ${tPlan.toFixed(0)} ms | +scene ${m3}`,
      );
    },
    900_000,
  );
});

/** The same measurement for a packed instance array (VIS1): one component, n placements, no per-instance Entity. */
describe.skipIf(process.env['VIS_PERF'] === undefined)('storage: instance array', () => {
  it.each([[[50, 50, 40]], [[100, 100, 100]]] as const)(
    'grid %j',
    (counts) => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [10, 20, 30] }).document;
      doc = execute(doc, 'add_cylinder', { radius: 4, height: 50, position: [20, 0, 0] }).document;
      doc = execute(doc, 'create_component', { name: 'Bolt', entityIds: doc.order, componentId: 'bolt' }).document;
      globalThis.gc?.();
      const m0 = mb();
      let t = performance.now();
      const made = execute(doc, 'add_instance_array', { componentId: 'bolt', counts, step: [100, 100, 100], rotation: [0, 0, 0.4] });
      const tCmd = performance.now() - t;
      t = performance.now();
      const json = serializeDocument(made.document);
      const tSer = performance.now() - t;
      t = performance.now();
      const back = deserializeDocument(json);
      const tDe = performance.now() - t;
      globalThis.gc?.();
      const m1 = mb();
      t = performance.now();
      const { scene } = planSceneOf(back);
      const tPlan = performance.now() - t;
      globalThis.gc?.();
      console.warn(
        `STORAGE-ARRAY n=${scene.instances.length} | command ${tCmd.toFixed(0)} ms | save ${tSer.toFixed(0)} ms ${(json.length / 1e6).toFixed(1)} MB | load ${tDe.toFixed(0)} ms | before ${m0} | loaded ${m1} | planScene ${tPlan.toFixed(0)} ms | +scene ${mb()}`,
      );
    },
    900_000,
  );
});
