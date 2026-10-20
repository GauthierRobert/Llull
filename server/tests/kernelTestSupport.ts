/** Shape-kernel shorthands for the live-kernel tests: entity -> leaf recipe -> display mesh. */

import { afterAll, beforeAll, describe, expect } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNativeKernel } from '../src/nativeKernel';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { nativeBinaryPath, nativeInstallHint } from '../src/native/nativeBinary';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { MeshData } from '@core/model/types';
import type { BooleanOp, ShapeRecipe } from '@core/model/types';
import type { Entity, Vec3 } from '@core/model/types';
import { meshBounds } from '../../tests/helpers/meshBounds';

/** The native `llull-kernel` binary (`cargo build --release -p llull-kernel` in solver/, or LLULL_KERNEL_BIN / LLULL_NATIVE_DIR), or null. */
export const nativeKernelBinary = nativeBinaryPath('llull-kernel');
// CI's native-kernel job builds the binary first: there a missing binary is a failure, not a skip.
if (nativeKernelBinary === null && process.env['LLULL_REQUIRE_NATIVE_KERNEL'] === '1') throw new Error(nativeInstallHint('llull-kernel'));
if (nativeKernelBinary === null) console.warn(`[native kernel tests] skipped: ${nativeInstallHint('llull-kernel')}`);

/** `describe` for suites that run the real native kernel: skipped (with the reason logged above) when the binary is not built. */
export const describeNative: typeof describe = describe.skipIf(nativeKernelBinary === null) as typeof describe;

let probedCapabilities: readonly string[] | undefined;

/** What the installed native binary can do (`info().capabilities`), probed once by starting it; empty when it is absent or does not start. */
export function nativeCapabilities(): readonly string[] {
  if (nativeKernelBinary === null) return [];
  if (probedCapabilities === undefined) {
    const probe = createNativeKernel(nativeKernelBinary, { callTimeoutMs: 60_000 });
    try {
      probedCapabilities = probe.start() ? (probe.info?.().capabilities ?? []) : [];
    } finally {
      probe.dispose();
    }
  }
  return probedCapabilities;
}

/**
 * `describe` for suites that need the native kernel AND the given capabilities (e.g. the XDE exchange ops): skipped, with the reason logged, when the
 * binary is absent, lacks a capability (an older build), or `unless` names another reason (missing fixtures). One combined condition: chaining
 * `describeNative.skipIf(x)` would REPLACE the binary condition (vitest builds the chain from the last `skipIf`), and the suite would run with no kernel.
 */
export function describeNativeWhen(options: {
  readonly capabilities?: readonly string[];
  readonly unless?: string | null;
  readonly label: string;
}): typeof describe {
  const missing = (options.capabilities ?? []).filter((capability) => !nativeCapabilities().includes(capability));
  const reason =
    nativeKernelBinary === null
      ? `no native llull-kernel binary (${nativeInstallHint('llull-kernel')})`
      : missing.length > 0
        ? `the native kernel build lacks ${missing.join(', ')} (rebuild solver/)`
        : (options.unless ?? null);
  if (reason !== null && nativeKernelBinary !== null) console.warn(`[${options.label}] skipped: ${reason}`);
  return describe.skipIf(reason !== null) as typeof describe;
}

/** A started native kernel (the sidecar behind its synchronous worker proxy). Dispose it when done (or let the process exit). */
export function createNativeTestKernel(options: { readonly testHooks?: boolean; readonly callTimeoutMs?: number } = {}): IsolatedKernel {
  if (nativeKernelBinary === null) throw new Error(nativeInstallHint('llull-kernel'));
  const kernel = createNativeKernel(nativeKernelBinary, { callTimeoutMs: 120_000, ...options });
  if (!kernel.start()) throw new Error('the native kernel did not start');
  return kernel;
}

export const leaf = (entity: Entity): ShapeRecipe => ({ op: 'solid', entity });

const asRecipe = (source: Entity | ShapeRecipe): ShapeRecipe => ('op' in source ? source : leaf(source));

/** Display mesh of a recipe (or of an entity's leaf); null when the kernel refuses it. */
export function meshOf(kernel: GeometryKernel, source: Entity | ShapeRecipe): MeshData | null {
  const shape = kernel.evaluate(asRecipe(source));
  return shape === null ? null : kernel.tessellate(shape);
}

export const booleanRecipe = (op: BooleanOp, a: Entity | ShapeRecipe, b: Entity | ShapeRecipe): ShapeRecipe => ({
  op: 'boolean',
  boolean: op,
  a: asRecipe(a),
  b: asRecipe(b),
});

/** Mesh of `a op b` (exact operands); null when the kernel refuses it. */
export function booleanMesh(kernel: GeometryKernel, op: BooleanOp, a: Entity | ShapeRecipe, b: Entity | ShapeRecipe): MeshData | null {
  return meshOf(kernel, booleanRecipe(op, a, b));
}

export const common = { layerId: 'layer-default', color: '#888888' };

export const box = (position: Vec3, size: Vec3): Entity =>
  ({ id: 'b', kind: 'box', position, rotation: [0, 0, 0], size, ...common }) as Entity;

export const bounds = meshBounds;

/** Signed volume by the divergence theorem: positive when the mesh is wound outward. */
export function volume(mesh: MeshData): number {
  let sum = 0;
  const p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => (mesh.indices[i + k] ?? 0) * 3) as [number, number, number];
    sum +=
      ((p[a] ?? 0) * ((p[b + 1] ?? 0) * (p[c + 2] ?? 0) - (p[b + 2] ?? 0) * (p[c + 1] ?? 0)) -
        (p[a + 1] ?? 0) * ((p[b] ?? 0) * (p[c + 2] ?? 0) - (p[b + 2] ?? 0) * (p[c] ?? 0)) +
        (p[a + 2] ?? 0) * ((p[b] ?? 0) * (p[c + 1] ?? 0) - (p[b + 1] ?? 0) * (p[c] ?? 0))) /
      6;
  }
  return sum;
}

/** The native OCC kernel (`occt`) and Manifold, filled in `beforeAll`; read them inside tests. */
export function liveKernels(): { occt: IsolatedKernel; manifold: GeometryKernel } {
  const kernels = {} as { occt: IsolatedKernel; manifold: GeometryKernel };
  beforeAll(async () => {
    if (nativeKernelBinary === null) return;
    kernels.occt = createNativeTestKernel();
    kernels.manifold = await createManifoldKernel();
  }, 120_000);
  afterAll(() => kernels.occt?.dispose());
  return kernels;
}

/** Bounding boxes of `a` and `b` agree on every axis within `tolerance`. */
export function expectBoundsClose(a: MeshData, b: MeshData, tolerance: number): void {
  const [boundsA, boundsB] = [bounds(a), bounds(b)];
  for (let k = 0; k < 3; k++) {
    expect(Math.abs((boundsA.min[k] ?? 0) - (boundsB.min[k] ?? 0))).toBeLessThan(tolerance);
    expect(Math.abs((boundsA.max[k] ?? 0) - (boundsB.max[k] ?? 0))).toBeLessThan(tolerance);
  }
}

/** The exact volume of `entity op cutter` on the native OCC kernel is within -8% / +8% of Manifold's (faceted) one. */
export function expectBooleanAgrees(
  kernels: { occt: GeometryKernel; manifold: GeometryKernel },
  op: BooleanOp,
  entity: Entity,
  cutter: Entity,
  label?: string,
): void {
  const shape = kernels.occt.evaluate(booleanRecipe(op, entity, cutter));
  const exact = shape === null ? undefined : kernels.occt.massProperties?.(shape)?.volume;
  const fromManifold = booleanMesh(kernels.manifold, op, entity, cutter);
  expect(exact, label).toBeDefined();
  expect(fromManifold, label).not.toBeNull();
  expect(exact! / volume(fromManifold!), label).toBeGreaterThan(0.92);
  expect(exact! / volume(fromManifold!), label).toBeLessThan(1.08);
}

/** `[label, position, rotation]` placements shared by the OpenCascade-vs-Manifold comparisons. */
export type Placement = [string, Vec3, Vec3];
export const ORIGIN_PLACEMENT: Placement = ['origin', [0, 0, 0], [0, 0, 0]];
export const TRANSLATED_PLACEMENT: Placement = ['translated', [5, -3, 2], [0, 0, 0]];
export const ALL_AXES_PLACEMENT: Placement = ['rotated about all axes', [-2, 4, 1], [0.3, -0.5, 1.1]];

/** Both kernels' meshes of `entity`; each must exist (`label` names the case on failure). */
export function bothMeshes(
  kernels: { occt: GeometryKernel; manifold: GeometryKernel },
  entity: Entity,
  label?: string,
): { fromOcct: MeshData; fromManifold: MeshData } {
  const fromOcct = meshOf(kernels.occt, entity);
  const fromManifold = meshOf(kernels.manifold, entity);
  expect(fromOcct, label).not.toBeNull();
  expect(fromManifold, label).not.toBeNull();
  return { fromOcct: fromOcct!, fromManifold: fromManifold! };
}
