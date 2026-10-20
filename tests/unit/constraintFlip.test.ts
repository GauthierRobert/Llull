import { describe, expect, it } from 'vitest';
import { findFlips } from '@core/commands/parametric/flipGuard';
import { buildLayout } from '@core/commands/parametric/solver/layout';
import type { Constraint } from '@core/model/types';
import { addLine, constrain, emptySketch, ref } from './helpers/sketch';

function triangle(): { constraints: Constraint[]; layout: ReturnType<typeof buildLayout> } {
  const s = emptySketch();
  const ab = addLine(s, [0, 0], [10, 0]);
  const bc = addLine(s, [10, 0], [5, 8]);
  const ca = addLine(s, [5, 8], [0, 0]);
  constrain(s, 'coincident', ref(ab, 'end'), ref(bc, 'start'));
  constrain(s, 'coincident', ref(bc, 'end'), ref(ca, 'start'));
  constrain(s, 'coincident', ref(ca, 'end'), ref(ab, 'start'));
  constrain(s, 'aligned', ref(ab), undefined, { value: 10 });
  constrain(s, 'aligned', ref(bc), undefined, { value: 9.43 });
  constrain(s, 'aligned', ref(ca), undefined, { value: 9.43 });
  const constraints = s.doc.constraintOrder.map((id) => s.doc.constraints[id]!);
  return { constraints, layout: buildLayout(s.doc, constraints) };
}

describe('findFlips', () => {
  it('reports a dimensioned triangle that came out mirrored', () => {
    const { constraints, layout } = triangle();
    const mirrored = layout.x0.map((value, index) => (index % 2 === 1 ? -value : value));
    const flips = findFlips(layout, layout.x0, mirrored, constraints, null);
    expect(flips).toHaveLength(1);
    expect(flips[0]).toContain('mirrored');
  });

  it('reports nothing when the sketch keeps its orientation', () => {
    const { constraints, layout } = triangle();
    expect(findFlips(layout, layout.x0, Float64Array.from(layout.x0), constraints, null)).toEqual([]);
  });

  it('skips the constraint being added when comparing signed angles', () => {
    const s = emptySketch();
    const a = addLine(s, [0, 0], [10, 0]);
    const b = addLine(s, [0, 0], [10, 6]);
    const id = constrain(s, 'angle', ref(a), ref(b), { value: 0.5 }).id!;
    const constraints = [s.doc.constraints[id]!];
    const layout = buildLayout(s.doc, constraints);
    const mirrored = layout.x0.map((value, index) => (index % 2 === 1 ? -value : value));
    expect(findFlips(layout, layout.x0, mirrored, constraints, null)).toHaveLength(1);
    expect(findFlips(layout, layout.x0, mirrored, constraints, id)).toEqual([]);
  });
});
