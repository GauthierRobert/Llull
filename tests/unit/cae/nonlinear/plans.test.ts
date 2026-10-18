/** The PHY-05 validation plans that need only the four commands of this lane, replayed through build_project. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { caseOf } from '@cae/shared/access';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

const memo = <T>(make: () => T): (() => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};

const PLANS = 'docs/physics/05-nonlinear-structural/validation/plans';

interface Action {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}
interface Report {
  command: string;
  ok: boolean;
  summary: string;
}

/** The plan steps; `tet` replaces hex_dominant meshing (only tet is built), the one deviation from the plan file. */
const replay = (name: string, tetOnly = false): { steps: Report[]; document: ReturnType<typeof execute>['document'] } => {
  const plan = JSON.parse(readFileSync(`${PLANS}/${name}.plan.json`, 'utf8')) as Action[];
  const actions = tetOnly
    ? plan.map((action) =>
        action.params['elementFamily'] === 'hex_dominant' ? { ...action, params: { ...action.params, elementFamily: 'tet' } } : action,
      )
    : plan;
  const result = execute(createEmptyDocument(), 'build_project', { actions }, { ...defaultContext(), kernel });
  return { steps: (result.data as { steps: Report[] }).steps, document: result.document };
};

describe('nls_cantilever_plastic_collapse plan', () => {
  const built = memo(() => replay('nls_cantilever_plastic_collapse', true));

  it('runs every step, including the four nonlinear commands', () => {
    const { steps } = built();
    expect(steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
    const names = steps.map((step) => step.command);
    for (const command of ['set_part_constitutive_set', 'set_nonlinear_controls', 'add_analysis_step', 'add_curve_probe'])
      expect(names).toContain(command);
  });

  it('fails only at hex_dominant meshing as written (not built: set_mesh_controls knows tet only)', () => {
    const asWritten = replay('nls_cantilever_plastic_collapse').steps.filter((step) => !step.ok);
    expect(asWritten.map((step) => step.command)).toEqual(['set_mesh_controls']);
  });

  it('builds a displacement-controlled J2 collapse case with a reaction curve', () => {
    const { document } = built();
    const analysis = document.analysis === undefined ? undefined : caseOf(document, document.analysis.caseOrder[0] ?? '');
    expect(analysis?.type).toBe('nonlinear_static');
    const nonlinear = analysis?.nonlinear;
    expect(nonlinear).toMatchObject({ nlgeom: false, convergence: { name: 'ccx_default' }, outputIncrements: 'all' });
    expect(Object.values(nonlinear?.constitutiveSets ?? {})).toEqual(['ep']);
    const only = nonlinear?.steps[nonlinear.stepOrder[0] ?? ''];
    expect(only?.control).toMatchObject({ kind: 'displacement', dof: 'uy', value: -60, maxIncrements: 400 });
    const probe = nonlinear?.probes[nonlinear.probeOrder[0] ?? ''];
    expect(probe?.load).toMatchObject({ kind: 'reaction', component: 'y' });
    expect(probe?.displacement).toEqual({ point: [5, 10, 500], dof: 'uy' });
  });
});

describe('nls_thick_cylinder plan', () => {
  const built = memo(() => replay('nls_thick_cylinder'));

  it('runs every step with a pressure load driven by a 166x load-control step', () => {
    const { steps, document } = built();
    expect(steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
    const analysis = document.analysis === undefined ? undefined : caseOf(document, document.analysis.caseOrder[0] ?? '');
    const nonlinear = analysis?.nonlinear;
    const only = nonlinear?.steps[nonlinear.stepOrder[0] ?? ''];
    expect(only).toMatchObject({ multipliers: { LC1: 166 }, control: { kind: 'load', initialIncrement: 0.05 } });
    const probe = nonlinear?.probes[nonlinear.probeOrder[0] ?? ''];
    expect(probe?.load).toEqual({ kind: 'load', loadId: Object.keys(analysis?.loads ?? {})[0] });
  });
});
