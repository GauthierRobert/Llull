import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('render_view — large mesh', () => {
  it('renders a 200k-triangle mesh (capped) instead of overflowing the call stack', () => {
    const triangles = 200_000;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let t = 0; t < triangles; t++) {
      const x = t % 500;
      const y = Math.floor(t / 500);
      positions.push(x, y, 0, x + 1, y, 0, x, y + 1, 0);
      indices.push(3 * t, 3 * t + 1, 3 * t + 2);
    }
    const doc = createEmptyDocument();
    const mesh = {
      id: 'mesh-big',
      kind: 'mesh' as const,
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      layerId: 'layer-default',
      color: '#ffffff',
      mesh: { positions, indices },
    };
    const withMesh = {
      ...doc,
      entities: { ...doc.entities, [mesh.id]: mesh },
      order: [...doc.order, mesh.id],
    };

    const result = execute(withMesh, 'render_view', {});

    expect(result.summary).not.toMatch(/failed/);
    expect(result.data).toMatchObject({ entityCount: 1 });
  });
});
