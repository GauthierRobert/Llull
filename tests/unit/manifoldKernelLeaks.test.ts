import { describe, expect, it, vi } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';

interface Shape {
  delete(): void;
}
interface Loaded {
  Manifold: Record<string, (...args: unknown[]) => Shape>;
  CrossSection: new (...args: unknown[]) => Shape;
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

/** Wrap every Manifold/CrossSection factory and derived-shape method; report what was never freed. */
async function instrumentedKernel(): Promise<{
  kernel: Awaited<
    ReturnType<typeof import('@kernel-manifold/manifoldKernel').createManifoldKernel>
  >;
  leaked: () => number;
  created: () => number;
}> {
  const { createManifoldKernel } = await import('@kernel-manifold/manifoldKernel');
  const kernel = await createManifoldKernel();
  const loaded = captured.module!;
  const created = new Set<Shape>();
  const deleted = new Set<Shape>();
  const derivedMethods = ['add', 'subtract', 'intersect', 'translate', 'rotate', 'extrude'];

  const track = (shape: Shape): Shape => {
    created.add(shape);
    const target = shape as unknown as Record<string, (...args: unknown[]) => unknown>;
    const originalDelete = target['delete']!.bind(shape);
    target['delete'] = (): unknown => {
      deleted.add(shape);
      return originalDelete();
    };
    for (const method of derivedMethods) {
      const original = target[method]?.bind(shape);
      if (original !== undefined) {
        target[method] = (...args: unknown[]): unknown => track(original(...args) as Shape);
      }
    }
    return shape;
  };

  for (const factory of ['ofMesh', 'cube', 'cylinder', 'sphere']) {
    const original = loaded.Manifold[factory]!.bind(loaded.Manifold);
    loaded.Manifold[factory] = (...args: unknown[]): Shape => track(original(...args));
  }
  const OriginalSection = loaded.CrossSection;
  loaded.CrossSection = function (...args: unknown[]): Shape {
    return track(new OriginalSection(...args));
  } as unknown as Loaded['CrossSection'];

  return {
    kernel,
    leaked: () => [...created].filter((shape) => !deleted.has(shape)).length,
    created: () => created.size,
  };
}

const common = { layerId: 'layer-default', color: '#888888' };
const placed = (
  position: Vec3,
  rotation: Vec3 = [0.2, 0.1, 0.3],
): Pick<Entity, 'position' | 'rotation' | 'layerId' | 'color'> => ({
  position,
  rotation,
  ...common,
});
const entities = (position: Vec3): Entity[] =>
  [
    { id: 'b', kind: 'box', size: [2, 3, 4], ...placed(position) },
    { id: 'c', kind: 'cylinder', radius: 1, height: 3, ...placed(position) },
    { id: 's', kind: 'sphere', radius: 2, ...placed(position) },
    { id: 'k', kind: 'cone', radius: 1.5, height: 3, ...placed(position) },
    { id: 't', kind: 'torus', ringRadius: 3, tubeRadius: 1, ...placed(position) },
    {
      id: 'm',
      kind: 'mesh',
      mesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
      },
      ...placed(position),
    },
    { id: 'w', kind: 'wedge', size: [2, 2, 2], ...placed(position) },
    { id: 'p', kind: 'pyramid', baseWidth: 2, baseDepth: 2, height: 2, ...placed(position) },
    {
      id: 'e',
      kind: 'extrusion',
      profile: [
        [0, 0],
        [2, 0],
        [2, 1],
        [0, 1],
      ],
      depth: 2,
      ...placed(position),
    },
    {
      id: 'r',
      kind: 'revolution',
      profile: [
        [1, 0],
        [2, 0],
        [2, 2],
        [1, 2],
      ],
      axis: [0, 0, 1],
      angle: Math.PI * 2,
      segments: 12,
      ...placed(position),
    },
  ] as unknown as Entity[];

describe('manifold kernel frees every WASM object', () => {
  it('after 200+ tessellations and booleans over every solid kind, including empty and failing results', async () => {
    const { kernel, leaked, created } = await instrumentedKernel();
    const near = entities([0, 0, 0]);
    const far = entities([100, 0, 0]);
    let operations = 0;
    for (const a of near) {
      expect(kernel.tessellate(a), a.kind).not.toBeNull();
      operations++;
      for (const b of [...near, ...far].slice(0, 10)) {
        for (const op of ['union', 'subtract', 'intersect'] as const) {
          kernel.booleanOp(op, a, b);
          operations++;
        }
      }
    }
    expect(operations).toBeGreaterThan(200);
    expect(created()).toBeGreaterThan(operations);
    expect(leaked()).toBe(0);
  }, 120_000);

  it('frees objects on the failure paths too (open mesh, degenerate sizes, unsupported kinds)', async () => {
    const { kernel, leaked } = await instrumentedKernel();
    const openMesh = {
      id: 'm',
      kind: 'mesh',
      mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
      ...placed([0, 0, 0], [0, 0, 0]),
    } as unknown as Entity;
    const flat = {
      id: 'f',
      kind: 'box',
      size: [0, 1, 1],
      ...placed([0, 0, 0]),
    } as unknown as Entity;
    const line = {
      id: 'l',
      kind: 'line',
      start: [0, 0],
      end: [1, 1],
      ...placed([0, 0, 0]),
    } as unknown as Entity;
    const [box] = entities([0, 0, 0]);
    for (const bad of [openMesh, flat, line]) {
      expect(kernel.tessellate(bad)).toBeNull();
      expect(kernel.booleanOp('union', box!, bad)).toBeNull();
      expect(kernel.booleanOp('union', bad, box!)).toBeNull();
    }
    expect(leaked()).toBe(0);
  }, 60_000);
});
