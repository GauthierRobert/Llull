import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { DeformReport } from '@core/geometry/kernelPorts';
import { addBox, dataOf, installKernel, stubReport, WORLD_Z, type RunData } from './harness';

/** `output.preserveAnalytic` at the command layer (01 DEF §17.11): the refusals by name and the report in the data, on stub exact kernels. */
const report = (analyticFaces?: DeformReport['analyticFaces']): DeformReport => ({
  ok: true,
  code: '',
  message: '',
  maxError: 0,
  surfaceError: 0,
  curveError: 0,
  faces: 6,
  edges: 12,
  splitFaces: 0,
  ring: false,
  minDeterminant: 1,
  volume: 10000,
  ...(analyticFaces === undefined ? {} : { analyticFaces }),
});
const twist = { angleDeg: 30, frame: WORLD_Z, region: { start: 0, end: 100 } };

describe('preserveAnalytic', () => {
  afterEach(() => {
    stubReport.current = null;
    stubReport.refuse = false;
  });

  it('is refused by name on an exact kernel without the deform-analytic capability', async () => {
    await installKernel('warp');
    const { doc, id } = addBox();
    const result = execute(doc, 'twist_body', { id, ...twist, output: { preserveAnalytic: true } });
    expect(result.error?.code).toBe('DEF_EXACT_UNAVAILABLE');
    expect(result.error?.paths).toEqual(['params.output.preserveAnalytic']);
    expect(result.document).toBe(doc);
  });

  it('is refused by name when the exact warp refused and the faceted fallback has no analytic faces', async () => {
    await installKernel('analytic');
    stubReport.refuse = true;
    const { doc, id } = addBox();
    const result = execute(doc, 'twist_body', { id, ...twist, output: { mode: 'auto', preserveAnalytic: true } });
    expect(result.error?.code).toBe('DEF_EXACT_UNAVAILABLE');
    expect(result.summary).toContain('faceted mesh');
    expect(result.document).toBe(doc);
  });

  it('puts what the kernel recognised in the data, and nothing without the flag', async () => {
    await installKernel('analytic');
    const analytic = { tried: 6, plane: 2, cylinder: 0, cone: 0, sphere: 0, fromSource: 0, rejected: 0, rejectedStatus: 0, gap: 1e-6 };
    stubReport.current = report(analytic);
    const { doc, id } = addBox();
    const asked = execute(doc, 'twist_body', { id, ...twist, output: { mode: 'exact', preserveAnalytic: true } });
    expect(asked.error, asked.summary).toBeUndefined();
    expect(dataOf<RunData & { analyticFaces: unknown }>(asked).analyticFaces).toEqual(analytic);
    const plain = execute(doc, 'twist_body', { id, ...twist, output: { mode: 'exact' } });
    expect('analyticFaces' in (plain.data as object)).toBe(false);
  });
});
