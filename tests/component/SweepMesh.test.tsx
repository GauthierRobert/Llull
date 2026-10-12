/**
 * Component tests for the `kind:'sweep'` 3D viewport render branch. WebGL does not run in jsdom,
 * so we check the observable path: `sweep_profile` through the store yields a sweep entity, and
 * the geometry SweepMesh builds from the shared core tessellation is non-empty with normals.
 *
 * @layer tests/component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import type { SweepEntity } from '@core/model/types';
import { sweepTriangles } from '@core/geometry/sweep';
import { buildMeshSolidGeometry } from '@ui/viewport/3d/entities/meshSolidGeometry';
import { dispatchEntity, resetStore } from '../helpers/componentEntities';

describe('SweepMesh — sweep_profile command → kind "sweep"', () => {
  beforeEach(resetStore);

  it('dispatches a hollow bent pipe into the document', () => {
    const { entity, id } = dispatchEntity('sweep_profile', {
      path: [
        [0, 0, 0],
        [6, 0, 0],
        [6, 6, 2],
      ],
      radius: 0.5,
      innerRadius: 0.4,
    });
    expect(entity.kind).toBe('sweep');
    expect(useStore.getState().document.order).toContain(id);
  });

  it('the render geometry has a vertex per triangle corner and creased normals', () => {
    const pipe = dispatchEntity('sweep_profile', {
      path: [
        [0, 0, 0],
        [0, 0, 5],
      ],
      radius: 1,
    }).entity as SweepEntity;
    const positions = sweepTriangles(pipe).flat(2);
    const geometry = buildMeshSolidGeometry({
      positions,
      indices: Array.from({ length: positions.length / 3 }, (_, corner) => corner),
    });
    expect(geometry.getAttribute('position').count).toBe(positions.length / 3);
    expect(geometry.getAttribute('normal')).toBeDefined();
    geometry.dispose();
  });
});
