/**
 * 01 DEF on the native kernel (M1): an affine `deform` node is lowered by the host to the sidecar's `gtransform` op (BRepBuilderAPI_GTransform),
 * exact up to the kernel's own mass-property integration; every other law is a mesh-path command (the exact warp is milestone M2) and the
 * proxy answers it without a round trip. Skipped without the binary / the `gtransform` capability.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeformNode } from '@core/geometry/deform/laws';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Entity, type ShapeRecipe } from '@core/model/types';
import { nativeRecipe } from '../src/native/kernelProtocol';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { common, createNativeTestKernel, describeNativeWhen, leaf } from './kernelTestSupport';

const SOURCE: ShapeRecipe = leaf({
  id: 'b',
  kind: 'box',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: [10, 20, 30],
  ...common,
} as Entity);
const FRAME = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;
const OUTPUT = { mode: 'auto', tolerance: 0.01, preserveAnalytic: false } as const;

const affine = (rows: [number, number, number][], translation: [number, number, number] = [0, 0, 0]): DeformNode => ({
  op: 'deform',
  source: SOURCE,
  law: { kind: 'affine', matrix: [rows[0] ?? [1, 0, 0], rows[1] ?? [0, 1, 0], rows[2] ?? [0, 0, 1]], translation },
  frame: FRAME,
  output: OUTPUT,
});

describe('native recipe lowering of deform nodes (no sidecar needed)', () => {
  it('an affine law becomes one gtransform node in world coordinates', () => {
    const lowered = nativeRecipe(
      affine(
        [
          [2, 0, 0],
          [0, 1, 0],
          [0, 0, 3],
        ],
        [1, 2, 3],
      ),
    ) as unknown as { op: string; matrix: number[]; translation: number[]; source: ShapeRecipe };
    expect(lowered.op).toBe('gtransform');
    expect(lowered.matrix).toEqual([2, 0, 0, 0, 1, 0, 0, 0, 3]);
    expect(lowered.translation).toEqual([1, 2, 3]);
    expect(lowered.source.op).toBe('solid');
  });

  it('a frame is composed into the world matrix: a scale along the frame z axis acts along the world x axis', () => {
    const node: DeformNode = {
      ...affine([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 5],
      ]),
      frame: { origin: [0, 0, 0], axis: [1, 0, 0], reference: [0, 1, 0] },
    };
    const lowered = nativeRecipe(node) as unknown as { matrix: number[] };
    expect(lowered.matrix).toEqual([5, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('other laws stay deform nodes (the sidecar answers NATIVE_UNSUPPORTED) with their source lowered', () => {
    const twist: DeformNode = {
      ...affine([]),
      law: { kind: 'twist', angleRad: 1 },
      region: { start: 0, end: 10, falloff: 'smooth', beyond: 'rigid' },
    };
    const lowered = nativeRecipe(twist);
    expect(lowered.op).toBe('deform');
  });
});

describeNativeWhen({ capabilities: ['gtransform'], label: 'nativeKernelDeform' })('01 DEF on the native kernel', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    kernel.dispose();
    setGeometryKernel(null);
  });

  const box = (size: [number, number, number], anchor: 'center' | 'base-center' = 'center'): { doc: CadDocument; id: string } => {
    const created = execute(createEmptyDocument(), 'add_box', { size, anchor });
    return { doc: created.document, id: created.affected[0] as string };
  };

  it('supports affine maps only, and builds them as exact solids', () => {
    expect(
      kernel.supportsDeform?.({
        kind: 'affine',
        matrix: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        translation: [0, 0, 0],
      }),
    ).toBe(true);
    expect(kernel.supportsDeform?.({ kind: 'twist', angleRad: 1 })).toBe(false);
    const shape = kernel.evaluate(
      affine([
        [2, 0, 0],
        [0, 1, 0],
        [0, 0, 0.5],
      ]),
    );
    expect(shape).not.toBeNull();
    const mass = shape === null ? undefined : kernel.massProperties?.(shape);
    expect(mass?.volume).toBeCloseTo(6000, 6);
    expect(shape === null ? null : kernel.topology(shape)).not.toBeNull();
  });

  it('a non-affine node is answered null by the proxy', () => {
    const twist: DeformNode = {
      ...affine([]),
      law: { kind: 'twist', angleRad: 1 },
      region: { start: 0, end: 10, falloff: 'smooth', beyond: 'rigid' },
    };
    expect(kernel.evaluate(twist)).toBeNull();
  });

  it('scale_nonuniform is exact on a box and a mirror stays an outward solid (VC-DEF-12)', () => {
    const { doc, id } = box([10, 20, 30]);
    const mirrored = execute(doc, 'scale_nonuniform', { id, factors: [-1, 1, 1], output: { mode: 'exact' } });
    const next = mirrored.affected[0] as string;
    expect(mirrored.summary).toContain('exact path');
    const shape = kernel.evaluate(
      mirrored.document.entities[next]?.kind === 'mesh' ? (mirrored.document.entities[next] as { brep: ShapeRecipe }).brep : SOURCE,
    );
    expect(shape).not.toBeNull();
    expect(kernel.massProperties?.(shape!)?.volume).toBeCloseTo(6000, 6);
    expect(kernel.analyze?.(shape!)?.valid).toBe(true);
    const flat = execute(doc, 'scale_nonuniform', { id, factors: [1, 0, 1] });
    expect(flat.error?.code).toBe('DEF_SCALE_SINGULAR');
  });

  it('a sphere scaled [1, 1, 2] is an exact spheroid (VC-DEF-11)', () => {
    const created = execute(createEmptyDocument(), 'add_sphere', { radius: 10 });
    const result = execute(created.document, 'scale_nonuniform', {
      id: created.affected[0] as string,
      factors: [1, 1, 2],
      output: { mode: 'exact' },
    });
    expect(result.rejected).toBeUndefined();
    const data = result.data as { path: string; volume: { value: number; method: string } };
    expect(data.path).toBe('exact');
    expect(data.volume.method).toBe('exact');
    // the kernel integrates the B-spline faces with its default Gauss rule: 4.4e-4 relative here (the surface itself is exact to 1e-15)
    expect(Math.abs(data.volume.value - 8377.58040957) / 8377.58040957).toBeLessThan(1e-3);
    const check = execute(result.document, 'check_deformation', {});
    expect((check.data as { status: string }).status).not.toBe('fail');
  });

  it('twist_body is a mesh-path command on the native kernel: "auto" says so, "exact" refuses (exact warp: milestone M2)', () => {
    const { doc, id } = box([10, 10, 100], 'base-center');
    const auto = execute(doc, 'twist_body', { id, angleDeg: 90, frame: FRAME, output: { tolerance: 0.05 } });
    expect((auto.data as { path: string; kernel: string }).path).toBe('mesh');
    expect(auto.summary).toContain('does not build this law exactly');
    const refused = execute(doc, 'twist_body', { id, angleDeg: 90, output: { mode: 'exact' } });
    expect(refused.error?.code).toBe('DEF_EXACT_UNAVAILABLE');
    const next = auto.affected[0] as string;
    const filleted = execute(auto.document, 'mass_properties', { entityId: next });
    expect((filleted.data as { method: string }).method).toBe('mesh');
  });
});
