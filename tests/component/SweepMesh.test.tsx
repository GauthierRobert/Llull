import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import type * as THREE from 'three';
import { useStore } from '@ui/store';
import type { LoftEntity, SweepEntity } from '@core/model/types';
import { loftTriangles } from '@core/geometry/loft';
import { sweepTriangles } from '@core/geometry/sweep';
import { buildTriangleSoupGeometry } from '@ui/viewport/3d/entities/meshSolidGeometry';
import { dispatchEntity, resetStore } from '../helpers/componentEntities';
import { SOLID_MESHES } from '@ui/viewport/3d/entities/solidMeshes';
import { xyz } from '../helpers/xy';

const shell = vi.hoisted(() => ({ geometry: null as THREE.BufferGeometry | null }));
vi.mock('@ui/viewport/3d/entities/SolidMeshShell', () => ({
  SolidMeshShell: (props: { geometry: THREE.BufferGeometry }): null => {
    shell.geometry = props.geometry;
    return null;
  },
}));

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
  it('draws the whole entity: a twisted, scaled sweep renders the positions of sweepTriangles(entity)', () => {
    const { entity } = dispatchEntity('sweep_profile', {
      path: xyz(0, 0, 0, 0, 50, 0, 50, 50, 0),
      section: [
        [-10, -2.5],
        [10, -2.5],
        [10, 2.5],
        [-10, 2.5],
      ],
      bendRadius: 20,
      twist: { type: 'linear', start: 0, end: 1.5 },
      scale: { type: 'linear', start: 1, end: 0.5 },
    });
    const Branch = SOLID_MESHES.sweep;
    render(<Branch entity={entity as SweepEntity} selected={false} onSelect={() => undefined} />);
    const expected = buildTriangleSoupGeometry(sweepTriangles(entity as SweepEntity));
    const drawn = shell.geometry?.getAttribute('position');
    expect(drawn).toBeDefined();
    expect(Array.from(drawn?.array ?? [])).toEqual(Array.from(expected?.getAttribute('position').array ?? []));
    const plain = buildTriangleSoupGeometry(
      sweepTriangles({ path: (entity as SweepEntity).path, section: (entity as SweepEntity).section }),
    );
    expect(Array.from(plain?.getAttribute('position').array ?? [])).not.toEqual(Array.from(drawn?.array ?? []));
  });

  const positions = (): number[] => Array.from(shell.geometry?.getAttribute('position').array ?? []);
  const loftWith = (params: Record<string, unknown>): LoftEntity =>
    dispatchEntity('loft_sections', {
      sections: [
        {
          center: [0, 0, 0],
          section: [
            [-5, -5],
            [5, -5],
            [5, 5],
            [-5, 5],
          ],
        },
        {
          center: [20, 0, 10],
          section: [
            [-5, -5],
            [5, -5],
            [5, 5],
            [-5, 5],
          ],
        },
        {
          center: [40, 0, 0],
          section: [
            [-5, -5],
            [5, -5],
            [5, 5],
            [-5, 5],
          ],
        },
      ],
      ...params,
    }).entity as LoftEntity;

  it('a closed loft draws wrapping walls (loftTriangles of the whole entity), not end caps', () => {
    const loft = loftWith({ closed: true });
    expect(loft.closed).toBe(true);
    const Branch = SOLID_MESHES.loft;
    render(<Branch entity={loft} selected={false} onSelect={() => undefined} />);
    expect(positions()).toEqual(Array.from(buildTriangleSoupGeometry(loftTriangles(loft))?.getAttribute('position').array ?? []));
    expect(positions()).not.toEqual(
      Array.from(buildTriangleSoupGeometry(loftTriangles({ rings: loft.rings, ruled: loft.ruled }))?.getAttribute('position').array ?? []),
    );
  });

  it('a loft whose exact faces are straight in u draws its polygon rings, not smoothed ones', () => {
    const loft = loftWith({});
    const polygon = { ...loft, faces: [{ degreeU: 1 }] } as unknown as LoftEntity;
    const Branch = SOLID_MESHES.loft;
    render(<Branch entity={polygon} selected={false} onSelect={() => undefined} />);
    expect(positions()).toEqual(Array.from(buildTriangleSoupGeometry(loftTriangles(polygon))?.getAttribute('position').array ?? []));
    expect(positions()).not.toEqual(Array.from(buildTriangleSoupGeometry(loftTriangles(loft))?.getAttribute('position').array ?? []));
  });

  it('a move, recolour or rename keeps the tessellation; a geometry edit rebuilds it', () => {
    const sweep = dispatchEntity('sweep_profile', { path: xyz(0, 0, 0, 0, 0, 30), radius: 2 }).entity as SweepEntity;
    const Branch = SOLID_MESHES.sweep;
    const { rerender } = render(<Branch entity={sweep} selected={false} onSelect={() => undefined} />);
    const first = shell.geometry;
    rerender(
      <Branch entity={{ ...sweep, position: [5, 0, 0], color: '#ff0000', name: 'moved' }} selected={false} onSelect={() => undefined} />,
    );
    expect(shell.geometry).toBe(first);
    rerender(
      <Branch
        entity={{ ...sweep, section: { shape: 'circle', radius: 3 } as SweepEntity['section'] }}
        selected={false}
        onSelect={() => undefined}
      />,
    );
    expect(shell.geometry).not.toBe(first);
  });
});
