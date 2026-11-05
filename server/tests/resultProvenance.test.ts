import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { app } from '../src/index';
import { _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory } from '../src/commandBus';
import { getKernelStatus, installGeometryKernel } from '../src/geometryKernel';
import { setGeometryKernel } from '@core/geometry/kernel';

/** VC-INT-15: the exact kernel is requested and not installed (a missing llull-kernel binary): every kernel result says the mesh kernel answered. */
describe('result provenance over POST /command with the exact kernel unavailable', () => {
  let scratch = '';
  beforeAll(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'llull-prov-'));
    _resetLiveDoc();
    _resetHistory();
    const env: NodeJS.ProcessEnv = { ...process.env, LLULL_KERNEL_BIN: path.join(scratch, 'no-such-llull-kernel.exe') };
    delete env['LLULL_KERNEL'];
    expect(await installGeometryKernel({ env })).toBe(true);
  });
  afterAll(() => {
    setGeometryKernel(null);
    rmSync(scratch, { recursive: true, force: true });
  });

  const post = (name: string, params: unknown): request.Test => request(app).post('/command').send({ name, params });

  it('/health says requested differs from active, with the reason', async () => {
    const health = await request(app).get('/health');
    expect(health.body.kernel).toBe('manifold');
    expect(health.body.kernelStatus.active).toBe('manifold');
    expect(health.body.kernelStatus.requested).toBe('occt');
    expect(health.body.kernelStatus.fallbackReason).toEqual(expect.any(String));
    expect(getKernelStatus().fallbackReason).toBe(health.body.kernelStatus.fallbackReason);
  });

  it('add_box x2, boolean and mass_properties: kernel results carry provenance manifold + the reason, a plain add_box none', async () => {
    const first = await post('add_box', { size: [2, 2, 2] });
    const second = await post('add_box', { size: [2, 2, 2], position: [1, 0, 0] });
    expect(first.body.provenance).toBeUndefined();
    expect(second.body.provenance).toBeUndefined();
    const [a] = first.body.affected as string[];
    const [b] = second.body.affected as string[];

    const union = await post('boolean', { op: 'union', a, b });
    expect(union.body.isError).toBe(false);
    const reason = (await request(app).get('/health')).body.kernelStatus.fallbackReason as string;
    expect(union.body.provenance).toEqual({ kernel: 'manifold', exactRequested: true, fallbackReason: reason });

    const mass = await post('mass_properties', { entityId: (union.body.affected as string[])[0] });
    expect(mass.body.isError).toBe(false);
    expect(mass.body.provenance).toEqual({ kernel: 'manifold', exactRequested: true, fallbackReason: reason });
  });

  it('kernel_info reports the requested kernel next to the active one and the fallback reason', async () => {
    const info = await post('kernel_info', {});
    expect(info.body.data.active).toBe('manifold');
    expect(info.body.data.requested).toBe('occt');
    expect(info.body.data.fallbackReason).toEqual(expect.any(String));
  });
});
