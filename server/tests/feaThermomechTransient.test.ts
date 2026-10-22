/**
 * PHY-04 M4b through the real pipeline (plan -> fea_mesh (Netgen) -> fea_solve (CalculiX) -> analysis_report): the bonded two-material strip against
 * Timoshenko's bimetal curvature (VC-TMC-04.a / .b, conformal mesh, the layers share their interface nodes) and the transient coupled step on
 * the restrained bar (the stress follows the temperature in time and ends at -E alpha dT, VC-TMC-01.a). Skipped with a logged reason without
 * llull-mesh, CalculiX or the native kernel; the deck writers and the readers are proved without a solver in tests/unit/cae/thermomech/.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { isRecord } from '@lib/isRecord';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';
import { HAS_CCX, HAS_MESHER } from './feaTestSupport';
import { dataOf, expectCase, planPath, Workspace } from './feaThermomechSupport';

const READY = HAS_MESHER && HAS_CCX && nativeKernelBinary !== null;
/** The restrained bar is a plain box: Manifold geometry (STL) meshes it when the native kernel is absent; the conformal bimetal needs exact STEP. */
const TRANSIENT_READY = HAS_MESHER && HAS_CCX;
if (!READY)
  console.warn(
    `[PHY-04 M4b FE] skipped: ${[HAS_MESHER ? null : 'llull-mesh (Netgen)', HAS_CCX ? null : 'CalculiX (ccx)', nativeKernelBinary === null ? 'llull-kernel' : null].filter((name) => name !== null).join(', ')} not available`,
  );

let workspace: Workspace;

beforeAll(async () => {
  workspace = new Workspace();
  if (READY) setGeometryKernel(createNativeTestKernel());
  else if (TRANSIENT_READY) setGeometryKernel(await createManifoldKernel());
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

const LENGTH = 50;

describe.skipIf(!READY)('VC-TMC-04 bimetal cantilever as FE (two materials, conformal mesh)', () => {
  it('tip deflection and curvature of the heated strip (E 200 / 100 GPa, alpha 12 / 19 ppm per K, dT 100 K)', async () => {
    const session = workspace.open('bimetal');
    const analysisId = await session.idOf(planPath('tmc_bimetal_cantilever'), 'an');
    const checked = await session.cli('check_thermo_mechanical', `analysisId=${analysisId}`);
    expect(dataOf(checked.json)['verdict'], JSON.stringify(dataOf(checked.json)['items'])).not.toBe('fail');
    const probes = await session.solved(analysisId);
    // the hotter-expanding upper layer is on top, so the tip moves down; the width is free and symmetric: the two corners agree
    const tip = -((probes['tip_y0'] ?? Number.NaN) + (probes['tip_y1'] ?? Number.NaN)) / 2;
    expectCase('VC-TMC-04.b', tip, 'mm');
    expectCase('VC-TMC-04.a', (2 * tip) / (LENGTH * LENGTH), '1/mm');
  }, 600_000);
});

describe.skipIf(!TRANSIENT_READY)('transient coupled step on the restrained bar (TR-TMC-22, M4b)', () => {
  it('writes the transient step, and the stress history ends at the steady restrained value with its peak at the end', async () => {
    const session = workspace.open('coupled-transient');
    const analysisId = await session.idOf(planPath('tmc_coupled_bar'), 'an');
    const cp = {
      id: 'cp',
      property: 'cp',
      unit: 'J/(kg*K)',
      variables: [],
      validity: [],
      form: { kind: 'constant', value: 480 },
      basis: 'company',
      source: { citation: 'test input of this validation case (not a material claim)' },
    };
    for (const [command, ...argv] of [
      ['define_property_model', 'material=steel_test', `model=${JSON.stringify(cp)}`],
      ['set_initial_temperature', `analysisId=${analysisId}`, 'value=20', 'unit=degC'],
      ['set_thermal_step', `analysisId=${analysisId}`, 'endTimeS=600', 'initialIncrementS=1', 'maxIncrementS=25', 'outputEveryS=50'],
    ] as const) {
      const done = await session.cli(command, ...argv);
      expect(done.code, String(done.json['summary'])).toBe(0);
    }
    await session.mesh(analysisId);
    const exported = await session.cli('fea_export', `analysisId=${analysisId}`);
    const deck = String(dataOf(exported.json)['text']);
    expect(deck).toContain('*COUPLED TEMPERATURE-DISPLACEMENT\n1, 600');
    expect(deck).toContain('TIME POINTS=TP_OUT');
    expect(deck).toMatch(/\*SPECIFIC HEAT\n/);
    await session.solve(analysisId);
    const report = await session.cli('analysis_report', `analysisId=${analysisId}`);
    const results = dataOf(report.json)['results'];
    const transient = isRecord(results) ? results['thermomechTransient'] : undefined;
    expect(isRecord(transient), JSON.stringify(results)).toBe(true);
    const series = isRecord(transient) && Array.isArray(transient['series']) ? transient['series'] : [];
    expect(series.length).toBeGreaterThanOrEqual(10);
    const stresses = series.map((row) => (isRecord(row) ? Number(row['maxVonMises']) : Number.NaN));
    expect(stresses[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(stresses.at(-1) ?? 0);
    const peak = isRecord(transient) && isRecord(transient['peakVonMises']) ? transient['peakVonMises'] : {};
    expect(Number(peak['timeS'])).toBeGreaterThanOrEqual(500);
    const probes = await session.probes(analysisId, 3);
    expectCase('VC-TMC-01.a', probes['mid'] ?? Number.NaN, 'MPa');
  }, 600_000);

  it('seeds a start temperature different from T_ref through the pre-heating step: the first increment starts at it, times from the coupled step', async () => {
    const session = workspace.open('coupled-transient-preheat');
    const analysisId = await session.idOf(planPath('tmc_coupled_bar'), 'an');
    const cp = {
      id: 'cp',
      property: 'cp',
      unit: 'J/(kg*K)',
      variables: [],
      validity: [],
      form: { kind: 'constant', value: 480 },
      basis: 'company',
      source: { citation: 'test input of this validation case (not a material claim)' },
    };
    for (const [command, ...argv] of [
      ['define_property_model', 'material=steel_test', `model=${JSON.stringify(cp)}`],
      ['set_initial_temperature', `analysisId=${analysisId}`, 'value=60', 'unit=degC'],
      ['set_thermal_step', `analysisId=${analysisId}`, 'endTimeS=10', 'initialIncrementS=0.5', 'maxIncrementS=1', 'outputEveryS=1'],
    ] as const) {
      const done = await session.cli(command, ...argv);
      expect(done.code, String(done.json['summary'])).toBe(0);
    }
    await session.mesh(analysisId);
    const exported = await session.cli('fea_export', `analysisId=${analysisId}`);
    expect(String(dataOf(exported.json)['text'])).toContain('*STATIC');
    await session.solve(analysisId);
    const report = await session.cli('analysis_report', `analysisId=${analysisId}`);
    const results = dataOf(report.json)['results'];
    const transient = isRecord(results) ? results['thermomechTransient'] : undefined;
    const series = isRecord(transient) && Array.isArray(transient['series']) ? transient['series'] : [];
    const first = series[0];
    expect(isRecord(first), JSON.stringify(results)).toBe(true);
    // the far part of the bar has not felt the 1 s of heating yet: it is still at the start temperature (60 degC), not at T_ref (20 degC)
    expect(Math.abs(Number(isRecord(first) ? first['minTemperature'] : Number.NaN) - 60)).toBeLessThan(5);
    expect(Number(isRecord(first) ? first['timeS'] : Number.NaN)).toBeLessThanOrEqual(2);
  }, 600_000);
});
