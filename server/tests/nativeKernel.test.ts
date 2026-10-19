/**
 * The native kernel proxy end to end through its worker, with a scripted stand-in for `llull-kernel` (fixtures/fakeKernel.cjs), so it
 * runs without a Rust build: native ops answered by the sidecar, the rest by the WASM OCC kernel, the selection and its fallbacks.
 */

import { chmodSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { getActiveKernelName, installGeometryKernel } from '../src/geometryKernel';
import { createNativeKernel, startNativeKernel } from '../src/nativeKernel';
import { box, leaf, meshOf } from './kernelTestSupport';

const FAKE = path.join(__dirname, 'fixtures', 'fakeKernel.cjs');
chmodSync(FAKE, 0o755);

const kernels: IsolatedKernel[] = [];
afterAll(() => kernels.forEach((kernel) => kernel.dispose()));
afterEach(() => {
  delete process.env['LLULL_KERNEL'];
  delete process.env['LLULL_KERNEL_BIN'];
  setGeometryKernel(null);
  vi.restoreAllMocks();
});

const cube = leaf(box([0, 0, 0], [2, 2, 2]));

describe.skipIf(process.platform === 'win32')('native kernel proxy (scripted sidecar)', () => {
  it('answers native ops through the sidecar and the rest through the WASM kernel, also after a worker crash', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kernel = createNativeKernel(FAKE, { testHooks: true });
    kernels.push(kernel);
    expect(kernel.start()).toBe(true);
    expect(meshOf(kernel, cube)?.indices).toHaveLength(36);

    const rounded = kernel.evaluate({ op: 'fillet', source: cube, edges: [0], size: 0.2 });
    expect(rounded).not.toBeNull();
    expect(kernel.topology(rounded!)?.faces).toHaveLength(7);
    expect(meshOf(kernel, { op: 'fillet', source: cube, edges: [0], size: 0.2 })?.indices.length).toBeGreaterThan(36);

    const info = kernel.info?.();
    expect(info?.occtVersion).toBe('7.9.2');
    expect(info?.build).toContain('llull-kernel@fake');
    expect(info?.build).toContain('opencascade.js');
    expect(info?.capabilities).toContain('topology');

    const handle = kernel.evaluate(cube);
    kernel.forceFailure('__abort');
    expect(kernel.crashCount()).toBe(1);
    expect(kernel.tessellate(handle!)?.indices).toHaveLength(36); // key-only, not cached by the new sidecar: resent with its recipe
  }, 120_000);

  it('reports a sidecar that does not speak the protocol', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const started = startNativeKernel({ startTimeoutMs: 20_000 }, { LLULL_KERNEL_BIN: '/bin/false' });
    expect(started).toEqual({ reason: expect.stringContaining('did not start') });
  }, 60_000);
});

describe('LLULL_KERNEL=occt-native', () => {
  it('refuses a missing binary with NATIVE_TOOL_MISSING and the install hint', () => {
    const started = startNativeKernel({}, { LLULL_KERNEL_BIN: path.join(__dirname, 'no-such-llull-kernel') });
    expect(started).toEqual({ reason: expect.stringMatching(/^NATIVE_TOOL_MISSING: llull-kernel not found: .*LLULL_KERNEL_BIN/) });
  });

  it.skipIf(process.platform === 'win32')(
    'installs the sidecar and reports it isolated in its own process',
    async () => {
      process.env['LLULL_KERNEL'] = 'occt-native';
      process.env['LLULL_KERNEL_BIN'] = FAKE;
      expect(await installGeometryKernel()).toBe(true);
      expect(getActiveKernelName()).toBe('occt');
      expect(getGeometryKernel()?.info?.()).toMatchObject({ occtVersion: '7.9.2', isolation: 'process' });
    },
    120_000,
  );

  it('falls back to the WASM OCC kernel and says why in kernel_info', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env['LLULL_KERNEL'] = 'occt-native';
    process.env['LLULL_KERNEL_BIN'] = path.join(__dirname, 'no-such-llull-kernel');
    expect(await installGeometryKernel()).toBe(true);
    expect(getActiveKernelName()).toBe('occt');
    const info = getGeometryKernel()?.info?.();
    expect(info?.fallbackReason).toMatch(/^NATIVE_TOOL_MISSING/);
    expect(info?.build).toBe('opencascade.js@1.1.1');
  }, 120_000);
});
