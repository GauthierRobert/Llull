import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { addLine, constrain, emptySketch, length, lineOf, ref, solve, type Sketch } from './helpers/sketch';

/** A chain of `count` lines joined end to start by coincident constraints, each with an aligned (length) dimension. */
function buildChain(count: number): { sketch: Sketch; ids: string[]; milliseconds: number } {
  const sketch = emptySketch();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(addLine(sketch, [i * 10, 0], [(i + 1) * 10, i % 2]));
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    if (i > 0) expect(constrain(sketch, 'coincident', ref(ids[i - 1]!, 'end'), ref(ids[i]!, 'start')).id).toBeDefined();
    expect(constrain(sketch, 'aligned', ref(ids[i]!), undefined, { value: length(lineOf(sketch, ids[i]!)) }).id).toBeDefined();
  }
  return { sketch, ids, milliseconds: performance.now() - started };
}

/** Bounds are for a plain run; they scale by how much slower a fixed 15-line reference build runs here (coverage instrumentation, load). */
const REFERENCE_MILLISECONDS = 50;
const SLACK = ((): number => {
  buildChain(15);
  return Math.max(1, buildChain(15).milliseconds / REFERENCE_MILLISECONDS);
})();

describe('constraint editing stays fast on larger sketches', () => {
  it('builds a 60-line, 119-constraint chain in well under 5 s', () => {
    const { milliseconds } = buildChain(60);
    expect(milliseconds).toBeLessThan(5000 * SLACK);
  });

  it('adds one constraint to a 200-line chain in under 200 ms (best of three, so a loaded CI machine does not flake)', () => {
    const { sketch, ids } = buildChain(200);
    const constraint = { kind: 'horizontal_distance', a: ref(ids[101]!, 'start'), b: ref(ids[101]!, 'end'), value: 10 };
    const timings = [0, 1, 2].map(() => {
      const started = performance.now();
      const result = execute(sketch.doc, 'add_constraint', { constraint });
      expect(result.affected).toHaveLength(1);
      return performance.now() - started;
    });
    expect(Math.min(...timings)).toBeLessThan(200 * SLACK);
  }, 120_000);

  it('solves the 200-line chain and reports its degrees of freedom', () => {
    const { sketch } = buildChain(200);
    const started = performance.now();
    const data = solve(sketch);
    expect(performance.now() - started).toBeLessThan(10_000 * SLACK);
    expect(data.converged).toBe(true);
    expect(data.dof).toBeGreaterThan(0);
  }, 120_000);
});
