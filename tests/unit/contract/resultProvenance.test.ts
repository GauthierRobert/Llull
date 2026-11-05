import { describe, it, expect, afterEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { isDegraded, kernelProvenance } from '@core/commands/provenance';
import { guardedKernel } from '@core/commands/kernelMeshGuard';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { fakeKernel } from '../../helpers/fakeKernel';

function kernelWith(info: NonNullable<ReturnType<NonNullable<GeometryKernel['info']>>>): GeometryKernel {
  return { ...fakeKernel(), info: () => info };
}

const degradedKernel = kernelWith({
  capabilities: [],
  active: 'manifold',
  exactRequested: true,
  fallbackReason: 'llull-kernel binary not found',
});
const exactKernel = kernelWith({ capabilities: [], active: 'occt-native', exactRequested: true });

function withKernel(kernel: GeometryKernel | null): ExecutionContext {
  return { ...defaultContext(), kernel };
}

const box = (): ReturnType<typeof createEmptyDocument> => execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;

afterEach(() => setGeometryKernel(null));

describe('result provenance (FR-INT-07, TR-INT-09)', () => {
  it('a kernel-optional result names the mesh kernel, that exact was requested and why it did not answer', () => {
    const result = execute(box(), 'mass_properties', { entityId: 'box-1.1' }, withKernel(degradedKernel));
    expect(result.provenance).toEqual({ kernel: 'manifold', exactRequested: true, fallbackReason: 'llull-kernel binary not found' });
  });

  it('an exact kernel is reported as occt-native without a fallback reason', () => {
    const result = execute(box(), 'mass_properties', { entityId: 'box-1.1' }, withKernel(exactKernel));
    expect(result.provenance).toEqual({ kernel: 'occt-native', exactRequested: true });
  });

  it('no kernel installed is reported as none, not as a degradation of an exact request', () => {
    const result = execute(box(), 'mass_properties', { entityId: 'box-1.1' }, withKernel(null));
    expect(result.provenance).toEqual({ kernel: 'none', exactRequested: false });
  });

  it('a command that does not use the kernel carries no provenance, and the document never stores it', () => {
    const added = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }, withKernel(degradedKernel));
    expect(added.provenance).toBeUndefined();
    const measured = execute(added.document, 'mass_properties', { entityId: 'box-1.1' }, withKernel(degradedKernel));
    expect(JSON.stringify(measured.document)).not.toContain('fallbackReason');
  });

  it('a plan lists its degraded steps and carries the first one as its own provenance', () => {
    const plan = {
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] } },
        { command: 'mass_properties', params: { entityId: 'box-1.1' } },
      ],
    };
    const result = execute(createEmptyDocument(), 'build_project', plan, withKernel(degradedKernel));
    const data = result.data as { steps: { command: string; provenance?: unknown }[]; degradedSteps?: number[] };
    expect(data.steps[0]?.provenance).toBeUndefined();
    expect(data.steps[1]?.provenance).toMatchObject({ kernel: 'manifold', exactRequested: true });
    expect(data.degradedSteps).toEqual([1]);
    expect(result.provenance?.fallbackReason).toBe('llull-kernel binary not found');
    const exact = execute(createEmptyDocument(), 'build_project', plan, withKernel(exactKernel));
    expect((exact.data as { degradedSteps?: number[] }).degradedSteps).toBeUndefined();
    expect(exact.provenance).toBeUndefined();
  });

  it('degradedSteps counts plan steps (top-level actions, as stepCount and failedAt do), not the flattened commands of a repeat', () => {
    const plan = {
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] } },
        { repeat: { count: 3 }, step: { command: 'mass_properties', params: { entityId: 'box-1.1' } } },
        { command: 'add_box', params: { size: [1, 1, 1], position: [5, 0, 0] } },
      ],
    };
    const result = execute(createEmptyDocument(), 'build_project', plan, withKernel(degradedKernel));
    const data = result.data as { stepCount: number; steps: { index: number }[]; degradedSteps?: number[] };
    expect(data.stepCount).toBe(3);
    expect(data.steps.map((step) => step.index)).toEqual([0, 1, 1, 1, 2]);
    expect(data.degradedSteps).toEqual([1]);
    expect(result.summary).toContain('mesh kernel at step 1');
  });

  describe('kernelProvenance of wrapped and info-less kernels', () => {
    const exactWithVersion = kernelWith({ capabilities: [], occtVersion: '7.9.2', active: 'occt-native', exactRequested: true });

    it('the mesh-guard view of the exact kernel reports what the kernel itself reports', () => {
      const view = guardedKernel(exactWithVersion);
      expect(view).not.toBe(exactWithVersion);
      expect(kernelProvenance(withKernel(view))).toEqual(kernelProvenance(withKernel(exactWithVersion)));
      expect(kernelProvenance(withKernel(view))).toEqual({ kernel: 'occt-native', exactRequested: true });
    });

    it('the guard leaves a degraded (mesh) kernel unwrapped, so its fallback reason survives', () => {
      expect(guardedKernel(degradedKernel)).toBe(degradedKernel);
      expect(kernelProvenance(withKernel(guardedKernel(degradedKernel)))).toMatchObject({ kernel: 'manifold', exactRequested: true });
    });

    it('a kernel without info() reads as the in-process mesh kernel, exact not requested (never degraded): hosts that fall back must describe themselves', () => {
      const { info: _info, ...bare } = fakeKernel();
      expect(kernelProvenance(withKernel(bare as GeometryKernel))).toEqual({ kernel: 'manifold', exactRequested: false });
      expect(isDegraded(kernelProvenance(withKernel(bare as GeometryKernel)))).toBe(false);
    });

    it('the in-process Manifold kernel names itself (active manifold) and is not degraded', async () => {
      const manifold = await createManifoldKernel();
      expect(manifold.info?.().active).toBe('manifold');
      expect(kernelProvenance(withKernel(manifold))).toEqual({ kernel: 'manifold', exactRequested: false });
    });
  });
});
