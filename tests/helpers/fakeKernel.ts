/**
 * Fake shape kernel for command tests: the real recipe evaluator (`kernelFromOps`) over canned
 * native ops, so commands exercise recipes, caching and handles without WASM.
 */
import type { MeshData, ShapeTopology } from '@core/geometry/kernel';
import type { BooleanOp, ShapeRecipe } from '@core/geometry/shapeRecipe';
import { kernelFromOps, type CachingKernel } from '@core/geometry/shapeKernel';
import type { Entity } from '@core/model/types';

/** A closed tetrahedron (4 triangles). */
export const TETRA: MeshData = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
};

/** Native fake shape: the mesh it tessellates to, and the entity of a leaf. */
export interface FakeShape {
  readonly mesh: MeshData;
  readonly entity?: Entity;
}

export interface FakeKernelSpec {
  /** Leaf solids (default TETRA; null = the kernel cannot build any entity). */
  readonly solid?: MeshData | null;
  readonly boolean?: MeshData | null;
  readonly fillet?: MeshData | null;
  readonly chamfer?: MeshData | null;
  readonly shell?: MeshData | null;
  readonly topology?: ShapeTopology | null;
  readonly step?: string | null;
  /** Recipe ops this kernel lacks entirely (Manifold: fillet, chamfer, shell). */
  readonly unsupported?: ReadonlyArray<ShapeRecipe['op']>;
}

export interface FakeCall {
  readonly op: string;
  readonly boolean?: BooleanOp;
  readonly operands: readonly FakeShape[];
  readonly edges?: readonly number[];
  readonly size?: number;
}

export type FakeKernel = CachingKernel & { readonly calls: FakeCall[] };

/** `spec` fields are read at call time, so a test may mutate them between commands. */
export function fakeKernel(spec: FakeKernelSpec = {}): FakeKernel {
  const calls: FakeCall[] = [];
  const shape = (mesh: MeshData | null | undefined): FakeShape | null =>
    mesh === null || mesh === undefined ? null : { mesh };
  const kernel = kernelFromOps<FakeShape>({
    unsupported: new Set(spec.unsupported ?? []),
    solid: (entity) => {
      calls.push({ op: 'solid', operands: [] });
      const mesh = spec.solid === undefined ? TETRA : spec.solid;
      return mesh === null ? null : { mesh, entity };
    },
    boolean: (op, a, b) => {
      calls.push({ op: 'boolean', boolean: op, operands: [a, b] });
      return shape(spec.boolean);
    },
    fillet: (source, edges, size) => {
      calls.push({ op: 'fillet', operands: [source], edges, size });
      return shape(spec.fillet);
    },
    chamfer: (source, edges, size) => {
      calls.push({ op: 'chamfer', operands: [source], edges, size });
      return shape(spec.chamfer);
    },
    shell: (source, thickness) => {
      calls.push({ op: 'shell', operands: [source], size: thickness });
      return shape(spec.shell);
    },
    place: (source) => ({ ...source }),
    scale: (source) => ({ ...source }),
    tessellate: (native) => native.mesh,
    topology: () => spec.topology ?? null,
    exportStep: () => spec.step ?? null,
    release: () => undefined,
  });
  return Object.assign(kernel, { calls });
}
