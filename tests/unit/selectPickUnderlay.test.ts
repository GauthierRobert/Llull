import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { entityDistSq, pickEntityId, underlayFrame } from '@ui/viewport/2d/modifyHelpers';
import { entitiesInBox } from '@ui/viewport/2d/boxSelect';
import { underlayPlaneGeometry } from '@ui/viewport/2d/entities/underlayPlane';
import { pngDataUrl } from '../helpers/imageFixtures';

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
