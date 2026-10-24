/**
 * Plant 02 RTE V2 performance (docs/plant/02-spec-driven-routing §8, §13.12): many lines in one auto_route_lines transaction, where every routed
 * run is an obstacle (its clash bodies) of the next problem. Bounds are generous (a loaded machine); the measured times are in the spec.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply, ok } from '../../../helpers/commandAssertions';
import { cs150Document } from './rteFixtures';

/** `count` DN100 lines side by side (1 m apart in y), each 4 m along x, with `bendsFor` deciding a detour box per line. */
function parallelLines(count: number): { doc: CadDocument; lines: Record<string, unknown>[] } {
  let doc = cs150Document();
  const lines: Record<string, unknown>[] = [];
  for (let k = 0; k < count; k++) {
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: String(1000 + k), spec: 'CS150', dn: 100 });
    lines.push({
      lineId: doc.plant?.piping?.lineOrder.at(-1),
      from: { point: [0, 1000 * k, 0], direction: [1, 0, 0] },
      to: { point: [4000, 1000 * k, 0], direction: [-1, 0, 0] },
      gridMargin: 500,
    });
  }
  return { doc, lines };
}

describe('V2 performance: many lines in one transaction', () => {
  it('routes 64 parallel lines in one pass, each an obstacle for the next, and replays to the same document', () => {
    const { doc, lines } = parallelLines(64);
    const started = Date.now();
    const result = ok(doc, 'auto_route_lines', { lines, common: { grid: 100 } });
    const elapsed = Date.now() - started;
    expect(result.affected).toHaveLength(64);
    expect((result.data as { attempts: unknown[] }).attempts).toHaveLength(1);
    expect(result.document.plant?.piping?.runOrder).toHaveLength(64);
    expect(elapsed).toBeLessThan(30_000);
    const again = execute(doc, 'auto_route_lines', { lines, common: { grid: 100 } });
    expect(JSON.stringify(again.document.plant)).toBe(JSON.stringify(result.document.plant));
  });

  it('a problem built next to 39 routed runs still lists their clash bodies and builds quickly', () => {
    const { doc, lines } = parallelLines(40);
    const routed = ok(doc, 'auto_route_lines', { lines: lines.slice(0, 39), common: { grid: 100 } });
    const started = Date.now();
    const problem = ok(routed.document, 'route_problem', { ...(lines[39] as object), grid: 100, gridMargin: 1500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    const boxes = (problem.data as { problem: { obstacles: unknown[] } }).problem.obstacles;
    expect(boxes.length).toBeGreaterThan(0);
  });
});
