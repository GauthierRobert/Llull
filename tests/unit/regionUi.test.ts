import { describe, it, expect, vi } from 'vitest';
import { type CadDocument, type RegionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { collectSnapCandidates } from '@ui/viewport/2d/snapping/candidates';
import { entityToSegments } from '@ui/viewport/2d/snapping/geometry';
import { entitiesInBox } from '@ui/viewport/2d/boxSelect';
import { enclosingArea, entityDistSq, pickEntityId } from '@ui/viewport/2d/modifyHelpers';
import { drawToolDescriptor } from '@ui/viewport/2d/drawToolTable';
import { DRAW_TOOLS } from '@ui/components/toolbar/drawTools';

/** Plate 100 x 60 at (10, 20) with a rectangular hole 20 x 20 at local (40, 20), hatched: one region at (10, 20). */
function plate(): { doc: CadDocument; region: RegionEntity } {
  let doc = createEmptyDocument();
  doc = execute(doc, 'draw_rectangle', { width: 100, height: 60, position: [10, 20, 0] }).document;
  doc = execute(doc, 'draw_rectangle', { width: 20, height: 20, position: [50, 40, 0] }).document;
  const result = execute(doc, 'hatch_region', { ids: [...doc.order] });
  return { doc: result.document, region: result.document.entities[result.affected[0] as string] as RegionEntity };
}

describe('region snapping', () => {
  it('snaps loop corners as endpoints and straight edges at their midpoints, in world coordinates', () => {
    const { doc, region } = plate();
    const only = { ...doc, order: [region.id] };
    const points = collectSnapCandidates(only);
    expect(points).toContainEqual({ x: 10, y: 20, type: 'endpoint' });
    expect(points).toContainEqual({ x: 110, y: 80, type: 'endpoint' });
    expect(points).toContainEqual({ x: 50, y: 40, type: 'endpoint' });
    expect(points).toContainEqual({ x: 60, y: 20, type: 'midpoint' });
    expect(points).toContainEqual({ x: 50, y: 50, type: 'midpoint' });
    expect(points.filter((p) => p.type === 'endpoint')).toHaveLength(8);
  });

  it('a curved loop snaps at its exact joints (a circle: two quadrant points), not at every sample', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_arc', { center: [0, 0], radius: 5 }).document;
    const region = execute(doc, 'hatch_region', { ids: [...doc.order] });
    const points = collectSnapCandidates({ ...region.document, order: [region.affected[0] as string] });
    expect(points.filter((p) => p.type === 'endpoint')).toHaveLength(2);
    expect(points).toContainEqual(expect.objectContaining({ type: 'endpoint', x: 5 }));
  });

  it('edges feed intersection / perpendicular snapping: every loop edge is a segment', () => {
    const { region } = plate();
    expect(entityToSegments(region)).toHaveLength(8);
  });
});

describe('region selection and picking', () => {
  it('box select: window needs all loops inside, crossing needs a touch', () => {
    const { doc, region } = plate();
    const only = { ...doc, order: [region.id] };
    expect(entitiesInBox(only, [0, 0], [200, 200])).toEqual([region.id]);
    expect(entitiesInBox(only, [0, 0], [50, 50])).toEqual([]);
    expect(entitiesInBox(only, [200, 200], [0, 0])).toEqual([region.id]);
  });

  it('outline distance covers the hole edge too', () => {
    const { region } = plate();
    expect(entityDistSq(region, [60, 40])).toBe(0);
    expect(entityDistSq(region, [60, 50])).toBe(100);
    expect(entityDistSq(region, [10, 50])).toBe(0);
  });

  it('even-odd pick: on the plate it is hit (area 5600), inside the hole or outside it is not', () => {
    const { region } = plate();
    expect(enclosingArea(region, [20, 30])).toBeCloseTo(6000 - 400, 9);
    expect(enclosingArea(region, [60, 50])).toBeNull();
    expect(enclosingArea(region, [500, 500])).toBeNull();
  });

  it('pickEntityId finds the region by its outline and by its interior', () => {
    const { doc, region } = plate();
    const only = { ...doc, order: [region.id] };
    expect(pickEntityId(only, [10, 50], 1)).toBe(region.id);
    expect(pickEntityId(only, [20, 30], 1)).toBe(region.id);
    expect(pickEntityId(only, [60, 50], 1)).toBeNull();
  });
});

describe('hatch draw tool', () => {
  it('is one click that dispatches hatch_region with the pick point; it is on the toolbar', () => {
    const dispatch = vi.fn();
    const descriptor = drawToolDescriptor('hatch');
    expect(descriptor?.maxPoints).toBe(1);
    descriptor?.commit([[3, 4]], dispatch);
    expect(dispatch).toHaveBeenCalledWith('hatch_region', { point: [3, 4] });
    expect(DRAW_TOOLS.some((spec) => spec.tool === 'hatch')).toBe(true);
    expect(typeof descriptor?.preview === 'function' && descriptor.preview([0, 0], [1, 1])).toBeNull();
    dispatch.mockClear();
    descriptor?.commit([], dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
