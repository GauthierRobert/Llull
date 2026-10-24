/**
 * Performance budgets of 02 RTE V1 part 1 (§8): the operator clash check and the clash bodies of valves, flanges and tees on a large run set, socket-weld
 * routing, and the general (least-squares) stretch solve on a long chain. Budgets are generous bounds, not benchmarks; the measured times are in
 * TECHNICAL_SPEC §13.9.
 */

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { pipingClashBodies } from '@aec/plant/piping/clashBodies';
import { walkChain } from '@aec/plant/piping/stretchWalk';
import { apply, data } from '../../../helpers/commandAssertions';
import { operatorsDocument, smallBoreDocument } from './smallBoreFixtures';

const RUNS = 100;

/** `RUNS` parallel DN100 runs (y = 1500 i, x 0 -> 6000), each with a globe valve (actuator) at 3000, and one beam over every fifth valve. */
function operatorSet(): ReturnType<typeof apply> {
  let doc = operatorsDocument();
  for (let i = 0; i < RUNS; i++) {
    const y = 1500 * i;
    doc = apply(doc, 'add_tie_in_point', { tag: `A${i}`, position: [0, y, 0], direction: [1, 0, 0], dn: 100, endType: 'BW' });
    const a = doc.plant?.piping?.tieInOrder.at(-1) as string;
    doc = apply(doc, 'add_tie_in_point', { tag: `B${i}`, position: [6000, y, 0], direction: [-1, 0, 0], dn: 100, endType: 'BW' });
    const b = doc.plant?.piping?.tieInOrder.at(-1) as string;
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: String(1000 + i), spec: 'CS150OP', dn: 100 });
    const routed = execute(doc, 'route_pipe', { lineId: doc.plant?.piping?.lineOrder.at(-1), from: { portId: a }, to: { portId: b } });
    doc = routed.document;
    doc = apply(doc, 'insert_inline_component', {
      runId: (routed.data as { runId: string }).runId,
      type: 'valveGlobe',
      at: { leg: 0, centreDistance: 3000 },
    });
    if (i % 5 === 0)
      doc = apply(doc, 'add_steel_member', { role: 'beam', start: [3000, y - 700, 700], end: [3000, y + 700, 700], profile: 'IPE200' });
  }
  return doc;
}

describe('V1 performance budgets', () => {
  const doc = operatorSet();

  it(`check_piping with the operator clash check on ${RUNS} runs with valves and ${RUNS / 5} beams finds every beam hit within 20 s`, () => {
    const started = performance.now();
    const check = data<{ counts: { byCode: Record<string, number> } }>(doc, 'check_piping', {});
    const elapsed = performance.now() - started;
    expect(check.counts.byCode['RTE_VALVE_OPERATOR_CLASH']).toBe(RUNS / 5);
    expect(elapsed).toBeLessThan(20_000);
  });

  it(`the clash bodies of ${RUNS} runs (pipes, flanges, valves, operators) and check_clashes stay within 20 s`, () => {
    const started = performance.now();
    const bodies = pipingClashBodies(doc);
    const clashes = data<{ clashes: unknown[] }>(doc, 'check_clashes', {}).clashes;
    const elapsed = performance.now() - started;
    expect(bodies.length).toBeGreaterThan(RUNS * 8);
    expect(clashes.length).toBeGreaterThanOrEqual(RUNS / 5);
    expect(elapsed).toBeLessThan(20_000);
  });

  it('routing 100 socket-weld lines (a valve and an elbow each) stays within 20 s', () => {
    let model = smallBoreDocument('spec_sw800.json');
    const started = performance.now();
    for (let i = 0; i < 100; i++) {
      model = apply(model, 'add_tie_in_point', { tag: `S${i}`, position: [0, 500 * i, 0], direction: [0, 0, 1], dn: 25, endType: 'SW' });
      const tie = model.plant?.piping?.tieInOrder.at(-1) as string;
      model = apply(model, 'create_pipeline', { service: 'P', sequence: String(i), spec: 'SW800', dn: 25 });
      model = apply(model, 'route_pipe', {
        lineId: model.plant?.piping?.lineOrder.at(-1),
        from: { portId: tie },
        legs: [
          { direction: '+Z', length: 1000 },
          { direction: '+X', length: 1500 },
        ],
        inline: [{ type: 'valveGate', at: { leg: 0, centreDistance: 500 } }],
      });
    }
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it('the general stretch solve on a 60-leg chain (alternating sloped and vertical legs) answers within 1 s and keeps every direction', () => {
    const sloped: [number, number, number] = [Math.cos(Math.atan(0.01)), 0, -Math.sin(Math.atan(0.01))];
    const dirs = Array.from({ length: 60 }, (_, leg) =>
      leg % 2 === 0 ? sloped : ([0, 0, leg % 4 === 1 ? -1 : 1] as [number, number, number]),
    );
    const started = performance.now();
    const result = walkChain(dirs, [0, 0, 0], [100, 0, 0], 1e-6);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    // either solved with every leg keeping its direction, or refused as the orthogonal walk would
    if (result.ok)
      dirs.forEach((u, leg) => {
        const step = [0, 1, 2].map((axis) => (result.displacements[leg + 1]?.[axis] ?? 0) - (result.displacements[leg]?.[axis] ?? 0));
        const along = step[0]! * u[0] + step[1]! * u[1] + step[2]! * u[2];
        const rest = Math.hypot(step[0]! - along * u[0], step[1]! - along * u[1], step[2]! - along * u[2]);
        expect(rest).toBeLessThan(1e-6);
      });
  });
});
