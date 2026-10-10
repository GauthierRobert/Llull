import { describe, it, expect } from 'vitest';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  entityDistSq,
  enclosingArea,
  nearestEntityId,
  pickEntityId,
} from '@ui/viewport/2d/modifyHelpers';

function run(doc: CadDocument, name: string, params: unknown): [CadDocument, string] {
  const result = execute(doc, name, params);
  return [result.document, result.affected[0]!];
}

describe('2D picking', () => {
  it('measures distance to points, arcs, ellipses and splines', () => {
    let doc = createEmptyDocument();
    let id: string;
    [doc, id] = run(doc, 'draw_point', { position: [2, 3, 0] });
    expect(entityDistSq(doc.entities[id]!, [2, 4])).toBeCloseTo(1);
    [doc, id] = run(doc, 'draw_arc', { center: [0, 0], radius: 2, startAngle: 0, endAngle: 1 });
    expect(entityDistSq(doc.entities[id]!, [3, 0])).toBeCloseTo(1);
    [doc, id] = run(doc, 'draw_ellipse', { center: [0, 0], radiusX: 4, radiusY: 2 });
    expect(entityDistSq(doc.entities[id]!, [4, 0])).toBeCloseTo(0, 3);
    [doc, id] = run(doc, 'draw_spline', {
      points: [
        [0, 0],
        [2, 0],
        [4, 0],
      ],
    });
    expect(entityDistSq(doc.entities[id]!, [1, 1])).toBeLessThan(1.5);
  });

  it('enclosingArea reports area for closed shapes containing the point', () => {
    let doc = createEmptyDocument();
    const ids: string[] = [];
    let id: string;
    [doc, id] = run(doc, 'draw_rectangle', { width: 4, height: 2, position: [0, 0, 0] });
    ids.push(id);
    [doc, id] = run(doc, 'draw_circle', { center: [10, 0], radius: 1 });
    ids.push(id);
    [doc, id] = run(doc, 'draw_ellipse', { center: [20, 0], radiusX: 2, radiusY: 1 });
    ids.push(id);
    [doc, id] = run(doc, 'draw_polyline', {
      points: [
        [30, 0],
        [32, 0],
        [32, 2],
        [30, 2],
      ],
      closed: true,
    });
    ids.push(id);
    const [rect, circle, ellipse, poly] = ids.map((i) => doc.entities[i] as Entity);
    expect(enclosingArea(rect!, [1, 1])).toBeCloseTo(8);
    expect(enclosingArea(rect!, [5, 1])).toBeNull();
    expect(enclosingArea(circle!, [10, 0.5])).toBeCloseTo(Math.PI);
    expect(enclosingArea(circle!, [12, 0])).toBeNull();
    expect(enclosingArea(ellipse!, [20.5, 0.2])).toBeCloseTo(2 * Math.PI);
    expect(enclosingArea(ellipse!, [22.5, 0])).toBeNull();
    expect(enclosingArea(poly!, [31, 1])).toBeCloseTo(4);
    expect(enclosingArea(poly!, [33, 1])).toBeNull();
  });

  it('open polylines and other kinds never enclose', () => {
    let doc = createEmptyDocument();
    let id: string;
    [doc, id] = run(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [2, 0],
        [2, 2],
      ],
    });
    expect(enclosingArea(doc.entities[id]!, [1.5, 0.5])).toBeNull();
    [doc, id] = run(doc, 'draw_line', { start: [0, 0], end: [1, 1] });
    expect(enclosingArea(doc.entities[id]!, [0.5, 0.5])).toBeNull();
  });

  it('pickEntityId prefers an outline, then the smallest enclosing shape, else null', () => {
    const [withRect, outer] = run(createEmptyDocument(), 'draw_rectangle', {
      width: 10,
      height: 10,
      position: [0, 0, 0],
    });
    const [withCircle, inner] = run(withRect, 'draw_circle', { center: [5, 5], radius: 1 });
    const [doc, line] = run(withCircle, 'draw_line', { start: [2, 0], end: [2, 10] });
    expect(pickEntityId(doc, [2.05, 8], 0.1)).toBe(line);
    expect(pickEntityId(doc, [5, 5], 0.1)).toBe(inner);
    expect(pickEntityId(doc, [8, 8], 0.1)).toBe(outer);
    expect(pickEntityId(doc, [20, 20], 0.1)).toBeNull();
    expect(nearestEntityId(doc, [20, 20], 0.1)).toBeNull();
  });

  it('skips entities rejected by the pickability predicate', () => {
    const [doc, id] = run(createEmptyDocument(), 'draw_rectangle', {
      width: 4,
      height: 4,
      position: [0, 0, 0],
    });
    expect(pickEntityId(doc, [2, 2], 0.1)).toBe(id);
    expect(pickEntityId(doc, [2, 2], 0.1, () => false)).toBeNull();
    expect(nearestEntityId(doc, [0, 2], 0.1, () => false)).toBeNull();
  });
});
