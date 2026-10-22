/**
 * VC-THM-61 through the CLI: the deliberately wrong set-up of thm_rejections.plan.json and its variants return stable codes with a
 * remediation text and ids, before any mesh or solve. Needs no mesher or ccx.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeCase, dataOf, listOf, loadPlan, openCase, type PlanStep, type ThermalCase } from './feaThermalSupport';

const SOURCE = { citation: 'test input of this validation case (not a material claim)' };

describe('thermal rejections (VC-THM-61)', () => {
  let opened: ThermalCase | undefined;
  beforeEach(async () => {
    opened = await openCase('reject');
  });
  afterEach(() => closeCase(opened));

  const plan = (): PlanStep[] => loadPlan('thm_rejections');
  const withoutStep = (name: string): PlanStep[] => plan().filter((step) => step.params['name'] !== name);
  const bcStep = (params: Record<string, unknown>): PlanStep => ({
    command: 'add_thermal_bc',
    params: { analysisId: '$an', name: 'x', target: { entityId: '$cube', facesNear: [[5, 5, 10]] }, ...params },
  });
  const upToAnalysis = (): PlanStep[] =>
    plan().slice(
      0,
      plan().findIndex((step) => step.command === 'add_thermal_bc'),
    );

  async function checkItems(steps: PlanStep[]): Promise<Record<string, unknown>[]> {
    const c = opened as ThermalCase;
    const planned = await c.runPlan(steps);
    expect(planned.code, String(planned.json['summary'])).toBe(0);
    const checked = await c.cli('check_thermal', `analysisId=${c.analysisId}`);
    return listOf(dataOf(checked.json)['items']);
  }

  async function aborted(steps: PlanStep[]): Promise<string> {
    const result = await (opened as ThermalCase).runPlan(steps);
    expect(result.code).not.toBe(0);
    return JSON.stringify(result.json);
  }

  it('the plan aborts at the radiation step with THM_EMISSIVITY_INVALID, a remediation and the analysis id', async () => {
    const text = await aborted(plan());
    expect(text).toContain('THM_EMISSIVITY_INVALID');
    expect(text).toContain('an-');
  });

  it('check_thermal lists THM_MATERIAL_NO_CP, THM_INITIAL_TEMPERATURE_MISSING and THM_NO_HEAT_PATH, each with a remediation and ids', async () => {
    const items = await checkItems(withoutStep('bad_eps'));
    const codes = items.map((item) => item['code']);
    for (const code of ['THM_MATERIAL_NO_CP', 'THM_INITIAL_TEMPERATURE_MISSING']) expect(codes).toContain(code);
    for (const item of items) {
      expect(String(item['remediation']).length).toBeGreaterThan(10);
      expect(Array.isArray(item['ids']) && item['ids'].length > 0).toBe(true);
    }
    const steady = await checkItems(
      upToAnalysis().map((step) =>
        step.command === 'create_analysis' ? { ...step, params: { ...step.params, analysisType: 'heat_steady' } } : step,
      ),
    );
    expect(steady.map((item) => item['code'])).toContain('THM_NO_HEAT_PATH');
  });

  it.each([
    [
      'THM_SOURCE_REQUIRED',
      { kind: 'film', filmCoefficient: { value: 10, unit: 'W/(m^2*K)' }, sinkTemperature: { value: 20, unit: 'degC' } },
    ],
    ['THM_UNITS_MISMATCH', { kind: 'radiation', emissivity: 0.5, sinkTemperature: { value: -300, unit: 'degC' }, source: SOURCE }],
    ['THM_EMISSIVITY_INVALID', { kind: 'radiation', emissivity: 1.2, sinkTemperature: { value: 300, unit: 'K' }, source: SOURCE }],
    [
      'THM_FILM_INVALID',
      { kind: 'film', filmCoefficient: { value: -1, unit: 'W/(m^2*K)' }, sinkTemperature: { value: 20, unit: 'degC' }, source: SOURCE },
    ],
  ])('%s is returned by add_thermal_bc', async (code, params) => {
    const text = await aborted([...upToAnalysis(), bcStep(params)]);
    expect(text).toContain(code);
    expect(text).toContain('remediation');
  });

  it('add_temperature_limit without a source returns THM_LIMIT_SOURCE_REQUIRED', async () => {
    const limit: PlanStep = {
      command: 'add_temperature_limit',
      params: { analysisId: '$an', name: 'cap', entityId: '$cube', max: { value: 100, unit: 'degC' } },
    };
    expect(await aborted([...upToAnalysis(), limit])).toContain('THM_LIMIT_SOURCE_REQUIRED');
  });
});
