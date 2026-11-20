/** The analysis reference guard skips a step re-run by replay (L8): a history recorded before the guard (part added, then deleted) still replays. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

describe('analysis reference guard and replay', () => {
  it('refuses the delete outside replay; a pre-guard history (delete recorded) replays to the saved model', () => {
    const added = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const box = added.affected[0] ?? '';
    const created = execute(added.document, 'create_analysis', { name: 'a', analysisType: 'static' });
    const withPart = execute(created.document, 'set_part_idealization', { analysisId: created.affected[0] ?? '', entityId: box });
    expect(withPart.error).toBeUndefined();
    const refused = execute(withPart.document, 'delete_entities', { ids: [box] });
    expect(refused.summary).toContain('is used by analysis');
    expect(refused.document).toBe(withPart.document);
    const preGuard = execute(withPart.document, 'delete_entities', { ids: [box] }, { ...defaultContext(), replaying: true });
    expect(preGuard.error).toBeUndefined();
    expect(preGuard.document.featureHistory.at(-1)?.name).toBe('delete_entities');
    const replayed = execute(preGuard.document, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(replayed.document.entities[box]).toBeUndefined();
    expect(replayed.document.analysis).toEqual(preGuard.document.analysis);
  });
});
