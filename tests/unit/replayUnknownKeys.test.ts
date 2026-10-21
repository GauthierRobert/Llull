import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('replay tolerates unknown keys recorded before they were rejected', () => {
  it('a recorded step with an extra key still regenerates, while a fresh call with it is rejected', () => {
    const built = execute(createEmptyDocument(), 'add_box', { size: [2, 3, 4] }).document;
    const [step] = built.featureHistory;
    expect(step).toBeDefined();
    const saved = { ...built, featureHistory: [{ ...step!, params: { ...(step!.params as object), colour: 'red' } }] };
    expect(execute(saved, 'add_box', { size: [1, 1, 1], colour: 'red' }).rejected).toBe(true);
    const replayed = execute({ ...saved, entities: {}, order: [] }, 'replay_history', {});
    expect(replayed.rejected).not.toBe(true);
    expect(Object.keys(replayed.document.entities)).toEqual(Object.keys(built.entities));
  });

  it('build_project tolerates plan-file metadata keys, but each step stays strict', () => {
    const meta = { id: 'p1', status: 'RUNNABLE', expected: 'one box', notes: ['x'] };
    const ok = execute(createEmptyDocument(), 'build_project', { ...meta, actions: [{ command: 'add_box', params: { size: [1, 1, 1] } }] });
    expect(ok.rejected).not.toBe(true);
    expect(ok.affected).toHaveLength(1);
    const typo = execute(createEmptyDocument(), 'build_project', {
      ...meta,
      actions: [{ command: 'add_box', params: { size: [1, 1, 1], positon: [1, 0, 0] } }],
    });
    expect(typo.document.order).toHaveLength(0);
    expect(typo.summary).toContain("unknown param 'positon'");
  });
});
