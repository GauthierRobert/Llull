/**
 * Component tests for the `kind:'loft'` 3D viewport render branch. WebGL does not run in jsdom,
 * so we check the observable path: `loft_sections` through the store yields a loft entity, and the
 * geometry LoftMesh builds from the shared core tessellation is non-empty with normals.
 *
 * @layer tests/component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import type { LoftEntity } from '@core/model/types';
import { loftTriangles } from '@core/geometry/loft';
import { buildTriangleSoupGeometry } from '@ui/viewport/3d/entities/meshSolidGeometry';
import { dispatchEntity, resetStore } from '../helpers/componentEntities';

describe('LoftMesh — loft_sections command → kind "loft"', () => {
  beforeEach(resetStore);

  it('dispatches a round-to-oval loft into the document and builds its geometry', () => {
    const { entity, id } = dispatchEntity('loft_sections', {
      sections: [
        { center: [0, 0, 0], radius: 2 },
        { center: [0, 0, 6], radiusX: 3, radiusY: 1 },
      ],
    });
    expect(entity.kind).toBe('loft');
    expect(useStore.getState().document.order).toContain(id);
    const triangles = loftTriangles(entity as LoftEntity);
    const geometry = buildTriangleSoupGeometry(triangles);
    if (geometry === null) throw new Error('empty geometry');
    expect(geometry.getAttribute('position').count).toBe(triangles.length * 3);
    expect(geometry.getAttribute('normal')).toBeDefined();
    geometry.dispose();
  });
});
