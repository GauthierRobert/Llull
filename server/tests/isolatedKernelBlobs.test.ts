/**
 * The native kernel's worker proxy forwards the exact-kernel ports (info, importShapes, loadBlob) and keeps every loaded blob to re-send after a worker
 * restart, so `brep` recipe leaves survive an abort. The composition root adds how the kernel is isolated (`installGeometryKernel`).
 */

import { afterAll, expect, it } from 'vitest';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createNativeKernel } from '../src/nativeKernel';
import { makeBlob } from '@core/model/blobs';
import type { Entity } from '@core/model/types';
import type { ImportShapesOptions } from '@core/geometry/kernelPorts';
import { describeNative, liveKernels, nativeKernelBinary } from './kernelTestSupport';

const kernels = liveKernels();
const workers: IsolatedKernel[] = [];
afterAll(() => workers.forEach((worker) => worker.dispose()));

const OPTIONS: ImportShapesOptions = { precision: 1e-4, maxTolerance: 0.1, heal: true, sew: true };
const box = {
  id: 'b',
  kind: 'box',
  size: [10, 20, 30],
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  layerId: 'l',
  color: '#888888',
} as Entity;

describeNative('isolated native kernel: exact ports', () => {
  it('describes itself, imports a STEP in the worker and evaluates brep leaves from loaded blobs across an abort', () => {
    const worker = createNativeKernel(nativeKernelBinary!, { testHooks: true });
    workers.push(worker);
    expect(worker.info?.()).toMatchObject({ occtVersion: '7.9.2', build: expect.stringContaining('llull-kernel@') });

    const step = kernels.occt.exportStep([kernels.occt.evaluate({ op: 'solid', entity: box })!]);
    const imported = worker.importShapes?.('step', step ?? '', OPTIONS);
    expect(imported && 'solids' in imported ? imported.solids : []).toHaveLength(1);
    const brep = imported && 'solids' in imported ? (imported.solids[0]?.brep ?? '') : '';
    expect(brep).toContain('CASCADE Topology');

    const blob = makeBlob('model/x-occt-brep', brep);
    const recipe = { op: 'brep', blob: blob.sha256, format: 'occt-brep-v1' } as const;
    expect(worker.evaluate(recipe)).toBeNull(); // the worker has not been given the blob
    worker.loadBlob?.(blob.sha256, brep);
    const handle = worker.evaluate(recipe);
    expect(handle).not.toBeNull();
    expect(worker.topology(handle!)?.volume).toBeCloseTo(6000, 6);

    worker.forceFailure('__abort');
    expect(worker.crashCount()).toBe(1);
    expect(worker.tessellate(handle!)?.indices.length).toBeGreaterThan(0); // rebuilt in the respawned worker from the re-sent blob
    expect(worker.topology(handle!)?.volume).toBeCloseTo(6000, 6);
  }, 240_000);
});
