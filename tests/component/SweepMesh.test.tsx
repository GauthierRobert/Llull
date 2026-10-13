import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import type { SweepEntity } from '@core/model/types';
import { sweepTriangles } from '@core/geometry/sweep';
import { buildTriangleSoupGeometry } from '@ui/viewport/3d/entities/meshSolidGeometry';
import { dispatchEntity, resetStore } from '../helpers/componentEntities';
import { xyz } from '../helpers/xy';

describe('SweepMesh — sweep_profile command → kind "sweep"', () => {
  beforeEach(resetStore);
  it('dispatches a hollow bent pipe into the document', () => {
    const { entity, id } = dispatchEntity('sweep_profile', { path: xyz(0, 0, 0, 6, 0, 0, 6, 6, 2), radius: 0.5, innerRadius: 0.4 });
    expect(entity.kind).toBe('sweep');
    expect(useStore.getState().document.order).toContain(id);
  });
  it('the render geometry has a vertex per triangle corner and creased normals', () => {
    const pipe = dispatchEntity('sweep_profile', { path: xyz(0, 0, 0, 0, 0, 5), radius: 1 }).entity as SweepEntity;
    const triangles = sweepTriangles(pipe);
    const geometry = buildTriangleSoupGeometry(triangles);
    if (geometry === null) throw new Error('empty geometry');
    expect(geometry.getAttribute('position').count).toBe(triangles.length * 3);
    expect(geometry.getAttribute('normal')).toBeDefined();
    geometry.dispose();
  });
});
