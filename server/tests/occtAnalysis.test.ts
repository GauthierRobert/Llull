/** Live OpenCascade: PHY-21 `analyze` / `distance` (VC-FPR-01…05) and cylinder / plane face axes (TR-FPR-02, VC-FPR-09 inputs). */
import { expect, it } from 'vitest';
import type { Entity } from '@core/model/types';
import { cube, kernelAnalysisCases } from '../../tests/helpers/kernelAnalysisCases';
import { liveKernels, describeNative } from './kernelTestSupport';

const kernels = liveKernels();

describeNative('occt analyze and distance', () => {
  kernelAnalysisCases(() => kernels.occt, 'occt');

  it('cylinder faces expose axis, radius and pin / bore convexity; planes expose outward normals', () => {
    const pin: Entity = {
      id: 'p',
      kind: 'cylinder',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      radius: 5,
      height: 20,
      layerId: 'l',
      color: '#fff',
    } as Entity;
    const block = cube('b', [0, 0, 0], 40);
    const bored = kernels.occt.evaluate({
      op: 'boolean',
      boolean: 'subtract',
      a: { op: 'solid', entity: block },
      b: { op: 'solid', entity: { ...pin, id: 'bore', radius: 5.01 } as Entity },
    });
    const pinShape = kernels.occt.evaluate({ op: 'solid', entity: pin });
    const pinFace = kernels.occt.topology(pinShape!)?.faces.find((face) => face.surface === 'cylinder');
    const boreFace = kernels.occt.topology(bored!)?.faces.find((face) => face.surface === 'cylinder');
    expect(pinFace?.axis?.radius).toBeCloseTo(5, 9);
    expect(pinFace?.convex).toBe(true);
    expect(boreFace?.axis?.radius).toBeCloseTo(5.01, 9);
    expect(boreFace?.convex).toBe(false);
    expect(Math.abs(boreFace?.axis?.direction[2] ?? 0)).toBeCloseTo(1, 9);
    const planes = kernels.occt
      .topology(kernels.occt.evaluate({ op: 'solid', entity: cube('c', [0, 0, 0], 2) })!)
      ?.faces.filter((face) => face.surface === 'plane');
    const sums = planes?.reduce((acc, face) => acc.map((v, k) => v + (face.normal?.[k] ?? 0)), [0, 0, 0]);
    expect(planes).toHaveLength(6);
    expect(sums).toEqual([0, 0, 0]);
    expect(planes?.every((face) => Math.abs(Math.hypot(...(face.normal ?? [0, 0, 0])) - 1) < 1e-9)).toBe(true);
  });
});
