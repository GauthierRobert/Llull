import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type TextEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { textLocalBounds } from '@core/geometry/bounds';
import { entityDistSq, textLocalBox } from '../../src/ui/viewport/2d/modifyHelpers';
import { entitiesInBox } from '../../src/ui/viewport/2d/boxSelect';

function textBox(content: string, anchor?: string): { min: number[]; max: number[]; size: number[] } {
  const created = execute(createEmptyDocument(), 'add_text', { content, position: [10, 20, 0], height: 2, ...(anchor ? { anchor } : {}) });
  return execute(created.document, 'measure_bounding_box', { entityId: created.affected[0]! }).data as {
    min: number[];
    max: number[];
    size: number[];
  };
}

describe('text bounds follow the rendered layout', () => {
  // 5 glyphs * 0.6 * height 2 = 6 wide; one line is centred vertically on the position.
  it('left anchor extends to the right of the position', () => {
    const box = textBox('Hello', 'left');
    expect(box.min[0]).toBeCloseTo(10);
    expect(box.max[0]).toBeCloseTo(16);
    expect(box.min[1]).toBeCloseTo(19);
    expect(box.max[1]).toBeCloseTo(21);
  });
  it('defaults to a left anchor', () => {
    expect(textBox('Hello').min[0]).toBeCloseTo(10);
  });
  it('center anchor straddles the position', () => {
    const box = textBox('Hello', 'center');
    expect(box.min[0]).toBeCloseTo(7);
    expect(box.max[0]).toBeCloseTo(13);
  });
  it('right anchor extends to the left of the position', () => {
    const box = textBox('Hello', 'right');
    expect(box.min[0]).toBeCloseTo(4);
    expect(box.max[0]).toBeCloseTo(10);
  });
  it('multi-line text uses the longest line and stacks lines at 1.2 em, centred vertically', () => {
    const box = textBox('ab\nabcdef\nabc', 'left');
    expect(box.size[0]).toBeCloseTo(6 * 0.6 * 2);
    // height 2 + two extra lines * (1.2 * 2) = 6.8
    expect(box.size[1]).toBeCloseTo(6.8);
    expect((box.min[1]! + box.max[1]!) / 2).toBeCloseTo(20);
  });
  it('whole-document bounds include the anchored text extent', () => {
    const created = execute(createEmptyDocument(), 'add_text', { content: 'Hello', position: [0, 0, 0], height: 2, anchor: 'right' });
    const box = execute(created.document, 'measure_bounding_box', {}).data as { min: number[] };
    expect(box.min[0]).toBeCloseTo(-6);
  });
});

function text(content: string, anchor: 'left' | 'center' | 'right'): TextEntity {
  const result = execute(createEmptyDocument(), 'add_text', { content, position: [0, 0, 0], height: 2, anchor });
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
      expect(textLocalBox(entity)).toEqual({ left: min[0], width: max[0] - min[0], height: max[1] - min[1] });
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
