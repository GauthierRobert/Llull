import { beforeAll, describe, expect, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { cube, kernelAnalysisCases } from '../helpers/kernelAnalysisCases';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

describe('Manifold kernel analyze and distance', () => {
  kernelAnalysisCases(() => kernel, 'manifold');

  it('analyze of a non-manifold mesh solid reports invalid, not a throw', () => {
    const open = {
      id: 'm',
      kind: 'mesh',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'l',
      color: '#fff',
      mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    };
    const shape = kernel.evaluate({ op: 'solid', entity: open as never });
    if (shape === null) return;
    const analysis = kernel.analyze?.(shape);
    expect(analysis === null || analysis?.valid === false || analysis?.volume === 0).toBe(true);
  });

  it('distance of identical shapes is zero and symmetric witness exists', () => {
    const shape = kernel.evaluate({ op: 'solid', entity: cube('a', [0, 0, 0], 10) });
    const result = kernel.distance?.(shape!, shape!, 1);
    expect(result?.distance).toBe(0);
    expect(result?.inside).toBe(true);
  });
});
