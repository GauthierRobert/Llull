/**
 * Component tests for the `kind:'subdivision'` 3D viewport render branch. WebGL does not run in
 * jsdom, so we check the observable path: `add_subdivision_solid` through the store yields a
 * subdivision entity, and the geometry SubdivisionMesh builds from the shared core surface is
 * non-empty with normals.
 *
 * @layer tests/component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import type { SubdivisionEntity } from '@core/model/types';
import { subdivisionTriangles } from '@core/geometry/subdivision';
import { buildMeshSolidGeometry } from '@ui/viewport/3d/entities/meshSolidGeometry';
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
    const positions = subdivisionTriangles(entity as SubdivisionEntity).flat(2);
    expect(positions.length).toBe(14 * 16 * 2 * 9);
    const geometry = buildMeshSolidGeometry({
      positions,
      indices: Array.from({ length: positions.length / 3 }, (_, corner) => corner),
    });
    expect(geometry.getAttribute('position').count).toBe(positions.length / 3);
    expect(geometry.getAttribute('normal')).toBeDefined();
    geometry.dispose();
  });
});
