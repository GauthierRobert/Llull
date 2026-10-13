/**
 * Component tests for the `kind:'subdivision'` 3D viewport render branch. WebGL does not run in
 * jsdom, so we check the observable path: `add_subdivision_solid` through the store yields a
 * subdivision entity, and the geometry SubdivisionMesh builds from the shared core surface is
 * non-empty with normals.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import type { SubdivisionEntity } from '@core/model/types';
import { subdivisionTriangles } from '@core/geometry/subdivision';
import { buildTriangleSoupGeometry } from '@ui/viewport/3d/entities/meshSolidGeometry';
import { dispatchEntity, resetStore } from '../helpers/componentEntities';

describe('SubdivisionMesh — add_subdivision_solid command → kind "subdivision"', () => {
  beforeEach(resetStore);

  it('dispatches a box-cage solid into the document and builds its geometry', () => {
    const { entity, id } = dispatchEntity('add_subdivision_solid', {
      box: { size: [6, 3, 2], segments: [3, 1, 1] },
      levels: 2,
    });
    expect(entity.kind).toBe('subdivision');
    expect(useStore.getState().document.order).toContain(id);
    const triangles = subdivisionTriangles(entity as SubdivisionEntity);
    expect(triangles.length * 9).toBe(14 * 16 * 2 * 9);
    const geometry = buildTriangleSoupGeometry(triangles);
    if (geometry === null) throw new Error('empty geometry');
    expect(geometry.getAttribute('position').count).toBe(triangles.length * 3);
    expect(geometry.getAttribute('normal')).toBeDefined();
    geometry.dispose();
  });
});
