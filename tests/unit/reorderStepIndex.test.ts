import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('reorder_step newIndex', () => {
  const built = [
    { name: 'add_box', params: { size: [1, 1, 1] } },
    { name: 'add_cylinder', params: { radius: 2, height: 4 } },
    { name: 'add_sphere', params: { radius: 1 } },
  ].reduce((doc, step) => execute(doc, step.name, step.params).document, createEmptyDocument());
  const firstId = built.featureHistory[0]!.id;

  it('rejects a fractional index at the schema level', () => {
    const result = execute(built, 'reorder_step', { stepId: firstId, newIndex: 1.6 });
    expect(result.document).toBe(built);
    expect(result.summary).toContain('invalid params');
  });

  it('clamps an index past the end to the last position', () => {
    const result = execute(built, 'reorder_step', { stepId: firstId, newIndex: 99 });
    expect(result.document.featureHistory[2]!.id).toBe(firstId);
  });
});
