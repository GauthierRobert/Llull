/**
 * SC-Q4b: one golden plan per constraint family (snapshot + replay equality via `describePlans`), plus the solved-sketch facts the
 * snapshot cannot show on its own: convergence and the reported degrees of freedom.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { describePlans } from './describePlans';
import { CONSTRAINT_DOF, constraintPlans } from './plansConstraints';
import { runPlan } from './runPlan';
import { addLine, constrain, emptySketch, lineOf, ref, solve, type Sketch } from '../unit/helpers/sketch';

describe('constraint family golden plans', () => describePlans(constraintPlans));

describe('solved constraint plans', () => {
  for (const [name, actions] of Object.entries(constraintPlans)) {
    it(`${name}: converges and reports its degrees of freedom`, () => {
      const solved = execute(runPlan(actions).document, 'solve_constraints', {});
      const data = solved.data as { converged: boolean; dof: number; residual: number; skipped: unknown[] };
      expect(data.converged).toBe(true);
      expect(data.residual).toBeLessThan(1e-8);
      expect(data.skipped).toEqual([]);
      expect(data.dof).toBe(CONSTRAINT_DOF[name]);
    });
  }
});

describe('constraint edits that must be refused', () => {
  const triangle = (): Sketch => {
    const s = emptySketch();
    const ab = addLine(s, [0, 0], [10, 0]);
    const bc = addLine(s, [10, 0], [5, 8]);
    const ca = addLine(s, [5, 8], [0, 0]);
    constrain(s, 'coincident', ref(ab, 'end'), ref(bc, 'start'));
    constrain(s, 'coincident', ref(bc, 'end'), ref(ca, 'start'));
    constrain(s, 'coincident', ref(ca, 'end'), ref(ab, 'start'));
    constrain(s, 'fix', ref(ab, 'start'));
    constrain(s, 'horizontal', ref(ab));
    constrain(s, 'aligned', ref(ab), undefined, { value: 10 });
    constrain(s, 'aligned', ref(bc), undefined, { value: 9.43 });
    constrain(s, 'aligned', ref(ca), undefined, { value: 9.43 });
    return s;
  };

  it('a dimensioned triangle solves on the side it was drawn and reports 0 degrees of freedom', () => {
    const s = triangle();
    const data = solve(s);
    expect(data).toMatchObject({ converged: true, dof: 0, isFullyConstrained: true });
    expect(lineOf(s, s.doc.order[1]!).end[1]).toBeGreaterThan(0);
  });

  it('refuses a signed angle edited to the other side, accepts the same side, and names the flip', () => {
    const s = emptySketch();
    const a = addLine(s, [0, 0], [10, 0]);
    const b = addLine(s, [0, 0], [10, 6]);
    const angle = constrain(s, 'angle', ref(a), ref(b), { value: 0.5 }).id!;
    const flipped = execute(s.doc, 'update_constraint', { id: angle, patch: { value: -0.5 } });
    expect(flipped.affected).toEqual([]);
    expect(flipped.document).toBe(s.doc);
    expect(flipped.summary).toContain('flip');
    const kept = execute(s.doc, 'update_constraint', { id: angle, patch: { value: 0.9 } });
    expect(kept.affected).toEqual([angle]);
    s.doc = kept.document;
    const solved = solve(s);
    expect(solved.converged).toBe(true);
    const direction = lineOf(s, b);
    expect(Math.atan2(direction.end[1] - direction.start[1], direction.end[0] - direction.start[0])).toBeCloseTo(0.9, 6);
  });

  it('refuses a conflicting and a redundant dimension without touching the sketch', () => {
    const s = triangle();
    const before = s.doc;
    const conflict = constrain(s, 'aligned', ref(s.doc.order[0]!), undefined, { value: 11 });
    expect(conflict.refused).toContain('conflicts');
    const redundant = constrain(s, 'horizontal', ref(s.doc.order[0]!));
    expect(redundant.refused).toContain('redundant');
    expect(s.doc).toBe(before);
  });
});
