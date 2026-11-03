/** VIS-M3a / M7 baseline, opt-in: `VIS_PERF=1 npx vitest run tests/unit/render/renderStatsPerf.test.ts --disableConsoleIntercept` (no hard gate; numbers go in the 09 spec). */
import { describe, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { buildInstanceBvh, packBoxes } from '@core/geometry/instanceBvh';
import { bruteForceQuery, planScene } from '@core/geometry/renderPlan';
import { frustumPlanes } from '@core/geometry/renderPlanCamera';
import { SYN_RACK_BAYS, synRackCount, synRackDocument } from '../../helpers/synRack';

describe.skipIf(process.env['VIS_PERF'] === undefined)('render_stats timing on SYN-RACK-v1', () => {
  it.each(SYN_RACK_BAYS)(
    'n = %i',
    (bays) => {
      const doc = synRackDocument(bays);
      const params = { view: 'iso', width: 1920, height: 1080, projection: 'perspective' } as const;
      const t0 = performance.now();
      const scene = planScene(doc);
      const t1 = performance.now();
      const bvh = buildInstanceBvh(packBoxes(scene.instances.map((instance) => instance.aabb)));
      const t2 = performance.now();
      const narrow = frustumPlanes({
        projection: 'orthographic',
        eye: [0, -1000, 10],
        direction: [0, 1, 0],
        up: [0, 0, 1],
        fovDeg: 0,
        viewHeight: 20,
        widthPx: 1920,
        heightPx: 1080,
      });
      const bruteHits = bruteForceQuery(scene.instances)(narrow).length;
      const t3 = performance.now();
      const bvhHits = bvh.frustumQuery(narrow).length;
      const t4 = performance.now();
      const cold = execute(doc, 'render_stats', params);
      const t5 = performance.now();
      execute(doc, 'render_stats', { ...params, view: 'top' });
      const t6 = performance.now();
      execute(doc, 'render_stats', { ...params, view: 'front' });
      const t7 = performance.now();
      console.warn(
        `VIS-PERF N=${synRackCount(bays)} planScene ${(t1 - t0).toFixed(0)} ms; bvh build ${(t2 - t1).toFixed(0)} ms; narrow frustum brute ${(t3 - t2).toFixed(1)} ms vs bvh ${(t4 - t3).toFixed(1)} ms (${bruteHits}=${bvhHits} hits); ` +
          `render_stats call 1 ${(t5 - t4).toFixed(0)} ms, call 2 (builds the BVH) ${(t6 - t5).toFixed(0)} ms, call 3 ${(t7 - t6).toFixed(0)} ms (${cold.summary.slice(0, 80)})`,
      );
    },
    600_000,
  );
});
