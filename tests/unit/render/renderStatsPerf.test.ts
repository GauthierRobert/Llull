/** VIS-M3a baseline, opt-in: `VIS_PERF=1 npx vitest run tests/unit/render/renderStatsPerf.test.ts --disableConsoleIntercept` (no hard gate; numbers go in the 09 spec). */
import { describe, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { planScene } from '@core/geometry/renderPlan';
import { SYN_RACK_BAYS, synRackCount, synRackDocument } from '../../helpers/synRack';

describe.skipIf(process.env['VIS_PERF'] === undefined)('render_stats timing on SYN-RACK-v1', () => {
  it.each(SYN_RACK_BAYS)(
    'n = %i',
    (bays) => {
      const doc = synRackDocument(bays);
      const t0 = performance.now();
      planScene(doc);
      const t1 = performance.now();
      const result = execute(doc, 'render_stats', { view: 'iso', width: 1920, height: 1080, projection: 'perspective' });
      const t2 = performance.now();
      console.warn(
        `VIS-PERF N=${synRackCount(bays)} planScene ${(t1 - t0).toFixed(0)} ms; render_stats total ${(t2 - t1).toFixed(0)} ms (${result.summary.slice(0, 120)})`,
      );
    },
    600_000,
  );
});
