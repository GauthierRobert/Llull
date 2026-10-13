import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity, type DimensionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  entityDistSq,
  enclosingArea,
  nearestEntityId,
  pickEntityId,
  dimensionLabelDistSq,
  underlayFrame,
} from '@ui/viewport/2d/modifyHelpers';
import { xy } from '../helpers/xy';
import { entitiesInBox } from '@ui/viewport/2d/boxSelect';
import { underlayPlaneGeometry } from '@ui/viewport/2d/entities/underlayPlane';
import { pngDataUrl } from '../helpers/imageFixtures';

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
    [doc, id] = run(doc, 'draw_spline', { points: xy(0, 0, 2, 0, 4, 0) });
    expect(entityDistSq(doc.entities[id]!, [1, 1])).toBeLessThan(1.5);
  });
  it('enclosingArea reports area for closed shapes containing the point', () => {
    let doc = createEmptyDocument();
    const ids: string[] = [];
    let id: string;
    [doc, id] = run(doc, 'draw_rectangle', { width: 4, height: 2, position: [0, 0, 0] });
    ids.push(id);
    [doc, id] = run(doc, 'draw_arc', { center: [10, 0], radius: 1 });
    ids.push(id);
    [doc, id] = run(doc, 'draw_ellipse', { center: [20, 0], radiusX: 2, radiusY: 1 });
    ids.push(id);
    [doc, id] = run(doc, 'draw_polyline', { points: xy(30, 0, 32, 0, 32, 2, 30, 2), closed: true });
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
    [doc, id] = run(doc, 'draw_polyline', { points: xy(0, 0, 2, 0, 2, 2) });
    expect(enclosingArea(doc.entities[id]!, [1.5, 0.5])).toBeNull();
    [doc, id] = run(doc, 'draw_polyline', { points: xy(0, 0, 1, 1) });
    expect(enclosingArea(doc.entities[id]!, [0.5, 0.5])).toBeNull();
  });
  it('pickEntityId prefers an outline, then the smallest enclosing shape, else null', () => {
    const [withRect, outer] = run(createEmptyDocument(), 'draw_rectangle', { width: 10, height: 10, position: [0, 0, 0] });
    const [withCircle, inner] = run(withRect, 'draw_arc', { center: [5, 5], radius: 1 });
    const [doc, line] = run(withCircle, 'draw_polyline', { points: xy(2, 0, 2, 10) });
    expect(pickEntityId(doc, [2.05, 8], 0.1)).toBe(line);
    expect(pickEntityId(doc, [5, 5], 0.1)).toBe(inner);
    expect(pickEntityId(doc, [8, 8], 0.1)).toBe(outer);
    expect(pickEntityId(doc, [20, 20], 0.1)).toBeNull();
    expect(nearestEntityId(doc, [20, 20], 0.1)).toBeNull();
  });
  it('skips entities rejected by the pickability predicate', () => {
    const [doc, id] = run(createEmptyDocument(), 'draw_rectangle', { width: 4, height: 4, position: [0, 0, 0] });
    expect(pickEntityId(doc, [2, 2], 0.1)).toBe(id);
    expect(pickEntityId(doc, [2, 2], 0.1, () => false)).toBeNull();
    expect(nearestEntityId(doc, [0, 2], 0.1, () => false)).toBeNull();
  });
});

describe('2D picking — arcs', () => {
  const drawn = execute(createEmptyDocument(), 'draw_arc', { center: [0, 0], radius: 2, startAngle: 0, endAngle: Math.PI / 2 });
  const doc = drawn.document;
  const id = drawn.affected[0]!;
  it('picks only along the swept range, not the rest of the full circle', () => {
    const arc = doc.entities[id]!;
    // On the swept quadrant.
    expect(entityDistSq(arc, [Math.SQRT2, Math.SQRT2])).toBeCloseTo(0);
    // On the circle but opposite the sweep: nearest arc point is an endpoint, 2*sqrt(2) away.
    expect(entityDistSq(arc, [-Math.SQRT2, -Math.SQRT2])).toBeGreaterThan(4);
    expect(nearestEntityId(doc, [-2, 0], 0.5)).toBeNull();
    expect(nearestEntityId(doc, [0, 2], 0.5)).toBe(id);
  });
});

describe('2D picking — dimensions', () => {
  const base = createEmptyDocument();
  const a = execute(base, 'draw_point', { position: [0, 0, 0] });
  const b = execute(a.document, 'draw_point', { position: [10, 0, 0] });
  const dim = execute(b.document, 'add_dimension', { dimensionKind: 'linear', entityIds: [a.affected[0], b.affected[0]] });
  const doc = dim.document;
  const dimensionId = dim.affected[0]!;
  const dimension = doc.entities[dimensionId] as DimensionEntity;
  it('is pickable at its label, not elsewhere', () => {
    // Linear dimension label sits at mid-span, offset from the measured points.
    expect(dimensionLabelDistSq(doc, dimension, [5, 5])).toBeCloseTo(0);
    expect(nearestEntityId(doc, [5, 5], 0.2)).toBe(dimensionId);
    expect(nearestEntityId(doc, [5, 50], 0.2)).toBeNull();
  });
  it('is not pickable when its references dangle', () => {
    const { [a.affected[0]!]: _removed, ...entities } = doc.entities;
    void _removed;
    expect(dimensionLabelDistSq({ ...doc, entities }, dimension, [5, 5])).toBe(Infinity);
  });
});

function textDoc(anchor: 'left' | 'center' | 'right'): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'add_text', { content: 'ABCDE', position: [10, 5, 0], height: 2, anchor });
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

/** 100×50 underlay at [10, 0, 0], rotated +90° in plane when `turned`. */
function underlayDoc(locked: boolean, turned = false): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'add_image_underlay', {
    dataUrl: pngDataUrl(100, 50),
    position: [10, 0, 0],
    rotation: [0, 0, turned ? Math.PI / 2 : 0],
    locked,
  });
  return { doc: result.document, id: result.affected[0]! };
}

describe('2D picking — image underlay', () => {
  it('picks an unlocked underlay on its frame only (tracing inside it never selects it)', () => {
    const { doc, id } = underlayDoc(false);
    const image = doc.entities[id]!;
    expect(entityDistSq(image, [60, 0])).toBeCloseTo(0);
    expect(entityDistSq(image, [60, 25])).toBeCloseTo(625);
    expect(pickEntityId(doc, [110, 20], 1)).toBe(id);
    expect(pickEntityId(doc, [60, 25], 1)).toBeNull();
  });
  it('follows the in-plane rotation', () => {
    const { doc, id } = underlayDoc(false, true);
    // Rotated +90° about [10, 0]: the bottom edge now runs from [10, 0] to [10, 100].
    expect(entityDistSq(doc.entities[id]!, [10, 70])).toBeCloseTo(0);
    const image = doc.entities[id];
    if (image?.kind !== 'image') throw new Error('expected an image');
    expect(underlayFrame(image)?.[1]?.map(Math.round)).toEqual([-40, 100]);
  });
  it('never picks or box-selects a locked underlay', () => {
    const { doc, id } = underlayDoc(true);
    expect(entityDistSq(doc.entities[id]!, [60, 0])).toBe(Infinity);
    expect(pickEntityId(doc, [60, 0], 5)).toBeNull();
    expect(entitiesInBox(doc, [0, -10], [200, 100])).toEqual([]);
  });
  it('box-selects an unlocked underlay (window: fully inside; crossing: touching)', () => {
    const { doc, id } = underlayDoc(false);
    expect(entitiesInBox(doc, [0, -10], [200, 100])).toEqual([id]);
    expect(entitiesInBox(doc, [50, -10], [0, 10])).toEqual([id]);
    expect(entitiesInBox(doc, [0, -10], [50, 10])).toEqual([]);
  });
});

describe('underlayPlaneGeometry', () => {
  it('covers [0, width] × [0, height] with the picture upright (v = 1 at the top)', () => {
    const geometry = underlayPlaneGeometry(100, 50);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.min.toArray()).toEqual([0, 0, 0]);
    expect(geometry.boundingBox?.max.toArray()).toEqual([100, 50, 0]);
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < position.count; i++) {
      expect(uv.getY(i)).toBe(position.getY(i) === 50 ? 1 : 0);
    }
    geometry.dispose();
  });
});
