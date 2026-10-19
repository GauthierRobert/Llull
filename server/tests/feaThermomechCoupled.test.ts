/**
 * PHY-04 coupled temperature-displacement procedure (TR-TMC-22) through the real pipeline: thermal BCs (PHY-03) and mechanical BCs (05) in ONE
 * analysis, `*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE` solved by CalculiX. The temperature field is solved, not set: the fully restrained
 * bar with the same temperature on both ends reproduces VC-TMC-01.a, the thick cylinder (bore 120 degC, outer 20 degC) VC-TMC-05.a-c.
 * Skipped without Gmsh or CalculiX.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';
import { dataOf, expectCase, planPath, Workspace } from './feaThermomechSupport';

const READY = HAS_GMSH && HAS_CCX && nativeKernelBinary !== null;
let workspace: Workspace;

beforeAll(async () => {
  workspace = new Workspace();
  if (READY) setGeometryKernel(createNativeTestKernel());
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

describe.skipIf(!READY)('VC-TMC-01.a / 05 with the coupled procedure', () => {
  it('check_thermo_mechanical is clean, fea_export writes the coupled step, and the restrained bar gives -E alpha dT', async () => {
    const session = workspace.open('coupled-bar');
    const analysisId = await session.idOf(planPath('tmc_coupled_bar'), 'an');
    const checked = await session.cli('check_thermo_mechanical', `analysisId=${analysisId}`);
    expect(dataOf(checked.json)['verdict'], JSON.stringify(dataOf(checked.json)['items'])).not.toBe('fail');
    await session.mesh(analysisId);
    const exported = await session.cli('fea_export', `analysisId=${analysisId}`);
    const deck = String(dataOf(exported.json)['text']);
    expect(deck).toContain('*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE');
    expect(deck).toContain('*NODE FILE\nU, NT\n*EL FILE\nS, HFL\n*END STEP');
    expect(deck).toMatch(/\*EXPANSION, ZERO=20\n/);
    expect(deck).toMatch(/\*CONDUCTIVITY\n50\n/);
    await session.solve(analysisId);
    const probes = await session.probes(analysisId, 3);
    expectCase('VC-TMC-01.a', probes['mid'] ?? Number.NaN, 'MPa');
    // the solved temperature is the prescribed one everywhere (steady conduction between two equal ends)
    expect(probes['T_mid']).toBeCloseTo(120, 3);
  }, 240_000);
});

describe.skipIf(!READY)('VC-TMC-05 thick cylinder with the coupled procedure (one analysis, no separate heat case)', () => {
  it('hoop stress at the bore and the outer surface, axial stress at the bore (free ends)', async () => {
    const session = workspace.open('coupled-cylinder');
    const analysisId = await session.idOf(planPath('tmc_coupled_cylinder'), 'an');
    const probes = await session.solved(analysisId);
    expectCase('VC-TMC-05.a', probes['bore_hoop'] ?? Number.NaN, 'MPa');
    expectCase('VC-TMC-05.b', probes['outer_hoop'] ?? Number.NaN, 'MPa');
    expectCase('VC-TMC-05.c', probes['bore_axial'] ?? Number.NaN, 'MPa');
    // the thermal boundary conditions of the same analysis are honoured by the solve
    expect(probes['T_bore']).toBeCloseTo(120, 3);
    expect(probes['T_outer']).toBeCloseTo(20, 3);
  }, 240_000);
});
