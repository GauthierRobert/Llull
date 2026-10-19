import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { getActiveKernelName, installGeometryKernel, occtCallTimeoutMs } from '../src/geometryKernel';
import { nativeKernelBinary } from './kernelTestSupport';

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

  it.skipIf(nativeKernelBinary === null)(
    'occt-native starts the native kernel and fillet_edge runs through the injected context',
    async () => {
      process.env['LLULL_KERNEL'] = 'occt-native';
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
    },
    60_000,
  );
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

  it.skipIf(nativeKernelBinary === null)(
    'the native kernel reports OCCT 7.9.2, its ports and that it runs in its own process',
    async () => {
      process.env['LLULL_KERNEL'] = 'occt-native';
      await installGeometryKernel();
      expect(infoOf()).toMatchObject({ active: 'occt', occtVersion: '7.9.2', isolation: 'process' });
      expect(infoOf()['capabilities']).toEqual(expect.arrayContaining(['importShapes', 'brepBlobs']));
    },
    60_000,
  );

  it('a failed native start falls back to Manifold and kernel_info says why (KRN_KERNEL_FALLBACK)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await installGeometryKernel({ env: { LLULL_KERNEL: 'occt-native' }, startNative: () => ({ reason: 'sidecar did not start' }) });
    const data = infoOf() as { active: string; fallbackReason: string; issues: Array<{ code: string }> };
    expect(data).toMatchObject({ active: 'manifold', fallbackReason: 'sidecar did not start' });
    expect(data.issues.map((issue) => issue.code)).toContain('KRN_KERNEL_FALLBACK');
  });
});
