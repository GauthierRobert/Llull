/** The `nl1_material_point_proposed` validation plan, run through build_project (create_material stands in for the unbuilt define_material_record). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { expectCase } from '../benchmarkCases';
import { PACK, type PointData } from './materialFixtures';

interface Action {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}
interface Report {
  command: string;
  ok: boolean;
  summary: string;
  data?: unknown;
}

const plan = JSON.parse(readFileSync(`docs/physics/${PACK}/validation/plans/nl1_material_point_proposed.json`, 'utf8')) as Action[];
const actions: Action[] = plan.map((action) =>
  action.command === 'define_material_record'
    ? { command: 'create_material', params: { name: 'nl1_steel', density: 0.00785, color: '#b0b0b0', metalness: 1, roughness: 0.4 } }
    : action,
);

describe('nl1_material_point_proposed plan', () => {
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  const steps = (result.data as { steps: Report[] }).steps;

  it('runs every step of the plan', () => {
    expect(result.rejected).toBeUndefined();
    expect(steps.map((step) => step.ok)).toEqual(steps.map(() => true));
    expect(steps.map((step) => step.command)).toEqual([
      'create_material',
      'add_material_model',
      'add_material_model',
      'add_material_model',
      'define_constitutive_set',
      'define_constitutive_set',
      'material_point_response',
      'material_point_response',
      'check_material_models',
      'export_material_cards',
    ]);
    expect(result.document.materials['nl1_steel']?.defaultConstitutiveSet).toBe('iso_hardening');
  });

  it('reproduces the reference values at N = 10 (point 7 of the CLI harness: rows[-2])', () => {
    const [perfect, hardening] = steps.filter((step) => step.command === 'material_point_response').map((step) => step.data as PointData);
    expectCase(PACK, 'VC-MATL-01/perfect/point7(0.0,0.25)e-4/N10', perfect?.rows.at(-2)?.vonMises ?? Number.NaN);
    expectCase(PACK, 'VC-MATL-02/isotropicH62500/point7(0.0,0.25)e-4/N10', hardening?.rows.at(-2)?.vonMises ?? Number.NaN);
    expectCase(PACK, 'VC-MATL-02/isotropicH62500/point3(0.5,0.25)e-4/N10', hardening?.rows[2]?.vonMises ?? Number.NaN);
    expect(perfect?.unverified).toBe(true);
  });

  it('checks the material for CalculiX and exports the default set', () => {
    const check = steps.find((step) => step.command === 'check_material_models')?.data as { status: string; items: { code: string }[] };
    expect(check.status).toBe('pass');
    const cards = steps.find((step) => step.command === 'export_material_cards')?.data as { lines: string[] };
    expectCase(PACK, 'VC-MATL-13/ccx/plasticLinearIsotropic', cards.lines);
  });

  it('is rolled back as a whole when a step fails', () => {
    const broken = actions.map((action, i) =>
      i === 3 ? { ...action, params: { ...action.params, model: { kind: 'no_such_law' } } } : action,
    );
    const failed = execute(createEmptyDocument(), 'build_project', { actions: broken });
    expect(failed.document.materials['nl1_steel']).toBeUndefined();
  });
});
