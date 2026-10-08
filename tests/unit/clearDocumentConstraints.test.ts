import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('clear_document also clears constraints, joints and drive relations', () => {
  const a = execute(createEmptyDocument(), 'draw_line', { start: [0, 0], end: [10, 0] });
  const b = execute(a.document, 'draw_line', { start: [0, 5], end: [10, 5] });
  const constrained = execute(b.document, 'add_constraint', {
    constraint: {
      kind: 'distance',
      a: { entityId: a.affected[0]! },
      b: { entityId: b.affected[0]! },
      value: 5,
    },
  }).document;

  it('removes constraints that referenced the cleared entities', () => {
    expect(Object.keys(constrained.constraints)).toHaveLength(1);
    const cleared = execute(constrained, 'clear_document', {}).document;
    expect(cleared.constraints).toEqual({});
    expect(cleared.constraintOrder).toEqual([]);
    expect(cleared.joints).toEqual({});
    expect(cleared.jointOrder).toEqual([]);
    expect(cleared.driveRelations).toEqual({});
    expect(cleared.driveRelationOrder).toEqual([]);
  });

  it('treats a document holding only a constraint as not empty', () => {
    const onlyConstraint = {
      ...createEmptyDocument(),
      constraints: constrained.constraints,
      constraintOrder: constrained.constraintOrder,
    };
    const result = execute(onlyConstraint, 'clear_document', {});
    expect(result.summary).not.toContain('already empty');
    expect(result.document.constraints).toEqual({});
  });

  it('an already-empty document is still a no-op', () => {
    const empty = createEmptyDocument();
    const result = execute(empty, 'clear_document', {});
    expect(result.document).toBe(empty);
    expect(result.summary).toContain('already empty');
  });
});
