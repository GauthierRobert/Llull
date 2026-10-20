import { describe, expect, it } from 'vitest';
import { expectPure } from '../helpers/expectNoOp';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { addArc, addCircle, addLine, circleOf, constrain, emptySketch, lineOf, ref, solve, type Sketch } from './helpers/sketch';

/** Four nearly-rectangular lines closed with coincident corners; returns [bottom, right, top, left]. */
function looseRectangle(s: Sketch): [string, string, string, string] {
  const bottom = addLine(s, [0, 0], [40, 1]);
  const right = addLine(s, [40, 1], [41, 20]);
  const top = addLine(s, [41, 20], [1, 21]);
  const left = addLine(s, [1, 21], [0, 0]);
  constrain(s, 'coincident', ref(bottom, 'end'), ref(right, 'start'));
  constrain(s, 'coincident', ref(right, 'end'), ref(top, 'start'));
  constrain(s, 'coincident', ref(top, 'end'), ref(left, 'start'));
  constrain(s, 'coincident', ref(left, 'end'), ref(bottom, 'start'));
  return [bottom, right, top, left];
}

describe('degrees of freedom', () => {
  it('counts the unknowns of free curves: line 4, circle 3, arc 5', () => {
    const s = emptySketch();
    addLine(s, [0, 0], [1, 0]);
    expect(solve(s)).toMatchObject({ dof: 4, converged: true, iterations: 0, fullyConstrained: [], isFullyConstrained: false });
    addCircle(s, [5, 5], 1);
    expect(solve(s).dof).toBe(7);
    addArc(s, [9, 9], 1, 0, 1);
    expect(solve(s).dof).toBe(12);
  });

  it('a rectangle with H/V, two dimensions and a fixed corner has 0 DOF and every line is fully constrained', () => {
    const s = emptySketch();
    const [bottom, right, top, left] = looseRectangle(s);
    constrain(s, 'horizontal', ref(bottom));
    constrain(s, 'horizontal', ref(top));
    constrain(s, 'vertical', ref(right));
    constrain(s, 'vertical', ref(left));
    expect(solve(s)).toMatchObject({ dof: 4, isFullyConstrained: false });
    constrain(s, 'aligned', ref(bottom), undefined, { value: 40 });
    constrain(s, 'aligned', ref(right), undefined, { value: 20 });
    expect(solve(s).dof).toBe(2);
    const pinned = lineOf(s, bottom).start;
    constrain(s, 'fix', ref(bottom, 'start'));
    const data = solve(s);
    expect(data).toMatchObject({ dof: 0, converged: true, isFullyConstrained: true });
    expect([...data.fullyConstrained].sort()).toEqual([bottom, left, right, top].sort());
    expect(lineOf(s, bottom).start).toEqual(pinned);
    expect(lineOf(s, bottom).end[1]).toBeCloseTo(pinned[1], 8);
    expect(lineOf(s, top).start[0]).toBeCloseTo(pinned[0] + 40, 6);
    expect(lineOf(s, top).start[1]).toBeCloseTo(pinned[1] + 20, 6);
    expect(lineOf(s, left).start[0]).toBeCloseTo(pinned[0], 6);
  });

  it('only the entities every constraint pins are reported fully constrained', () => {
    const s = emptySketch();
    const a = addLine(s, [0, 0], [10, 0]);
    const b = addLine(s, [20, 0], [30, 0]);
    constrain(s, 'fix', ref(a));
    expect(solve(s).fullyConstrained).toEqual([a]);
    expect(b).not.toBe(a);
  });
});

describe('over-constraint and conflict refusal', () => {
  it('refuses a conflicting dimension and names the constraint it contradicts', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 0]);
    const first = constrain(s, 'aligned', ref(line), undefined, { value: 5 }).id!;
    const second = constrain(s, 'aligned', ref(line), undefined, { value: 7 });
    expect(second.id).toBeUndefined();
    expect(second.refused).toContain('conflicts');
    expect(second.refused).toContain(first);
    expect(s.doc.constraintOrder).toEqual([first]);
  });

  it('refuses a redundant but consistent constraint with the ids that already imply it', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 3]);
    const first = constrain(s, 'horizontal', ref(line)).id!;
    const again = constrain(s, 'horizontal', ref(line));
    expect(again.refused).toContain('redundant');
    expect(again.refused).toContain(first);
    const duplicate = constrain(s, 'aligned', ref(line), undefined, { value: 8 });
    expect(duplicate.id).toBeDefined();
    expect(constrain(s, 'aligned', ref(line), undefined, { value: 8 }).refused).toContain(duplicate.id);
  });

  it('refuses perpendicular on top of vertical + horizontal lines (implied by the others)', () => {
    const s = emptySketch();
    const a = addLine(s, [0, 0], [10, 0]);
    const b = addLine(s, [0, 0], [0, 10]);
    const h = constrain(s, 'horizontal', ref(a)).id!;
    const v = constrain(s, 'vertical', ref(b)).id!;
    const refused = constrain(s, 'perpendicular', ref(a), ref(b)).refused!;
    expect(refused).toContain('redundant');
    expect(refused).toContain(h);
    expect(refused).toContain(v);
  });

  it('refuses a conflicting update and leaves the document unchanged', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 0]);
    constrain(s, 'aligned', ref(line), undefined, { value: 5 });
    const other = constrain(s, 'horizontal_distance', ref(line, 'start'), ref(line, 'end'), { value: 5 }).refused;
    expect(other).toContain('redundant');
    const diagonal = constrain(s, 'vertical_distance', ref(line, 'start'), ref(line, 'end'), { value: 1 }).id!;
    const result = execute(s.doc, 'update_constraint', { id: diagonal, patch: { value: 6 } });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(s.doc);
    expect(result.summary).toContain('refused');
  });

  it('refuses a constraint that adds no restriction', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 0]);
    const refused = constrain(s, 'coincident', ref(line, 'start'), ref(line, 'start')).refused;
    expect(refused).toContain('adds no restriction');
  });
});

describe('flip refusal', () => {
  it('refuses an edit that moves a signed angle to the other side', () => {
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
  });

  it('accepts a consistent third side of a dimensioned triangle', () => {
    const s = emptySketch();
    const ab = addLine(s, [0, 0], [10, 0]);
    const bc = addLine(s, [10, 0], [5, 8]);
    const ca = addLine(s, [5, 8], [0, 0]);
    constrain(s, 'aligned', ref(ab), undefined, { value: 10 });
    constrain(s, 'aligned', ref(bc), undefined, { value: 9.43 });
    constrain(s, 'coincident', ref(ab, 'end'), ref(bc, 'start'));
    constrain(s, 'coincident', ref(bc, 'end'), ref(ca, 'start'));
    constrain(s, 'coincident', ref(ca, 'end'), ref(ab, 'start'));
    const fine = execute(s.doc, 'add_constraint', { constraint: { kind: 'aligned', a: ref(ca), value: 9.43 } });
    expect(fine.affected).toHaveLength(1);
    expect(solve({ doc: fine.document }).converged).toBe(true);
  });
});

describe('symmetric axis lifecycle', () => {
  it('deleting the axis entity removes the symmetric constraint that mirrors about it', () => {
    const s = emptySketch();
    const axis = addLine(s, [0, 0], [0, 10]);
    const p = addCircle(s, [-3, 2], 0.5);
    const q = addCircle(s, [4, 3], 0.5);
    const id = constrain(s, 'symmetric', ref(p, 'center'), ref(q, 'center'), { axis: ref(axis) }).id!;
    const result = execute(s.doc, 'delete_entities', { ids: [axis] });
    expect(result.document.constraints[id]).toBeUndefined();
    expect(result.document.constraintOrder).not.toContain(id);
  });
});

describe('solver properties', () => {
  it('is deterministic and pure', () => {
    const build = (): Sketch => {
      const s = emptySketch();
      looseRectangle(s);
      return s;
    };
    const first = build();
    const second = build();
    expect(JSON.stringify(solve(first))).toBe(JSON.stringify(solve(second)));
    expect(JSON.stringify(first.doc)).toBe(JSON.stringify(second.doc));
    const s = build();
    expectPure(s.doc, () => execute(s.doc, 'solve_constraints', {}));
  });

  it('solving twice changes nothing the second time', () => {
    const s = emptySketch();
    looseRectangle(s);
    solve(s);
    const once = JSON.stringify(s.doc.entities);
    solve(s);
    expect(JSON.stringify(s.doc.entities)).toBe(once);
  });

  it('tangent circle stays tangent after a line moves (fix + tangent chain)', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 0]);
    const circle = addCircle(s, [5, 3], 1);
    constrain(s, 'tangent', ref(line), ref(circle));
    constrain(s, 'radius', ref(circle), undefined, { value: 2 });
    solve(s);
    expect(circleOf(s, circle).radius).toBeCloseTo(2, 6);
    expect(circleOf(s, circle).center[1]).toBeCloseTo(2, 6);
  });

  it('documents with the original six constraint kinds save and load unchanged', () => {
    const s = emptySketch();
    const a = addLine(s, [0, 0], [10, 0]);
    const b = addLine(s, [0, 5], [10, 8]);
    const circle = addCircle(s, [5, 12], 2);
    constrain(s, 'parallel', ref(a), ref(b));
    constrain(s, 'tangent', ref(b), ref(circle));
    constrain(s, 'coincident', ref(a, 'start'), ref(b, 'start'));
    constrain(s, 'distance', ref(a, 'end'), ref(b, 'end'), { value: 5 });
    const loaded = deserializeDocument(serializeDocument(s.doc));
    expect(loaded.constraints).toEqual(s.doc.constraints);
    expect(loaded.constraintOrder).toEqual(s.doc.constraintOrder);
  });
});
