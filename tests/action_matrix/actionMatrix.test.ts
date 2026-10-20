import { afterAll, beforeAll, describe } from 'vitest';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { defineMatrixSuite } from './matrixSuite';

// Action matrix (SC-Q2) on the in-process Manifold mesh kernel: fillet / chamfer / shell are `unsupported` here; the native OCCT column
// runs from server/tests/actionMatrix.test.ts against the same baseline.json.
describe('action matrix (Manifold mesh kernel)', () => {
  let previous: GeometryKernel | null;
  beforeAll(async () => {
    previous = getGeometryKernel();
    setGeometryKernel(await createManifoldKernel());
  }, 60_000);
  afterAll(() => setGeometryKernel(previous));

  defineMatrixSuite('manifold');
});
