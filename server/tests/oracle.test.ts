/**
 * Oracle reference parts (SC-Q1) on the native OCCT kernel: the same plans and analytic expectations as tests/oracle, with the tight
 * tolerances (exact B-rep: volume/area 1e-3 relative, centroid/bbox 1e-3 of the size, no mesh envelope) and a STEP round trip
 * (export_step_exact then import_step_exact, compared again). Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { type CaseResult, loadCases, runCase, saveResults } from '../../tests/oracle/oracleRunner';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

describeNative('oracle reference parts (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  const rows: CaseResult[] = [];
  const cases = loadCases();

  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);

  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
    saveResults('occt', 'llull-kernel (native OCCT)', rows);
  });

  for (const oracle of cases) {
    it(`${oracle.id}: ${oracle.expected.description}`, () => {
      const row = runCase(oracle, 'occt', { stepRoundTrip: true });
      rows.push(row);
      expect(row.status === 'fail' ? row.failures : [], oracle.expected.formula).toEqual([]);
    }, 120_000);
  }
});
