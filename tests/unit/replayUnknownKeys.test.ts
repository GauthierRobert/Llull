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
});
