/**
 * PHY-04 thermal bow (VC-TMC-08) and the Al housing / steel shaft fit (VC-TMC-06) through the `llull` CLI. The beams carry a linear
 * through-thickness field (T = 20 - 4 (z - 2.5) degC, 20 K over h = 5 mm, alpha 2.3e-5): FE curvature kappa = alpha dT / h, no stress.
 * The fit plan has no FE; it needs neither Gmsh nor CalculiX.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { EXIT_OK } from '../src/cli/main';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { isRecord } from '@lib/isRecord';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';
import { dataOf, expectCase, planPath, Workspace } from './feaThermomechSupport';

const READY = HAS_GMSH && HAS_CCX && nativeKernelBinary !== null;
let workspace: Workspace;

beforeAll(async () => {
  workspace = new Workspace();
  setGeometryKernel(READY ? createNativeTestKernel() : await createManifoldKernel());
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

describe.skipIf(!READY)('VC-TMC-08 thermal bow of a beam with a linear through-thickness gradient', () => {
  it('VC-TMC-08.c: cantilever tip deflection kappa L^2 / 2 (L = 500 mm)', async () => {
    const session = workspace.open('cantilever');
    const probes = await session.solved(await session.idOf(planPath('tmc_gradient_cantilever'), 'an'), 2);
    expectCase('VC-TMC-08.c', probes['tip'] ?? Number.NaN, 'mm');
  }, 120_000);

  it('VC-TMC-08.b/d: simply supported 500 mm span (half model, symmetry at mid-span): bow kappa L^2 / 8 and no stress', async () => {
    const session = workspace.open('supported');
    const analysisId = await session.idOf(planPath('tmc_gradient_supported_half'), 'an');
    const probes = await session.solved(analysisId, 2);
    // the field makes the top fibres shorter (curvature up): the mid-span sags below the supports, the pack states the bow as a magnitude
    const bow = -(probes['tip'] ?? Number.NaN);
    expectCase('VC-TMC-08.b', bow, 'mm');
    expectCase('VC-TMC-08.d', probes['stress_mid'] ?? Number.NaN, 'MPa');

    // the same bow through thermal_distortion_report (the point displacement at mid-span)
    const report = await session.cli(
      'thermal_distortion_report',
      `analysisId=${analysisId}`,
      'points=[{"name":"mid-span","point":[250,5,2.5]}]',
    );
    expect(report.code, String(report.json['summary'])).toBe(EXIT_OK);
    const rows = dataOf(report.json)['points'];
    const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
    const displacement = isRecord(row) && Array.isArray(row['displacement']) ? Number(row['displacement'][2]) : Number.NaN;
    expect(Math.abs(-displacement - bow)).toBeLessThan(1e-3 * bow);
  }, 120_000);
});

interface FitRow {
  readonly status: string;
  readonly code?: string;
  readonly clearance: { readonly min: number; readonly max: number };
  readonly reviewRequired: boolean;
}

describe('VC-TMC-06 fit_at_temperature from the plan (no FE)', () => {
  it('Al housing / steel shaft H7/g6 at -55 / 20 / 85 degC, and the swapped pair at 85 degC', async () => {
    const session = workspace.open('fit');
    const { code, json } = await session.cli('run', planPath('tmc_fit_al_steel'));
    expect(code, String(json['summary'])).toBe(EXIT_OK);
    const steps: unknown = dataOf(json)['steps'];
    const fits = (Array.isArray(steps) ? steps : []).flatMap((step: unknown) => {
      const data = isRecord(step) ? step['data'] : undefined;
      return isRecord(data) && Array.isArray(data['rows']) ? [data['rows'] as FitRow[]] : [];
    });
    expect(fits).toHaveLength(2);
    const [housing = [], swapped = []] = fits;
    expect(housing.map((row) => row.status)).toEqual(['interference_possible', 'clearance', 'clearance']);
    expect(housing[0]?.code).toBe('TMC_FIT_INTERFERENCE');
    expect(housing.every((row) => row.reviewRequired)).toBe(true);
    expectCase('VC-TMC-06.a', housing[0]?.clearance.min ?? Number.NaN, 'mm');
    expectCase('VC-TMC-06.b', housing[2]?.clearance.max ?? Number.NaN, 'mm');
    expectCase('VC-TMC-06.d', [housing[1]?.clearance.min ?? Number.NaN, housing[1]?.clearance.max ?? Number.NaN], 'mm');
    expectCase('VC-TMC-06.c', swapped[2]?.clearance.min ?? Number.NaN, 'mm');
    expect(swapped[2]?.code).toBe('TMC_FIT_INTERFERENCE');
  });
});
