import { describe, it } from 'vitest';
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
