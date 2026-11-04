/** VIS-M8i opt-in: `VIS_PERF=1 NODE_OPTIONS=--expose-gc npx vitest run tests/unit/render/planSceneKeyPerf.test.ts --disableConsoleIntercept` (time and heap, continuously varying parameters). */
import { describe, it } from 'vitest';
import { planScene } from '@core/geometry/renderPlan';
import { type CadDocument, type Entity, DEFAULT_LAYER_ID, createEmptyDocument } from '@core/model/types';
import { referencePlanScene } from '../../helpers/planSceneReference';

const heapMb = (): number => {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed / 2 ** 20;
};

describe.skipIf(process.env['VIS_PERF'] === undefined)('planScene with 10^6 distinct box lengths', () => {
  it('reference vs optimised: time and retained heap', () => {
    const entities: Record<string, Entity> = {};
    const order: string[] = [];
    for (let index = 0; index < 1_000_000; index++) {
      const id = `v${index}`;
      order.push(id);
      entities[id] = {
        id,
        kind: 'box',
        position: [index, 0, 0],
        rotation: [0, 0.2, 0],
        layerId: DEFAULT_LAYER_ID,
        color: '#fff',
        size: [5 + index * 0.001, 2, 3],
      };
    }
    const doc: CadDocument = { ...createEmptyDocument(), entities, order };
    for (const [name, run] of [
      ['reference', referencePlanScene],
      ['optimised', planScene],
      ['reference', referencePlanScene],
      ['optimised', planScene],
    ] as const) {
      const before = heapMb();
      const t0 = performance.now();
      const scene = run(doc);
      const t1 = performance.now();
      const after = process.memoryUsage().heapUsed / 2 ** 20;
      console.warn(
        `VIS-PERF distinct ${name}: ${(t1 - t0).toFixed(0)} ms, heap grown by ${(after - before).toFixed(0)} MB (${scene.instances.length} instances, ${scene.prototypeKeys.length} prototypes)`,
      );
    }
  }, 600_000);
});
