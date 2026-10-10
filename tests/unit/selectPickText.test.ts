import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { entityDistSq, nearestEntityId } from '@ui/viewport/2d/modifyHelpers';

function textDoc(anchor: 'left' | 'center' | 'right'): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'add_text', {
    content: 'ABCDE',
    position: [10, 5, 0],
    height: 2,
    anchor,
  });
  return { doc: result.document, id: result.affected[0]! };
}

describe('2D picking — text', () => {
  it('hits inside the estimated text box (left anchor extends right of the position)', () => {
    const { doc, id } = textDoc('left');
    const text = doc.entities[id]!;
    expect(entityDistSq(text, [11, 5])).toBe(0);
    expect(entityDistSq(text, [9, 5])).toBeCloseTo(1);
    expect(nearestEntityId(doc, [14, 5.5], 0.1)).toBe(id);
    expect(nearestEntityId(doc, [30, 5], 0.5)).toBeNull();
  });

  it('honours center and right anchors', () => {
    const centered = textDoc('center');
    expect(entityDistSq(centered.doc.entities[centered.id]!, [8, 5])).toBe(0);
    const right = textDoc('right');
    expect(entityDistSq(right.doc.entities[right.id]!, [5, 5])).toBe(0);
    expect(entityDistSq(right.doc.entities[right.id]!, [11, 5])).toBeCloseTo(1);
  });
});
