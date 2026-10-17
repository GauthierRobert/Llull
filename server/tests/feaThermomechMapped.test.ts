/**
 * PHY-04 TR-TMC-23 through the real pipeline: the thick cylinder heated by a heat_steady case on a COARSER mesh (global size 3 mm), read by a
 * thermo_static case on a FINER mesh (2 mm) with mapping interpolate. VC-TMC-05.a-c must still hold (2 %). Skipped without Gmsh or CalculiX.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createNodeOcctKernel } from '../src/occtNode';
import { EXIT_COMMAND_ERROR } from '../src/cli/main';
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

describe.skipIf(!READY)('VC-TMC-05 with mapping interpolate between a coarser thermal mesh and a finer mechanical mesh', () => {
  it('refuses same_mesh across the two discretisations, maps with interpolate and reproduces the thick-cylinder stresses', async () => {
    const session = workspace.open('mapped');
    const aliases = await session.run(planPath('tmc_thick_cylinder_mapped'));
    const thermal = aliases['th']?.[0] ?? '';
    const mechanical = aliases['an']?.[0] ?? '';
    await session.mesh(thermal);
    await session.mesh(mechanical);
    await session.solve(thermal);

    const sameMesh = await session.cli(
      'set_temperature_field',
      `analysisId=${mechanical}`,
      `source={"kind":"thermal_result","analysisId":"${thermal}","time":"last","mapping":"same_mesh"}`,
    );
    expect(sameMesh.code).toBe(0);
    const refused = await session.cli('fea_solve', `analysisId=${mechanical}`);
    expect(refused.code).toBe(EXIT_COMMAND_ERROR);
    expect(String(refused.json['summary'])).toContain('TMC_MESH_MISMATCH');

    const interpolate = await session.cli(
      'set_temperature_field',
      `analysisId=${mechanical}`,
      `source={"kind":"thermal_result","analysisId":"${thermal}","time":"last","mapping":"interpolate"}`,
    );
    expect(interpolate.code).toBe(0);
    await session.solve(mechanical);
    const probes = await session.probes(mechanical);
    expectCase('VC-TMC-05.a', probes['bore_hoop'] ?? Number.NaN, 'MPa');
    expectCase('VC-TMC-05.b', probes['outer_hoop'] ?? Number.NaN, 'MPa');
    expectCase('VC-TMC-05.c', probes['bore_axial'] ?? Number.NaN, 'MPa');
  }, 300_000);
});
