import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { MAX_BATCH_IDS } from '@core/commands/limits';

function scene(): { doc: CadDocument; boxId: string; sphereId: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [1, 2, 3], position: [1, 0, 0] });
  const sphere = execute(box.document, 'add_sphere', { radius: 2, position: [10, 0, 0] });
  return { doc: sphere.document, boxId: box.affected[0]!, sphereId: sphere.affected[0]! };
}

describe('duplicate_entities', () => {
  const { doc, boxId, sphereId } = scene();

  it('copies every listed entity in one step, in input order, at the offset', () => {
    const result = execute(doc, 'duplicate_entities', {
      ids: [sphereId, boxId],
      offset: [0, 5, 0],
    });
    expect(result.affected).toHaveLength(2);
    const [sphereCopy, boxCopy] = result.affected.map((id) => result.document.entities[id]!);
    expect(sphereCopy!.kind).toBe('sphere');
    expect(boxCopy!.kind).toBe('box');
    expect(sphereCopy!.position).toEqual([10, 5, 0]);
    expect(boxCopy!.position).toEqual([1, 5, 0]);
    expect(result.document.order.slice(-2)).toEqual(result.affected);
    // originals untouched, exactly one feature step appended for the whole batch
    expect(result.document.entities[boxId]).toEqual(doc.entities[boxId]);
    expect(result.document.featureHistory).toHaveLength(doc.featureHistory.length + 1);
  });

  it('defaults to an exact overlap and de-duplicates repeated ids', () => {
    const result = execute(doc, 'duplicate_entities', { ids: [boxId, boxId] });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]!.position).toEqual([1, 0, 0]);
  });

  it('skips missing ids and says so', () => {
    const result = execute(doc, 'duplicate_entities', { ids: [boxId, 'ghost'] });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('Skipped missing: [ghost]');
  });

  it('is replayable: replay_history reproduces the copies', () => {
    const result = execute(doc, 'duplicate_entities', { ids: [boxId, sphereId] });
    const replayed = execute(result.document, 'replay_history', {});
    expect(Object.keys(replayed.document.entities).sort()).toEqual(
      Object.keys(result.document.entities).sort(),
    );
  });

  it.each([
    ['an empty list', [] as string[]],
    ['only missing ids', ['ghost']],
    ['too many ids', Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `id-${i}`)],
  ])('is a no-op for %s', (_label, ids) => {
    const result = execute(doc, 'duplicate_entities', { ids });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});
