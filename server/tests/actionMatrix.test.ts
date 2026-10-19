/**
 * Action matrix (SC-Q2) on the native OCCT kernel: the same designs and ratchet as tests/action_matrix, but with the kernel's real B-rep
 * (every edge gets a fillet and a chamfer, every face a shell and a hole). Writes the `occt` column of tests/action_matrix/baseline.json
 * (ACTION_MATRIX_BLESS=1). Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { defineMatrixSuite } from '../../tests/action_matrix/matrixSuite';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

describeNative('action matrix (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  defineMatrixSuite('occt');
});
