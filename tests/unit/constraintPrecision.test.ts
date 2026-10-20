import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { addCircle, addLine, constrain, emptySketch, length, lineOf, ref, solve } from './helpers/sketch';

describe('small dimension edits are applied in full', () => {
  it.each([0.0001, 0.00001, 1e-7])('updating an aligned dimension from 10 to 10 + %s lands exactly on the new value', (delta) => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 0]);
    constrain(s, 'horizontal', ref(line));
    const dimension = constrain(s, 'aligned', ref(line), undefined, { value: 10 }).id!;
    solve(s);
    expect(length(lineOf(s, line))).toBeCloseTo(10, 9);
    const updated = execute(s.doc, 'update_constraint', { id: dimension, patch: { value: 10 + delta } });
    expect(updated.affected).toEqual([dimension]);
    s.doc = updated.document;
    const data = solve(s);
    expect(data.converged).toBe(true);
    expect(Math.abs(length(lineOf(s, line)) - (10 + delta))).toBeLessThan(1e-9);
  });

  it('a value change that is not satisfied reports non-convergence relative to the sketch size, not a fixed 1e-8', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 0]);
    constrain(s, 'aligned', ref(line), undefined, { value: 10 });
    const unsatisfied: CadDocument = {
      ...s.doc,
      constraints: { ...s.doc.constraints, other: { id: 'other', kind: 'aligned', a: ref(line), b: ref(line), value: 10.0001 } },
      constraintOrder: [...s.doc.constraintOrder, 'other'],
    };
    s.doc = unsatisfied;
    expect(solve(s).converged).toBe(false);
  });
});

describe('numerics', () => {
  it('an angle target near pi converges from a drawn angle near -pi', () => {
    const s = emptySketch();
    const a = addLine(s, [0, 0], [10, 0]);
    const b = addLine(s, [0, 0], [-10, -0.5]);
    const id = constrain(s, 'angle', ref(a), ref(b), { value: Math.PI - 0.001 });
    expect(id.id ?? id.refused).toBeDefined();
    if (id.id) {
      const data = solve(s);
      expect(data.converged).toBe(true);
    }
  });

  it('a sketch offset by 1e6 solves to the same shape', () => {
    const s = emptySketch();
    const line = addLine(s, [1e6, 1e6], [1e6 + 10, 1e6 + 1]);
    constrain(s, 'horizontal', ref(line));
    constrain(s, 'aligned', ref(line), undefined, { value: 12 });
    const data = solve(s);
    expect(data.converged).toBe(true);
    const l = lineOf(s, line);
    expect(l.end[1]).toBeCloseTo(l.start[1], 5);
    expect(length(l)).toBeCloseTo(12, 5);
  });
});

describe('clusters', () => {
  it('an unrelated, broken constraint group does not block editing another group', () => {
    const s = emptySketch();
    const a = addLine(s, [0, 0], [10, 0]);
    const b = addLine(s, [0, 5], [10, 5]);
    const c = addLine(s, [0, 20], [10, 21]);
    constrain(s, 'aligned', ref(a), undefined, { value: 10 });
    s.doc = {
      ...s.doc,
      constraints: {
        ...s.doc.constraints,
        x1: { id: 'x1', kind: 'aligned', a: ref(b), b: ref(b), value: 3 },
        x2: { id: 'x2', kind: 'aligned', a: ref(b), b: ref(b), value: 4 },
      },
      constraintOrder: [...s.doc.constraintOrder, 'x1', 'x2'],
    };
    expect(constrain(s, 'horizontal', ref(c)).id).toBeDefined();
  });

  it('a conflict through a symmetric axis names the constraints on the axis entity', () => {
    const s = emptySketch();
    const axis = addLine(s, [0, 0], [0, 10]);
    const p = addCircle(s, [-3, 2], 0.5);
    const q = addCircle(s, [4, 3], 0.5);
    const fixes = [
      constrain(s, 'fix', ref(axis)).id!,
      constrain(s, 'fix', ref(p, 'center')).id!,
      constrain(s, 'fix', ref(q, 'center')).id!,
    ];
    const refused = constrain(s, 'symmetric', ref(p, 'center'), ref(q, 'center'), { axis: ref(axis) }).refused!;
    expect(refused).toContain('conflicts');
    expect(refused).toContain(fixes[0]);
  });
});
