import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('edit_step_params / insert_step refuse params that make the step a no-op', () => {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
  doc = execute(doc, 'add_sphere', { radius: 1 }).document;
  const boxStepId = doc.featureHistory[0]!.id;

  it('edit_step_params with invalid params keeps the document and history', () => {
    const result = execute(doc, 'edit_step_params', {
      stepId: boxStepId,
      params: { size: [0, 0, 0] },
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain("step 'step-1' (add_box) changed nothing");
  });

  it('edit_step_params reports the schema path for a type-invalid value', () => {
    const result = execute(doc, 'edit_step_params', { stepId: boxStepId, params: { size: 'x' } });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('invalid params');
    expect(result.summary).toContain('size');
  });

  it('edit_step_params reports the command refusal for a wrong-length vector', () => {
    const result = execute(doc, 'edit_step_params', {
      stepId: boxStepId,
      params: { size: [1, 2] },
    });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('size must be 3 components');
  });

  it('insert_step reports the schema path for type-invalid params', () => {
    const result = execute(doc, 'insert_step', { name: 'add_box', params: { size: 'x' } });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('invalid params');
  });

  it('edit_step_params with valid params still regenerates', () => {
    const result = execute(doc, 'edit_step_params', {
      stepId: boxStepId,
      params: { size: [4, 4, 4] },
    });
    expect(Object.keys(result.document.entities)).toHaveLength(2);
    expect(result.summary).toContain('params updated');
  });

  it('editing a suppressed step is not refused', () => {
    const suppressed = execute(doc, 'set_step_suppressed', {
      stepId: boxStepId,
      suppressed: true,
    }).document;
    const result = execute(suppressed, 'edit_step_params', {
      stepId: boxStepId,
      params: { size: [0, 0, 0] },
    });
    expect(result.summary).toContain('params updated');
  });

  it('insert_step with invalid params is refused', () => {
    const result = execute(doc, 'insert_step', { name: 'add_box', params: { size: [0, 0, 0] } });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('changed nothing');
  });

  it('insert_step with valid params still inserts', () => {
    const result = execute(doc, 'insert_step', { name: 'add_box', params: { size: [2, 2, 2] } });
    expect(result.document.featureHistory).toHaveLength(3);
    expect(Object.keys(result.document.entities)).toHaveLength(3);
  });

  it('insert_step with an unresolved =expr param is stored (the parameter may be defined later)', () => {
    const result = execute(doc, 'insert_step', {
      name: 'add_box',
      params: { size: ['=later', 1, 1] },
    });
    expect(result.document.featureHistory).toHaveLength(3);
  });

  it('insert_step with an unknown command name is still stored and skipped', () => {
    const result = execute(doc, 'insert_step', { name: 'no_such_command', params: {} });
    expect(result.document.featureHistory).toHaveLength(3);
  });
});
