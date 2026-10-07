import { describe, expect, it, vi } from 'vitest';
import type { Entity } from '@core/model/types';

interface Shape {
  delete(): void;
}
interface Loaded {
  Manifold: {
    ofMesh(mesh: unknown): Shape;
  };
}

const captured: { module: Loaded | null } = { module: null };

vi.mock('manifold-3d', async (importOriginal) => {
  const original = await importOriginal<{ default: (opts?: unknown) => Promise<Loaded> }>();
  return {
    default: async (opts?: unknown): Promise<Loaded> => {
      captured.module = await original.default(opts);
      return captured.module;
    },
  };
});

describe('manifold kernel releases WASM solids', () => {
  it('deletes every solid created while tessellating a mesh entity', async () => {
    const { createManifoldKernel } = await import('@kernel-manifold/manifoldKernel');
    const kernel = await createManifoldKernel();
    const loaded = captured.module!;
    const created = new Set<Shape>();
    const deleted = new Set<Shape>();
    const track = (shape: Shape): Shape => {
      created.add(shape);
      const target = shape as unknown as Record<string, (...a: unknown[]) => unknown>;
      const originalDelete = target.delete!.bind(shape);
      target.delete = (): unknown => {
        deleted.add(shape);
        return originalDelete();
      };
      for (const method of ['rotate', 'translate']) {
        const original = target[method]!.bind(shape);
        target[method] = (...args: unknown[]): unknown => track(original(...args) as Shape);
      }
      return shape;
    };
    const ofMesh = loaded.Manifold.ofMesh.bind(loaded.Manifold);
    loaded.Manifold.ofMesh = (mesh: unknown): Shape => track(ofMesh(mesh));

    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const indices = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    const entity = {
      id: 'm',
      kind: 'mesh',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#888888',
      mesh: { positions, indices },
    } as unknown as Entity;

    expect(kernel.tessellate(entity)).not.toBeNull();
    expect(created.size).toBeGreaterThan(0);
    for (const shape of created) expect(deleted.has(shape)).toBe(true);
  });
});
