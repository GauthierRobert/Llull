import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execute } from '@core/commands/registry';
import { getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@core/geometry/manifoldKernel';
import { __resetIdCounter } from '@lib/id';
import { kernelPlans } from './plans';
import { normalize, normalizeGeometry } from './normalize';
import { runPlan } from './runPlan';

/** Plans whose replay_history result differs from the original today. Reason mandatory. */
const REPLAY_DIVERGES: Record<string, string> = {};

describe('golden replay corpus (Manifold kernel)', () => {
  let previousKernel: GeometryKernel | null;

  beforeAll(async () => {
    previousKernel = getGeometryKernel();
    setGeometryKernel(await createManifoldKernel());
  }, 60_000);

  afterAll(() => setGeometryKernel(previousKernel));

  beforeEach(() => __resetIdCounter());

  for (const [name, actions] of Object.entries(kernelPlans)) {
    describe(name, () => {
      it('executes every step and matches the golden snapshot', async () => {
        const outcome = runPlan(actions);
        expect(outcome.failedSteps).toEqual([]);
        expect(outcome.affected.length).toBeGreaterThan(0);
        await expect(JSON.stringify(normalize(outcome.document), null, 2)).toMatchFileSnapshot(
          `./__snapshots__/${name}.json`,
        );
      });

      const replayTest = name in REPLAY_DIVERGES ? it.fails : it;
      replayTest('replay_history reproduces entities and order', () => {
        const outcome = runPlan(actions);
        const replayed = execute(outcome.document, 'replay_history', {});
        expect(normalizeGeometry(replayed.document)).toEqual(normalizeGeometry(outcome.document));
      });
    });
  }
});
