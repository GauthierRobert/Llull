/**
 * run_convergence_study with refinement dt and p through the real pipeline (PHY-00 VNV-M4): the 0.1 m block of the thermal film-table case as a
 * TRANSIENT conduction problem (k = 50, 100 degC bottom, film 100 W/(m^2 K) on top, fixed increments to 100 s) followed at the top-face probe, and the
 * 05 cantilever at orders 2 and 1. Skipped without llull-mesh / ccx. The dt study must end CURRENT with a finite order (the time integration of CalculiX is
 * what the numbers decide; no order is assumed), the order study must carry the order-difference indicator and no observed order.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeCase, dataOf, editStep, listOf, loadPlan, openCase, type PlanStep, type ThermalCase } from './feaThermalSupport';
import { feaToolsMissing } from './feaTestSupport';

function transientPlan(): PlanStep[] {
  const plan = editStep(
    loadPlan('thm_film_table'),
    'add_thermal_bc',
    { filmCoefficient: { value: 100, unit: 'W/(m^2*K)' }, filmTable: undefined },
    'top_film',
  )
    .map((step) => (step.command === 'create_analysis' ? { ...step, params: { ...step.params, analysisType: 'heat_transient' } } : step))
    .map((step) =>
      step.command === 'add_thermal_bc' && step.params['name'] === 'top_film'
        ? { ...step, params: Object.fromEntries(Object.entries(step.params).filter(([, value]) => value !== undefined)) }
        : step,
    );
  return [
    ...editStep(plan, 'set_mesh_controls', { order: 1, globalSize: 0.05 }),
    { command: 'set_initial_temperature', params: { analysisId: '$an', value: 20.0, unit: 'degC' } },
    { command: 'set_thermal_step', params: { analysisId: '$an', endTimeS: 100, initialIncrementS: 2.5, fixedIncrements: true } },
  ];
}

describe.skipIf(feaToolsMissing())('run_convergence_study dt / p (netgen + ccx)', () => {
  let opened: ThermalCase | undefined;
  beforeEach(async () => {
    opened = await openCase('kinds');
  });
  afterEach(() => closeCase(opened));

  it('a time-step study of the transient block records a CURRENT dt study at the end-of-step top-face temperature', async () => {
    const c = opened as ThermalCase;
    const planned = await c.runPlan(transientPlan());
    expect(planned.code, String(planned.json['summary'])).toBe(0);
    const probeId = Object.keys(c.document().analysis?.cases[c.analysisId]?.probes ?? {})[0] ?? '';
    const ran = await c.cli(
      'run_convergence_study',
      `analysisId=${c.analysisId}`,
      `quantity=${JSON.stringify({ kind: 'probe', probeId })}`,
      'refinement=dt',
      'finest=2.5',
      'ratio=2',
      'levels=3',
      'timeoutS=300',
    );
    expect(ran.code, String(ran.json['summary'])).toBe(0);
    expect(c.document().analysis?.cases[c.analysisId]?.thermal?.step).toEqual({
      endTimeS: 100,
      initialIncrementS: 2.5,
      fixedIncrements: true,
    });
    const checked = await c.cli('check_verification', `analysisId=${c.analysisId}`, 'gciTarget=0.05');
    const study = listOf(dataOf(checked.json)['studies'])[0];
    expect(study?.['refinement']).toBe('dt');
    expect(study?.['state']).toBe('current');
    const report = study?.['report'] as { p?: number; status: string } | undefined;
    expect(report?.status).toBeDefined();
    if (report?.p !== undefined) expect(report.p).toBeGreaterThan(0);
  }, 900_000);

  it('an element-order study of the film-table block carries the order-difference indicator and no observed order', async () => {
    const c = opened as ThermalCase;
    const planned = await c.runPlan(editStep(loadPlan('thm_film_table'), 'set_mesh_controls', { order: 1, globalSize: 0.05 }));
    expect(planned.code, String(planned.json['summary'])).toBe(0);
    const probeId = Object.keys(c.document().analysis?.cases[c.analysisId]?.probes ?? {})[0] ?? '';
    const ran = await c.cli(
      'run_convergence_study',
      `analysisId=${c.analysisId}`,
      `quantity=${JSON.stringify({ kind: 'probe', probeId })}`,
      'refinement=p',
      'timeoutS=300',
    );
    expect(ran.code, String(ran.json['summary'])).toBe(0);
    const study = listOf(dataOf((await c.cli('check_verification', `analysisId=${c.analysisId}`)).json)['studies'])[0];
    expect(study?.['refinement']).toBe('p');
    const report = study?.['report'] as { status: string; p?: number; orderPair?: { difference: { absolute: number } } } | undefined;
    expect(report?.status).toBe('order_pair');
    expect(report?.p).toBeUndefined();
    expect(report?.orderPair?.difference.absolute).toBeGreaterThanOrEqual(0);
  }, 900_000);

  it('refuses a mixed request (a time step on a steady case) and an unknown refinement, leaving the document unchanged', async () => {
    const c = opened as ThermalCase;
    const planned = await c.runPlan(editStep(loadPlan('thm_film_table'), 'set_mesh_controls', { order: 1, globalSize: 0.05 }));
    expect(planned.code).toBe(0);
    const before = JSON.stringify(c.document());
    const probeId = Object.keys(c.document().analysis?.cases[c.analysisId]?.probes ?? {})[0] ?? '';
    const quantity = `quantity=${JSON.stringify({ kind: 'probe', probeId })}`;
    const steady = await c.cli('run_convergence_study', `analysisId=${c.analysisId}`, quantity, 'refinement=dt');
    expect(steady.code).not.toBe(0);
    expect(JSON.stringify(steady.json)).toContain('VNV_CASE_UNSUPPORTED');
    const unknown = await c.cli('run_convergence_study', `analysisId=${c.analysisId}`, quantity, 'refinement=q');
    expect(unknown.code).not.toBe(0);
    expect(JSON.stringify(unknown.json)).toContain('VNV_PARAM_INVALID');
    expect(JSON.stringify(c.document())).toBe(before);
  }, 300_000);
});
