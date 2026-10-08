import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { textLocalBounds } from '@core/commands/sceneBounds';
import { entityDistSq, textLocalBox } from '../../src/ui/viewport/2d/modifyHelpers';
import { entitiesInBox } from '../../src/ui/viewport/2d/boxSelect';
import type { TextEntity } from '@core/model/types';

function text(content: string, anchor: 'left' | 'center' | 'right'): TextEntity {
  const result = execute(createEmptyDocument(), 'add_text', {
    content,
    position: [0, 0, 0],
    height: 2,
    anchor,
  });
  return result.document.entities[result.affected[0] as string] as TextEntity;
}

describe('textLocalBox', () => {
  it('sizes a single line by its length and places it by the anchor', () => {
    expect(textLocalBox(text('ABCDE', 'left'))).toEqual({ left: 0, width: 6, height: 2 });
    expect(textLocalBox(text('ABCDE', 'center')).left).toBe(-3);
    expect(textLocalBox(text('ABCDE', 'right')).left).toBe(-6);
  });

  it('uses the longest line and stacks lines for multi-line text', () => {
    const box = textLocalBox(text('AB\nABCDEFGH\nABC', 'left'));
    expect(box.width).toBeCloseTo(8 * 2 * 0.6);
    expect(box.height).toBeCloseTo(2 * (1 + 2 * 1.2));
  });

  it('projects the core textLocalBounds layout (one source of truth)', () => {
    for (const anchor of ['left', 'center', 'right'] as const) {
      const entity = text('AB\nABCDEFGH\nABC', anchor);
      const { min, max } = textLocalBounds(entity);
      expect(min[1]).toBeCloseTo(-max[1]);
      expect(textLocalBox(entity)).toEqual({
        left: min[0],
        width: max[0] - min[0],
        height: max[1] - min[1],
      });
    }
  });

  it('makes the whole multi-line block pickable and box-selectable', () => {
    const entity = text('AB\nABCDEFGH\nABC', 'left');
    // Second-line region (above the first line's single-line height) is inside the block.
    expect(entityDistSq(entity, [4, -3])).toBe(0);
    const doc = { ...createEmptyDocument(), entities: { [entity.id]: entity }, order: [entity.id] };
    expect(entitiesInBox(doc, [-1, -6], [12, 6])).toEqual([entity.id]);
    expect(entitiesInBox(doc, [-1, -1], [12, 1])).toEqual([]);
  });
});
