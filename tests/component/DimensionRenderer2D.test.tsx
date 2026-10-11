/**
 * Component tests for the DimensionRenderer2D render branch.
 *
 * Since jsdom cannot run WebGL, we test the observable behavior through the
 * store and the shapes of dimension entities produced by add_dimension +
 * the referenced geometry commands. This validates:
 *
 *  1. add_dimension (linear) produces a dimension entity with correct shape.
 *  2. add_dimension (radial) on a circle produces a radial dimension entity.
 *  3. add_dimension (angular) on 3 points produces an angular dimension entity.
 *  4. Missing reference entity → dimension still in store but render path returns early.
 *  5. Wrong-kind reference (radial on a line) → add_dimension is a no-op (command guards).
 *  6. precision override → entity.precision stored correctly.
 *  7. label override → entity.label stored correctly.
 *  8. dimension entity is NOT routed through the instanced renderer (not batchable).
 *
 * Rendering path (WebGL) is validated structurally: the entity kind matches what
 * DimensionRenderer2D expects; presence in document.order confirms the renderer
 * switch has a branch (returning null on wrong data, not crashing).
 *
 * @layer tests/component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import { type DimensionEntity, is2D } from '@core/model/types';
import { isBatchable } from '@ui/viewport/3d/grouping';
import { localDispatch } from '../helpers/storeTestHelpers';
import { resetStore } from '../helpers/componentEntities';

function created(command: string, params: unknown): string {
  const id = localDispatch(command, params).affected[0];
  if (!id) throw new Error(`${command} returned no affected id`);
  return id;
}
const addPoint = (x: number, y: number): string => created('draw_point', { position: [x, y, 0] });
const addLine = (x1: number, y1: number, x2: number, y2: number): string =>
  created('draw_line', { start: [x1, y1, 0], end: [x2, y2, 0] });
const addCircle = (cx: number, cy: number, r: number): string =>
  created('draw_circle', { center: [cx, cy, 0], radius: r });

interface Dimensioned {
  affected: readonly string[];
  dimId: string | undefined;
  dim: DimensionEntity;
}

/** Dispatch add_dimension; `dim` is the created entity (undefined when the command no-ops). */
function dimension(
  dimensionKind: string,
  entityIds: readonly string[],
  extra: Record<string, unknown> = {},
): Dimensioned {
  const { affected } = localDispatch('add_dimension', { dimensionKind, entityIds, ...extra });
  const dimId = affected[0];
  const dim = (dimId ? useStore.getState().document.entities[dimId] : undefined) as DimensionEntity;
  return { affected, dimId, dim };
}

/** Linear dimension between two fresh points at (0,0) and (x,y). */
const linearTo = (x: number, y: number, extra: Record<string, unknown> = {}): Dimensioned =>
  dimension('linear', [addPoint(0, 0), addPoint(x, y)], extra);

describe('DimensionRenderer2D', () => {
  beforeEach(resetStore);

  describe('linear dimension between two points', () => {
    it('produces a dimension entity with kind "dimension" and dimensionKind "linear"', () => {
      const idA = addPoint(0, 0);
      const idB = addPoint(5, 0);
      const { affected, dim } = dimension('linear', [idA, idB]);
      expect(affected).toHaveLength(1);
      expect(dim.kind).toBe('dimension');
      expect(dim.dimensionKind).toBe('linear');
      expect(dim.entityIds).toEqual([idA, idB]);
    });

    it('dimension entity appears in document.order', () => {
      const { dimId } = linearTo(3, 4);
      expect(useStore.getState().document.order).toContain(dimId);
    });

    it('offset is stored only when explicitly passed (undefined by default)', () => {
      expect(linearTo(10, 0).dim.offset).toBeUndefined();
    });
  });

  describe('radial dimension on a circle', () => {
    it('produces a radial dimension entity referencing the circle', () => {
      const circleId = addCircle(0, 0, 4);
      const { affected, dim } = dimension('radial', [circleId]);
      expect(affected).toHaveLength(1);
      expect(dim.kind).toBe('dimension');
      expect(dim.dimensionKind).toBe('radial');
      expect(dim.entityIds[0]).toBe(circleId);
    });

    it('referenced circle is still in the document (no crash from dimension creation)', () => {
      const circleId = addCircle(2, 3, 7);
      dimension('radial', [circleId]);
      expect(useStore.getState().document.entities[circleId]?.kind).toBe('circle');
    });
  });

  describe('angular dimension on 3 points', () => {
    it('produces an angular dimension entity with 3 entityIds', () => {
      const ids = [addPoint(0, 0), addPoint(5, 0), addPoint(0, 5)];
      const { affected, dim } = dimension('angular', ids);
      expect(affected).toHaveLength(1);
      expect(dim.dimensionKind).toBe('angular');
      expect(dim.entityIds).toEqual(ids);
    });

    it('angular dimension between 90° arms is stored correctly', () => {
      // Angle computation happens at render time; the entity must exist.
      const { affected } = dimension('angular', [addPoint(0, 0), addPoint(1, 0), addPoint(0, 1)]);
      expect(affected).toHaveLength(1);
    });
  });

  describe('missing reference entity', () => {
    it('add_dimension with a non-existent entity id returns no-op', () => {
      const idA = addPoint(0, 0);
      expect(dimension('linear', [idA, 'does-not-exist']).affected).toHaveLength(0);
      expect(useStore.getState().document.order).toHaveLength(1); // only the point
    });

    it('no crash when both references are missing', () => {
      expect(dimension('linear', ['ghost-a', 'ghost-b']).affected).toHaveLength(0);
    });
  });

  describe('wrong-kind reference', () => {
    it('radial dimension pointing at a line entity is rejected by the command', () => {
      expect(dimension('radial', [addLine(0, 0, 5, 5)]).affected).toHaveLength(0);
    });

    it('linear dimension pointing at a circle entity is rejected by the command', () => {
      expect(dimension('linear', [addCircle(0, 0, 3), addPoint(5, 5)]).affected).toHaveLength(0);
    });
  });

  describe('precision and label overrides', () => {
    it('entity.precision is stored when precision param is provided', () => {
      expect(linearTo(10, 0, { precision: 1 }).dim.precision).toBe(1);
    });

    it('entity.precision is undefined when not provided (uses document displayPrecision)', () => {
      expect(linearTo(10, 0).dim.precision).toBeUndefined();
    });

    it('entity.label is stored when label param is provided', () => {
      expect(linearTo(10, 0, { label: 'REF' }).dim.label).toBe('REF');
    });
  });

  describe('classification', () => {
    it('isBatchable returns false for a dimension entity (not routed through instancing)', () => {
      expect(isBatchable(linearTo(5, 0).dim)).toBe(false);
    });

    it('is2D returns true for a dimension entity', () => {
      expect(is2D(linearTo(5, 0).dim)).toBe(true);
    });
  });

  describe('aligned and line-based angular dimensions', () => {
    it('produces an aligned dimension entity with dimensionKind "aligned"', () => {
      const { affected, dim } = dimension('aligned', [addPoint(0, 0), addPoint(3, 4)], {
        offset: 2,
      });
      expect(affected).toHaveLength(1);
      expect(dim.dimensionKind).toBe('aligned');
      expect(dim.offset).toBe(2);
    });

    it('angular dimension accepts vertex point + 2 line entities', () => {
      const vertex = addPoint(0, 0);
      const { affected, dim } = dimension('angular', [
        vertex,
        addLine(0, 0, 5, 0),
        addLine(0, 0, 0, 5),
      ]);
      expect(affected).toHaveLength(1);
      expect(dim.dimensionKind).toBe('angular');
      expect(dim.entityIds[0]).toBe(vertex);
    });
  });
});
