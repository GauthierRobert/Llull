import { describe, it, expect, beforeEach } from 'vitest';
import { execute } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';
import { plans } from './plans';
import { normalize, normalizeGeometry } from './normalize';
import { runPlan } from './runPlan';

/** Plans whose replay_history result differs from the original today. Reason mandatory. */
const REPLAY_DIVERGES: Record<string, string> = {};

describe('golden replay corpus', () => {
  beforeEach(() => __resetIdCounter());

  for (const [name, actions] of Object.entries(plans)) {
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
