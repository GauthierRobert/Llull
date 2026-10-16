/**
 * PHY-04 thermo-mechanical benchmarks through the real pipeline (plan -> fea_mesh (Gmsh) -> fea_solve (CalculiX) -> fea_report probes),
 * judged against docs/physics/04-thermo-mechanical/validation/expected_results.json with the PHY-00 judge. The plans are the pack's drafts
 * adapted to the built commands (fixtures/thermomech/*.plan.json). The OCC kernel gives exact STEP geometry (LE11 needs it: the Manifold
 * facets of its spheres are rejected by Gmsh). Skipped without Gmsh or CalculiX.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { EXIT_COMMAND_ERROR } from '../src/cli/main';
import { createNodeOcctKernel } from '../src/occtNode';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';
import { expectCase, planPath, Workspace } from './feaThermomechSupport';

const READY = HAS_GMSH && HAS_CCX;
let workspace: Workspace;

beforeAll(async () => {
  workspace = new Workspace();
  if (READY) setGeometryKernel(await createNodeOcctKernel());
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

describe.skipIf(!READY)(
  'VC-TMC-01 fully restrained bodies, uniform 100 K rise (sigma = -E alpha dT, divided by the Poisson factors)',
  () => {
    it.each([
      ['VC-TMC-01.a', 'tmc_restrained_bar', 'uniaxial bar'],
      ['VC-TMC-01.b', 'tmc_restrained_plate', 'edge-restrained plate'],
      ['VC-TMC-01.c', 'tmc_restrained_block', 'fully restrained block'],
    ])(
      '%s: %s (%s)',
      async (caseId, plan, _label) => {
        const session = workspace.open(plan);
        const analysisId = await session.idOf(planPath(plan), 'an');
        // uniform field: the stress is the same at every node, so the nearest node to the centre is enough
        const probes = await session.solved(analysisId, 3);
        expectCase(caseId, probes['mid'] ?? Number.NaN, 'MPa');
      },
      120_000,
    );
  },
);

describe.skipIf(!READY)('VC-TMC-02 NAFEMS LE11', () => {
  it('sigma_zz at A of the revolved LE11 section under T = sqrt(x^2 + y^2) + z (Tref 0 degC), tet10', async () => {
    const session = workspace.open('le11');
    const analysisId = await session.idOf(planPath('tmc_nafems_le11'), 'an');
    const probes = await session.solved(analysisId);
    // the analysis unit system is N-m-kg-s: stress in Pa
    expectCase('VC-TMC-02', (probes['A'] ?? Number.NaN) / 1e6, 'MPa');
  }, 120_000);
});

describe.skipIf(!READY)('VC-TMC-05 thick cylinder, heat_steady then thermo_static on the same mesh', () => {
  it('hoop stress at the bore and the outer surface, axial stress at the bore (free ends)', async () => {
    const session = workspace.open('cylinder');
    const aliases = await session.run(planPath('tmc_thick_cylinder_sequential'));
    const thermal = aliases['th']?.[0] ?? '';
    const mechanical = aliases['an']?.[0] ?? '';
    expect([thermal, mechanical]).not.toContain('');

    // the thermal case is meshed (same parts and controls as the mechanical one) but not solved yet: the mechanical solve is refused
    await session.mesh(thermal);
    await session.mesh(mechanical);
    const early = await session.cli('fea_solve', `analysisId=${mechanical}`);
    expect(early.code).toBe(EXIT_COMMAND_ERROR);
    expect(String(early.json['summary'])).toContain('FEA_RESULTS_MISSING');

    await session.solve(thermal);
    await session.solve(mechanical);
    const probes = await session.probes(mechanical);
    expectCase('VC-TMC-05.a', probes['bore_hoop'] ?? Number.NaN, 'MPa');
    expectCase('VC-TMC-05.b', probes['outer_hoop'] ?? Number.NaN, 'MPa');
    expectCase('VC-TMC-05.c', probes['bore_axial'] ?? Number.NaN, 'MPa');

    // VC-TMC-50: editing the thermal analysis makes its results stale, so the mechanical solve is refused
    const edited = await session.cli('add_result_probe', `analysisId=${thermal}`, 'name=extra', 'point=[15,0,0]', 'quantity=temperature');
    expect(edited.code).toBe(0);
    const stale = await session.cli('fea_solve', `analysisId=${mechanical}`);
    expect(stale.code).toBe(EXIT_COMMAND_ERROR);
    expect(String(stale.json['summary'])).toContain('TMC_THERMAL_RESULT_STALE');
  }, 240_000);
});
