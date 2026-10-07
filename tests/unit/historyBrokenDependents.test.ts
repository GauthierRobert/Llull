import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('history edits warn about steps that lose their inputs', () => {
  const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const moved = execute(box.document, 'move_entity', { id: box.affected[0]!, delta: [5, 0, 0] });
  const doc = execute(moved.document, 'add_sphere', { radius: 1 }).document;
  const [boxStep, moveStep, sphereStep] = doc.featureHistory.map((step) => step.id) as [
    string,
    string,
    string,
  ];

  it('delete_step names the dependent step that became a no-op', () => {
    const result = execute(doc, 'delete_step', { stepId: boxStep });
    expect(result.summary).toContain(`Warning: 1 step(s) no longer change the document`);
    expect(result.summary).toContain(`${moveStep} (move_entity)`);
    expect(result.summary).not.toContain(sphereStep);
  });

  it('set_step_suppressed on the producing step warns the same way', () => {
    const result = execute(doc, 'set_step_suppressed', { stepId: boxStep, suppressed: true });
    expect(result.summary).toContain(`${moveStep} (move_entity)`);
  });

  it('deleting an independent step does not warn', () => {
    const result = execute(doc, 'delete_step', { stepId: sphereStep });
    expect(result.summary).not.toContain('Warning');
  });

  it('reordering a dependent before its producer warns', () => {
    const result = execute(doc, 'reorder_step', { stepId: moveStep, newIndex: 0 });
    expect(result.summary).toContain(`${moveStep} (move_entity)`);
  });
});
