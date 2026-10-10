import { describe, beforeAll, afterAll } from 'vitest';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { kernelPlans } from './plans';
import { describePlans } from './describePlans';

describe('golden replay corpus (Manifold kernel)', () => {
  let previousKernel: GeometryKernel | null;

  beforeAll(async () => {
    previousKernel = getGeometryKernel();
    setGeometryKernel(await createManifoldKernel());
  }, 60_000);

  afterAll(() => setGeometryKernel(previousKernel));

  describePlans(kernelPlans);
});
