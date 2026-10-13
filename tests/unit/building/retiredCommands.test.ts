import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { xy } from '../../helpers/xy';

describe('retired building commands', () => {
  it('add_wall steps in a saved document load as draw_walls and replay to the same wall', () => {
    const modern = execute(createEmptyDocument(), 'draw_walls', { points: xy(0, 0, 5000, 0), thickness: 150 }).document;
    const legacyStep = { ...modern.featureHistory[0]!, name: 'add_wall', params: { start: [0, 0], end: [5000, 0], thickness: 150 } };
    const loaded = deserializeDocument(serializeDocument({ ...modern, featureHistory: [legacyStep] }));
    expect(loaded.featureHistory[0]).toMatchObject({ name: 'draw_walls', params: { points: xy(0, 0, 5000, 0), thickness: 150 } });
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(replayed.building?.elements['wall-1']).toEqual(modern.building?.elements['wall-1']);
    expect(Object.keys(replayed.entities)).toEqual(Object.keys(modern.entities));
  });
});
