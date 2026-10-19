import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { getActiveKernelName, installGeometryKernel, occtCallTimeoutMs } from '../src/geometryKernel';

afterEach(() => {
  delete process.env['LLULL_KERNEL'];
  setGeometryKernel(null);
});

describe('LLULL_OCC_TIMEOUT_MS', () => {
  it('defaults to 30 s and accepts a positive number of milliseconds', () => {
    expect(occtCallTimeoutMs({})).toBe(30_000);
    expect(occtCallTimeoutMs({ LLULL_OCC_TIMEOUT_MS: '5000' })).toBe(5000);
  });

  it.each(['0', '-5', 'abc', '', 'NaN', 'Infinity'])('ignores the invalid value %j', (value) => {
    expect(occtCallTimeoutMs({ LLULL_OCC_TIMEOUT_MS: value })).toBe(30_000);
  });
});

describe('LLULL_KERNEL', () => {
  it('unset without the native binary installs Manifold (discovery injected)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await installGeometryKernel({ env: {}, startNative: () => ({ reason: 'NATIVE_TOOL_MISSING: injected' }) })).toBe(true);
    expect(getActiveKernelName()).toBe('manifold');
    expect(getGeometryKernel()).not.toBeNull();
  });

  it('occt loads OpenCascade under Node and fillet_edge runs through the injected context', async () => {
    process.env['LLULL_KERNEL'] = 'occt';
    expect(await installGeometryKernel()).toBe(true);
    expect(getActiveKernelName()).toBe('occt');

    const base = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const params = { id: base.affected[0]!, radius: 0.2 };
    const first = execute(base.document, 'fillet_edge', params, defaultContext());
    const second = execute(base.document, 'fillet_edge', params, defaultContext());

    expect(first.affected).toHaveLength(1);
    const entity = first.document.entities[first.affected[0]!];
    const again = second.document.entities[second.affected[0]!];
    expect(entity?.kind).toBe('mesh');
    expect(again).toMatchObject({ kind: 'mesh', mesh: expect.anything() });
    expect(JSON.stringify(again && 'mesh' in again ? again.mesh : null)).toBe(
      JSON.stringify(entity && 'mesh' in entity ? entity.mesh : null),
    );
  }, 60_000);
});

describe('kernel_info through the composition root (TR-KRN-04)', () => {
  const noNative = (): { reason: string } => ({ reason: 'NATIVE_TOOL_MISSING: injected' });
  const infoOf = (): Record<string, unknown> =>
    execute(createEmptyDocument(), 'kernel_info', {}, defaultContext()).data as Record<string, unknown>;

  it('Manifold override: in-process, no fallback reason', async () => {
    await installGeometryKernel({ env: { LLULL_KERNEL: 'manifold' }, startNative: noNative });
    expect(infoOf()).toMatchObject({ active: 'manifold', isolation: 'in-process' });
    expect(infoOf()['fallbackReason']).toBeUndefined();
  });

  it('native default missing: Manifold, and kernel_info says why', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await installGeometryKernel({ env: {}, startNative: noNative });
    expect(infoOf()).toMatchObject({ active: 'manifold', fallbackReason: 'NATIVE_TOOL_MISSING: injected' });
  });

  it('occt: reports OCCT 7.4.0p1, its ports and how it is isolated', async () => {
    process.env['LLULL_KERNEL'] = 'occt';
    process.env['LLULL_OCC_ISOLATION'] = 'off';
    try {
      await installGeometryKernel();
    } finally {
      delete process.env['LLULL_OCC_ISOLATION'];
    }
    expect(infoOf()).toMatchObject({ active: 'occt', occtVersion: '7.4.0p1', isolation: 'in-process' });
    expect(infoOf()['capabilities']).toEqual(expect.arrayContaining(['importShapes', 'brepBlobs']));
  }, 60_000);

  it('a failed OCC start falls back to Manifold and kernel_info says why (KRN_KERNEL_FALLBACK)', async () => {
    vi.resetModules();
    vi.doMock('../src/occtNode', () => ({ createNodeOcctKernel: () => Promise.reject(new Error('wasm missing')) }));
    process.env['LLULL_KERNEL'] = 'occt';
    process.env['LLULL_OCC_ISOLATION'] = 'off';
    let data: { active: string; fallbackReason: string; issues: Array<{ code: string }> };
    try {
      const { installGeometryKernel: install } = await import('../src/geometryKernel');
      await install();
      const fresh = (await import('@core/geometry/kernel')).getGeometryKernel(); // vi.resetModules gave this graph its own singleton
      data = execute(createEmptyDocument(), 'kernel_info', {}, { ...defaultContext(), kernel: fresh }).data as typeof data;
    } finally {
      delete process.env['LLULL_OCC_ISOLATION'];
      vi.doUnmock('../src/occtNode');
    }
    expect(data).toMatchObject({ active: 'manifold', fallbackReason: 'wasm missing' });
    expect(data.issues.map((issue) => issue.code)).toContain('KRN_KERNEL_FALLBACK');
  });
});
