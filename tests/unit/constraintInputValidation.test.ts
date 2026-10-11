import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

function twoLines(): { doc: CadDocument; a: string; b: string } {
  const first = execute(createEmptyDocument(), 'draw_line', { start: [0, 0], end: [10, 0] });
  const second = execute(first.document, 'draw_line', { start: [0, 5], end: [10, 5] });
  return { doc: second.document, a: first.affected[0]!, b: second.affected[0]! };
}

describe('add_constraint input validation', () => {
  const { doc, a, b } = twoLines();

  it('refuses a reference to an entity that does not exist', () => {
    const result = execute(doc, 'add_constraint', {
      constraint: { kind: 'parallel', a: { entityId: a }, b: { entityId: 'ghost' } },
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain("entity 'ghost' does not exist");
  });

  it('refuses a malformed value expression', () => {
    const result = execute(doc, 'add_constraint', {
      constraint: { kind: 'distance', a: { entityId: a }, b: { entityId: b }, value: '2*' },
    });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('not a valid expression');
  });

  it('accepts numeric, parameter-expression and scientific-notation values', () => {
    for (const value of [5, 'width / 2', '1e-3']) {
      const result = execute(doc, 'add_constraint', {
        constraint: { kind: 'distance', a: { entityId: a }, b: { entityId: b }, value },
      });
      expect(result.affected).toHaveLength(1);
    }
  });
});

describe('update_constraint input validation', () => {
  const { doc, a, b } = twoLines();
  const added = execute(doc, 'add_constraint', {
    constraint: { kind: 'distance', a: { entityId: a }, b: { entityId: b }, value: 5 },
  });
  const constraintId = added.affected[0]!;

  it('refuses retargeting to a missing entity', () => {
    const result = execute(added.document, 'update_constraint', {
      id: constraintId,
      patch: { b: { entityId: 'ghost' } },
    });
    expect(result.document).toBe(added.document);
    expect(result.summary).toContain("entity 'ghost' does not exist");
  });

  it('refuses a malformed value expression and keeps the old value', () => {
    const result = execute(added.document, 'update_constraint', {
      id: constraintId,
      patch: { value: '(1+' },
    });
    expect(result.document).toBe(added.document);
    expect(result.summary).toContain('not a valid expression');
  });

  it('still applies a valid patch', () => {
    const result = execute(added.document, 'update_constraint', {
      id: constraintId,
      patch: { value: 8, b: { entityId: a } },
    });
    expect(result.document.constraints[constraintId]).toMatchObject({ value: 8 });
  });
});
