import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

/** Regression: the parameter table is input state (L8, written only by metaHistory commands); a recorded clear_document replayed by a later
 *  history edit must not erase parameters (or configurations) defined after it. */
describe('replay keeps the parameter table through a recorded clear_document', () => {
  const start = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
  const cleared = execute(start, 'clear_document', {}).document;
  const withParameter = execute(cleared, 'set_parameter', { name: 'w', expression: '60' }).document;

  it('a step driven by a parameter defined after the clear regenerates', () => {
    const inserted = execute(withParameter, 'insert_step', { name: 'add_box', params: { size: ['=w', 40, 20] } });
    expect(inserted.error).toBeUndefined();
    const boxes = Object.values(inserted.document.entities).filter((entity) => entity.kind === 'box');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.kind === 'box' ? boxes[0].size : null).toEqual([60, 40, 20]);
    expect(inserted.document.parameters['w']?.expression).toBe('60');
  });

  it('configurations survive the replay too', () => {
    const configured = execute(withParameter, 'create_configuration', { name: 'large', parameterValues: { w: '80' } }).document;
    const replayed = execute(configured, 'replay_history', {});
    expect(Object.keys(replayed.document.configurations)).toEqual(['large']);
    expect(replayed.document.parameters['w']?.expression).toBe('60');
  });
});
