import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { boxSelectMode, entitiesInBox } from '../../src/ui/viewport/2d/boxSelect';

function build(steps: Array<[string, unknown]>): { doc: CadDocument; ids: string[] } {
  let doc = createEmptyDocument();
  const ids: string[] = [];
  for (const [name, params] of steps) {
    const result = execute(doc, name, params);
    doc = result.document;
    ids.push(result.affected[0] ?? '');
  }
  return { doc, ids };
}

describe('boxSelectMode', () => {
  it('is window for a left-to-right drag and crossing for right-to-left', () => {
    expect(boxSelectMode([0, 0], [5, 5])).toBe('window');
    expect(boxSelectMode([5, 0], [0, 5])).toBe('crossing');
  });
});

describe('entitiesInBox — one entity per Shape2DKind', () => {
  const { doc, ids } = build([
    ['draw_line', { start: [1, 1], end: [3, 1] }],
    [
      'draw_polyline',
      {
        points: [
          [1, 2],
          [3, 2],
          [3, 3],
        ],
        closed: false,
      },
    ],
    ['draw_circle', { center: [2, 6], radius: 1 }],
    ['draw_rectangle', { width: 2, height: 1, position: [1, 8, 0] }],
    ['draw_ellipse', { center: [2, 11], radiusX: 1, radiusY: 0.5 }],
    ['draw_arc', { center: [2, 14], radius: 1, startAngle: 0, endAngle: Math.PI / 2 }],
    [
      'draw_spline',
      {
        points: [
          [1, 16],
          [2, 17],
          [3, 16],
        ],
      },
    ],
    ['draw_point', { position: [2, 19, 0] }],
    ['add_text', { content: 'AB', position: [1, 21, 0], height: 1 }],
  ]);
  const [line, polyline, circle, rectangle, ellipse, arc, spline, point, text] = ids as string[];
  const all = ids;

  it('window selects only entities fully inside, in document order', () => {
    expect(entitiesInBox(doc, [0, 0], [10, 25])).toEqual(all);
    expect(entitiesInBox(doc, [0, 0], [4, 4])).toEqual([line, polyline]);
  });

  it('window does not select an entity that merely pokes into the box', () => {
    // Box covers the lower half of the circle only.
    expect(entitiesInBox(doc, [0, 4], [4, 6])).not.toContain(circle);
    expect(entitiesInBox(doc, [0, 4], [4, 8])).toContain(circle);
  });

  it('crossing selects entities touched by the box (right-to-left drag)', () => {
    // A thin box crossing the circle, rectangle edge, ellipse, arc, spline and text.
    expect(entitiesInBox(doc, [3.1, 6.1], [2.9, 5.9])).toContain(circle);
    expect(entitiesInBox(doc, [3.1, 8.6], [2.9, 8.4])).toContain(rectangle);
    expect(entitiesInBox(doc, [3.1, 11.1], [2.9, 10.9])).toContain(ellipse);
    expect(entitiesInBox(doc, [3.1, 14.1], [2.9, 13.9])).toContain(arc);
    expect(entitiesInBox(doc, [2.1, 17.1], [1.9, 16.9])).toContain(spline);
    expect(entitiesInBox(doc, [2.1, 19.1], [1.9, 18.9])).toContain(point);
    expect(entitiesInBox(doc, [1.5, 21.1], [1.4, 20.9])).toContain(text);
  });

  it('crossing ignores entities the box does not touch, even if the box is inside a closed shape', () => {
    expect(entitiesInBox(doc, [2.1, 6.1], [1.9, 5.9])).not.toContain(circle);
    expect(entitiesInBox(doc, [30, 30], [29, 29])).toEqual([]);
  });

  it('respects the selectable filter (hidden entities)', () => {
    const hidden = (entity: Entity): boolean => entity.id !== line;
    expect(entitiesInBox(doc, [0, 0], [4, 4], hidden)).toEqual([polyline]);
  });
});

describe('entitiesInBox — dimension labels', () => {
  it('selects a dimension by its label box and skips dangling dimensions', () => {
    const { doc, ids } = build([
      ['draw_point', { position: [0, 0, 0] }],
      ['draw_point', { position: [10, 0, 0] }],
    ]);
    const dim = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [ids[0], ids[1]],
    });
    const dimensionId = dim.affected[0] as string;
    // Linear label sits at mid-span, 5 units off the measured points.
    expect(entitiesInBox(dim.document, [4, 4], [6, 6])).toEqual([dimensionId]);
    expect(entitiesInBox(dim.document, [0, 0], [1, 1])).not.toContain(dimensionId);
    const { [ids[0] as string]: _gone, ...rest } = dim.document.entities;
    void _gone;
    expect(entitiesInBox({ ...dim.document, entities: rest }, [4, 4], [6, 6])).toEqual([]);
  });
});
