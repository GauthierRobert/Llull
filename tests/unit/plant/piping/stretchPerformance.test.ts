/**
 * Performance budgets of the orthogonal stretch and `edit_route` (02 RTE §8, M3) on a large run set: 200 runs of 3 legs each between their own tie-ins.
 * Budgets are generous bounds, not benchmarks: §8 asks 1.5 s for the regeneration of 1 000 runs (1.5 ms per run). Measured on the development laptop
 * (2026-10-24): stretching 200 runs 114 ms (0.6 ms per run, so about 0.6 s for 1 000), one edit_route 4 ms, piping_takeoff of the set 20 ms.
 */

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { pipingDocument } from '@aec/plant/piping/derive';
import { apply, data } from '../../../helpers/commandAssertions';
import { addTie, cs150Document } from './rteFixtures';

const RUNS = 200;
const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

/** `RUNS` lines, each routed +X 2000, +Y 3000, +X 2000 between its own tie-ins A_i (0, 4000 i, 0) and B_i (4000, 4000 i + 3000, 0). */
function bigRunSet(): { doc: CadDocument; ends: string[] } {
  let doc = cs150Document();
  const ends: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    const a = addTie(doc, `A${i}`, [0, 4000 * i, 0], [1, 0, 0]);
    const b = addTie(a.doc, `B${i}`, [4000, 4000 * i + 3000, 0], [-1, 0, 0]);
    const line = apply(b.doc, 'create_pipeline', { service: 'P', sequence: String(1000 + i), spec: 'CS150', dn: 100 });
    doc = apply(line, 'route_pipe', {
      lineId: piping(line).lineOrder.at(-1),
      from: { portId: a.id },
      to: { portId: b.id },
      legs: [
        { direction: '+X', length: 2000 },
        { direction: '+Y', length: 3000 },
      ],
    });
    ends.push(b.id);
  }
  return { doc, ends };
}

describe('stretch and edit_route performance budgets', () => {
  const set = bigRunSet();

  it(`stretches ${RUNS} runs at once (every end tie-in moved 200 mm along Y) within 1 s`, () => {
    const model = piping(set.doc);
    const moved: CadDocument = {
      ...set.doc,
      plant: {
        ...set.doc.plant,
        piping: {
          ...model,
          tieIns: Object.fromEntries(
            Object.entries(model.tieIns).map(([id, tie]) => [
              id,
              set.ends.includes(id)
                ? { ...tie, port: { ...tie.port, position: [tie.port.position[0], tie.port.position[1] + 200, 0] } }
                : tie,
            ]),
          ),
        },
      },
    } as CadDocument;
    const started = performance.now();
    const result = pipingDocument.reconcile?.(set.doc, moved);
    const elapsed = performance.now() - started;
    expect(result?.notes[0]).toContain(`re-routed ${RUNS} run(s)`);
    const broken = Object.values(piping(result?.document as CadDocument).runs).filter((run: PipeRun) => run.broken !== undefined);
    expect(broken).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  it('one edit_route (move_pi, stretch_leg) on a run of the large set within 250 ms each', () => {
    const runId = piping(set.doc).runOrder[100] as string;
    for (const params of [
      { runId, op: 'move_pi', index: 0, delta: [300, 0, 0] },
      { runId, op: 'stretch_leg', index: 0, length: 2300 },
    ]) {
      const started = performance.now();
      const result = execute(set.doc, 'edit_route', params);
      const elapsed = performance.now() - started;
      expect(result.rejected, result.summary).toBeUndefined();
      expect(elapsed).toBeLessThan(250);
    }
  });

  it('piping_takeoff of the whole set answers within 500 ms', () => {
    const started = performance.now();
    const takeoff = data<{ runs: string[] }>(set.doc, 'piping_takeoff', {});
    expect(takeoff.runs).toHaveLength(RUNS);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
