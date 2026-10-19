import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { type CaseResult, loadCases, runCase, saveResults } from './oracleRunner';

// Oracle suite (SC-Q1) on the in-process Manifold mesh kernel: curved surfaces are tessellated, so each case with curved booleans or
// areas carries a recorded `meshTolerance`. The tight run on the native OCCT kernel (with STEP round trips) is server/tests/oracle.test.ts.
describe('oracle reference parts (Manifold mesh kernel)', () => {
  let previous: GeometryKernel | null;
  const rows: CaseResult[] = [];

  beforeAll(async () => {
    previous = getGeometryKernel();
    setGeometryKernel(await createManifoldKernel());
  }, 60_000);

  afterAll(() => {
    setGeometryKernel(previous);
    for (const oracle of cases)
      if (!oracle.expected.kernels.includes('manifold')) rows.push(runCase(oracle, 'manifold', { stepRoundTrip: false }));
    saveResults('manifold', 'manifold-3d (mesh)', rows);
  });

  const cases = loadCases();
  it('has at least 40 cases with analytic sources', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.every((c) => c.expected.source === 'analytic' || c.expected.source.startsWith('freecad '))).toBe(true);
  });

  for (const oracle of cases) {
    const { expected } = oracle;
    const runnable = expected.kernels.includes('manifold');
    (runnable ? it : it.skip)(`${oracle.id}: ${expected.description}`, () => {
      const row = runCase(oracle, 'manifold', { stepRoundTrip: false });
      rows.push(row);
      expect(row.status === 'fail' ? row.failures : [], expected.formula).toEqual([]);
    });
  }
});
