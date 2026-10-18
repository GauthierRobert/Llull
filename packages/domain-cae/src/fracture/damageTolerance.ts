/** compute_crack_growth / compute_residual_strength / compute_inspection_interval / check_damage_tolerance (PHY-08 FR-FRC-05..16). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CrackGrowthCase } from '@core/model/durability';
import type { CadDocument } from '@core/model/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { quantitySchema } from '../shared/schemas';
import { crackOf, growthCaseOf } from '../fatigue/store';
import { item, REVIEW_NOTE, statusOfItems, type Item } from '../fatigue/items';
import { refuseFracture } from './codes';
import { criticalSizes, growthLife } from './integrate';
import { betaOf, netYieldStress, sizeLimit, solvedGeometry, withSize } from './kSolutions';
import { isFailure, resolveGrowth, type GrowthSetup } from './setup';

const caseIdSchema = z.string().describe('Crack-growth case id (affected[0] of create_crack_growth_case).');

function setupOf(doc: CadDocument, command: string, caseId: string): { case: CrackGrowthCase; setup: GrowthSetup } | CommandResult {
  const growthCase = growthCaseOf(doc, caseId);
  if (growthCase === undefined)
    return refuseFracture(doc, command, 'FRC_CASE_NOT_FOUND', `no crack-growth case '${caseId}'`, [caseId], ['caseId']);
  const setup = resolveGrowth(doc, growthCase);
  if (isFailure(setup)) return refuseFracture(doc, command, setup.code, setup.message, setup.ids, ['caseId']);
  return { case: growthCase, setup };
}

const isResult = (value: unknown): value is CommandResult => typeof value === 'object' && value !== null && 'summary' in value;

const unverifiedItem = (setup: GrowthSetup): Item[] =>
  setup.unverifiedReasons.length === 0
    ? []
    : [item('FRC_DATA_UNVERIFIED', 'warning', setup.unverifiedReasons.join('; '), 'use verified, sourced data')];

/**
 * @affects nothing; read-only, data { lifeCycles, lifeBlocks, stopReason, aFinalM, aCriticalM, aNetYieldM, curve[{N, aM, KmaxMPaSqrtM}], items, unverified, reviewRequired: true }
 * @invariant constant amplitude with Y = 1 reproduces N = (a0^(1-m/2) - af^(1-m/2)) / (C (m/2 - 1) (ds sqrt(pi))^m); stops at the first of target, K = Kc, net-section yield, K-solution limit, 1e8 cycles
 * @failure unknown case -> FRC_CASE_NOT_FOUND; unresolved crack / models / histories -> their FRC_* code; aInitial beyond the K-solution limit -> FRC_K_SOLUTION_OUT_OF_RANGE;
 *   K >= Kc at aInitial -> life 0 with item FRC_INITIAL_CRITICAL (unchanged doc)
 */
export const computeCrackGrowth = defineCommand({
  name: 'compute_crack_growth',
  annotations: { readOnly: true },
  description:
    'Integrate crack growth of a case from aInitial to the first stop: aTarget, fracture (Kmax = Kc at the residual stress), net-section yield (needs Fty on the record) or the K-solution limit, ' +
    'with the growth law of the case (blocks of stress cycles, no retardation, adaptive Simpson in ln a). Returns data { lifeCycles, lifeBlocks, stopReason fracture | net_section_yield | target | ' +
    'geometry_limit | runout | arrest | initial_critical, aFinalM, aCriticalM, aNetYieldM, curve[{ N cycles, aM, KmaxMPaSqrtM }] (samples points), items[], unverified, reviewRequired }. ' +
    'Results are not approved: a qualified engineer must review. Example: centre crack, C 1e-11, m 3, 0-100 MPa, 1 -> 10 mm gives 776 634 cycles.',
  params: z.object({
    caseId: caseIdSchema,
    samples: z.number().int().optional().describe('Number of curve segments (2..2000, default 200).'),
  }),
  run: (doc, params): CommandResult => {
    const resolved = setupOf(doc, 'compute_crack_growth', params.caseId);
    if (isResult(resolved)) return resolved;
    const { setup } = resolved;
    const samples = Math.min(Math.max(params.samples ?? 200, 2), 2000);
    if (setup.a0 > sizeLimit(setup.geometry))
      return refuseFracture(
        doc,
        'compute_crack_growth',
        'FRC_K_SOLUTION_OUT_OF_RANGE',
        'aInitial is beyond the validity of the K solution',
        [setup.crack.id],
        ['growth.aInitial'],
      );
    const life = growthLife(setup, setup.a0, samples);
    const critical = criticalSizes(setup);
    const items: Item[] = [...unverifiedItem(setup)];
    if (life.stopReason === 'initial_critical')
      items.push(
        item('FRC_INITIAL_CRITICAL', 'fail', 'Kmax >= Kc (or net-section yield) at aInitial', 'smaller flaw or redesign', [params.caseId]),
      );
    if (life.stopReason === 'runout') items.push(item('FRC_RUNOUT', 'info', 'no stop within 1e8 cycles', '', [params.caseId]));
    if (life.extrapolated)
      items.push(
        item(
          'FRC_RATE_EXTRAPOLATED',
          'warning',
          'dK or R outside the data range of the growth model',
          'extend the data or accept as indicative',
          [params.caseId],
        ),
      );
    if (setup.fty === null)
      items.push(
        item(
          'FRC_NET_SECTION_NOT_CHECKED',
          'info',
          'no Fty on the record: net-section yield was not checked',
          'set_material_property Fty',
          [params.caseId],
        ),
      );
    return report(
      doc,
      `compute_crack_growth ${params.caseId}: ${life.lifeCycles.toPrecision(9)} cycles from ${(setup.a0 * 1000).toPrecision(5)} to ${(life.aFinalM * 1000).toPrecision(6)} mm, stop: ${life.stopReason}${setup.unverifiedReasons.length > 0 ? ', UNVERIFIED data' : ''}. ${REVIEW_NOTE}`,
      {
        caseId: params.caseId,
        lifeCycles: life.lifeCycles,
        lifeBlocks: life.lifeBlocks,
        cyclesPerBlock: setup.cyclesPerBlock,
        stopReason: life.stopReason,
        aInitialM: setup.a0,
        aFinalM: life.aFinalM,
        aCriticalM: critical.fracture,
        aNetYieldM: critical.netYield,
        KcMPaSqrtM: setup.kc,
        curve: life.curve,
        items,
        unverified: setup.unverifiedReasons.length > 0,
        unverifiedReasons: setup.unverifiedReasons,
        reviewRequired: true,
      },
    );
  },
});

const sizeList = z.array(quantitySchema).describe('Crack sizes { value, unit } to evaluate (centre: half-length; edge: depth).');

/**
 * @affects nothing; read-only, data { curve[{ aM, sigmaKMPa, sigmaNetYieldMPa, residualMPa, governing }], aCriticalM, aNetYieldM, governing, items, reviewRequired: true }
 * @invariant sigma_K(a) = Kc / (beta sqrt(pi a)); sigma_ny = Fty (1 - 2a/W) (centre) or Fty (1 - a/b) (edge); residual = min; a_crit by bisection to 1e-12 m
 * @failure unknown case -> FRC_CASE_NOT_FOUND; a size beyond the K-solution limit -> FRC_K_SOLUTION_OUT_OF_RANGE; a bad size -> FRC_PARAMS_INVALID (unchanged doc)
 */
export const computeResidualStrength = defineCommand({
  name: 'compute_residual_strength',
  annotations: { readOnly: true },
  description:
    'Residual strength of the cracked part for a case: at each crack size the lower of the fracture stress Kc / (beta sqrt(pi a)) and the net-section yield stress Fty (1 - 2a/W) (Fty from the record; omitted when missing). ' +
    'Also returns the critical sizes at `stress` (default: the case residualStrengthStress, else the peak history stress): aCriticalM (K = Kc) and aNetYieldM. ' +
    'Example: centre crack W 200 mm, Kc 60, Fty 300: a = 20 mm gives 233.43 MPa (fracture), a = 10 mm gives 270 MPa (net-section yield).',
  params: z.object({
    caseId: caseIdSchema,
    sizes: sizeList.optional().describe('Crack sizes to evaluate (default: 20 sizes from aInitial to the K-solution limit).'),
    stress: quantitySchema
      .optional()
      .describe('Stress at which the critical sizes are computed (default: residualStrengthStress of the case, else peak history stress).'),
  }),
  run: (doc, params): CommandResult => {
    const resolved = setupOf(doc, 'compute_residual_strength', params.caseId);
    if (isResult(resolved)) return resolved;
    const { setup } = resolved;
    const fail = (message: string, code = 'FRC_PARAMS_INVALID', path = 'sizes'): CommandResult =>
      refuseFracture(doc, 'compute_residual_strength', code, message, [params.caseId], [path]);
    let stressSetup = setup;
    if (params.stress !== undefined) {
      const converted = convertValue(params.stress.value, params.stress.unit, 'MPa');
      if (isUnitFailure(converted) || !(converted.value > 0)) return fail('stress must be a stress > 0', 'FRC_PARAMS_INVALID', 'stress');
      stressSetup = { ...setup, residualStress: converted.value };
    }
    const limit = sizeLimit(setup.geometry);
    const sizes: number[] = [];
    for (const quantity of params.sizes ?? []) {
      const converted = convertValue(quantity.value, quantity.unit, 'm');
      if (isUnitFailure(converted) || !(converted.value > 0)) return fail(`size ${quantity.value} ${quantity.unit} must be a length > 0`);
      if (converted.value > limit)
        return fail(
          `size ${quantity.value} ${quantity.unit} is beyond the validity of the K solution (${(limit * 1000).toPrecision(5)} mm)`,
          'FRC_K_SOLUTION_OUT_OF_RANGE',
        );
      sizes.push(converted.value);
    }
    if (params.sizes === undefined) for (let i = 0; i < 20; i += 1) sizes.push(setup.a0 + ((limit - setup.a0) * i) / 19);
    const curve = sizes.map((a) => {
      const geometry = withSize(setup.geometry, a);
      const sigmaK = setup.kc / (betaOf(geometry) * Math.sqrt(Math.PI * a));
      const ny = setup.fty === null ? null : netYieldStress(geometry, a, setup.fty);
      const residual = ny === null ? sigmaK : Math.min(sigmaK, ny);
      return {
        aM: a,
        sigmaKMPa: sigmaK,
        sigmaNetYieldMPa: ny,
        residualMPa: residual,
        governing: ny !== null && ny < sigmaK ? 'net_section_yield' : 'fracture',
      };
    });
    const critical = criticalSizes(stressSetup);
    const governingSize = [critical.fracture, critical.netYield, critical.limit]
      .filter((value): value is number => value !== null)
      .reduce((a, b) => Math.min(a, b));
    const governing =
      critical.netYield !== null && critical.netYield <= (critical.fracture ?? Number.POSITIVE_INFINITY)
        ? 'net_section_yield'
        : critical.fracture !== null
          ? 'fracture'
          : 'geometry_limit';
    const items = unverifiedItem(setup);
    return report(
      doc,
      `compute_residual_strength ${params.caseId}: ${curve.length} size(s); at ${critical.stress} MPa a_crit (K = Kc) = ${critical.fracture === null ? 'none' : `${(critical.fracture * 1000).toPrecision(8)} mm`}, net-section yield at ${critical.netYield === null ? 'n/a' : `${(critical.netYield * 1000).toPrecision(8)} mm`}; governing ${governing}. ${REVIEW_NOTE}`,
      {
        caseId: params.caseId,
        stressMPa: critical.stress,
        curve,
        aCriticalM: critical.fracture,
        aNetYieldM: critical.netYield,
        aGoverningM: governingSize,
        governing,
        items,
        reviewRequired: true,
      },
    );
  },
});

/**
 * @affects nothing; read-only, data { thresholdCycles?, intervalCycles, intervalBlocks, aCriticalM, factors { scatterInterval, scatterThreshold? }, items, reviewRequired: true }
 * @invariant interval = N(aDetectable -> a_crit) / scatterInterval; threshold = N(aInitial -> a_crit) / scatterThreshold (only when that factor is set); no factor is defaulted
 * @failure unknown case -> FRC_CASE_NOT_FOUND; no scatterInterval -> FRC_SCATTER_FACTOR_UNSET; no aDetectable -> FRC_DETECTABLE_SIZE_UNSET (unchanged doc)
 */
export const computeInspectionInterval = defineCommand({
  name: 'compute_inspection_interval',
  annotations: { readOnly: true },
  description:
    'Inspection interval of a crack-growth case: life from the detectable size (growth.aDetectable) to the critical size at the residual stress, divided by the scatterInterval factor ' +
    '(set_damage_tolerance_factors; NO default). With scatterThreshold set, also the inspection threshold = life from aInitial to critical / scatterThreshold. ' +
    'Returns data { intervalCycles, intervalBlocks, thresholdCycles, aCriticalM, factors, items, reviewRequired }. Results are not approved: a qualified engineer must review.',
  params: z.object({ caseId: caseIdSchema }),
  run: (doc, params): CommandResult => {
    const resolved = setupOf(doc, 'compute_inspection_interval', params.caseId);
    if (isResult(resolved)) return resolved;
    const { setup, case: growthCase } = resolved;
    const { scatterInterval, scatterThreshold } = growthCase.factors;
    if (scatterInterval === undefined)
      return refuseFracture(
        doc,
        'compute_inspection_interval',
        'FRC_SCATTER_FACTOR_UNSET',
        'no scatterInterval factor on the case',
        [params.caseId],
        ['factors.scatterInterval'],
      );
    if (setup.aDetectable === null)
      return refuseFracture(
        doc,
        'compute_inspection_interval',
        'FRC_DETECTABLE_SIZE_UNSET',
        'no growth.aDetectable on the case',
        [params.caseId],
        ['growth.aDetectable'],
      );
    const open = { ...setup, aTarget: null };
    const interval = growthLife(open, setup.aDetectable, 200);
    const threshold = scatterThreshold === undefined ? null : growthLife(open, setup.a0, 200);
    const critical = criticalSizes(setup);
    const items = unverifiedItem(setup);
    items.push(
      item('FRC_DISPOSITION_PENDING', 'warning', 'interval is not accepted by a reviewer', 'reviewer acceptance in the desktop app', [
        params.caseId,
      ]),
    );
    if (scatterThreshold === undefined)
      items.push(
        item(
          'FRC_SCATTER_FACTOR_UNSET',
          'info',
          'no scatterThreshold: threshold not computed',
          'set_damage_tolerance_factors scatterThreshold',
          [params.caseId],
        ),
      );
    return report(
      doc,
      `compute_inspection_interval ${params.caseId}: interval ${(interval.lifeCycles / scatterInterval.value).toPrecision(9)} cycles (life ${interval.lifeCycles.toPrecision(9)} from ${(setup.aDetectable * 1000).toPrecision(5)} mm to ${(interval.aFinalM * 1000).toPrecision(6)} mm / scatter factor ${scatterInterval.value} (${scatterInterval.source}))${threshold === null ? '' : `, threshold ${(threshold.lifeCycles / (scatterThreshold?.value ?? 1)).toPrecision(9)} cycles`}. ${REVIEW_NOTE}`,
      {
        caseId: params.caseId,
        intervalCycles: interval.lifeCycles / scatterInterval.value,
        intervalBlocks: interval.lifeBlocks / scatterInterval.value,
        lifeFromDetectableCycles: interval.lifeCycles,
        thresholdCycles: threshold === null || scatterThreshold === undefined ? null : threshold.lifeCycles / scatterThreshold.value,
        aCriticalM: critical.fracture,
        stopReason: interval.stopReason,
        factors: {
          scatterInterval: { ...scatterInterval, defaulted: false },
          scatterThreshold: scatterThreshold === undefined ? null : { ...scatterThreshold, defaulted: false },
        },
        items,
        unverified: setup.unverifiedReasons.length > 0,
        reviewRequired: true,
        disposition: 'pending',
      },
    );
  },
});

/**
 * @affects nothing; read-only, data { caseId, status pass | warn | fail, items[{ code, severity, ids, message, remediation }], reviewRequired: true }
 * @failure unknown case -> FRC_CASE_NOT_FOUND (unchanged doc); problems are items, not exceptions
 */
export const checkDamageTolerance = defineCommand({
  name: 'check_damage_tolerance',
  annotations: { readOnly: true },
  description:
    'Readiness / review check of a crack-growth case: models and histories resolve, data verified, scatter factors set, detectable size given, K at aInitial below Kc, growth rates inside the data range, ' +
    'marginal band set, disposition pending. Returns data { status pass | warn | fail, items[{ code, severity, ids, message, remediation }], reviewRequired: true }. Run it last.',
  params: z.object({ caseId: caseIdSchema }),
  run: (doc, params): CommandResult => {
    const growthCase = growthCaseOf(doc, params.caseId);
    if (growthCase === undefined)
      return refuseFracture(
        doc,
        'check_damage_tolerance',
        'FRC_CASE_NOT_FOUND',
        `no crack-growth case '${params.caseId}'`,
        [params.caseId],
        ['caseId'],
      );
    const items: Item[] = [];
    const setup = resolveGrowth(doc, growthCase);
    if (isFailure(setup)) items.push(item(setup.code, 'error', setup.message, 'see create_crack_growth_case', setup.ids));
    else {
      items.push(...unverifiedItem(setup));
      const life = growthLife(setup, setup.a0, 40);
      if (life.stopReason === 'initial_critical')
        items.push(item('FRC_INITIAL_CRITICAL', 'fail', 'Kmax >= Kc at aInitial', 'smaller flaw or redesign', [params.caseId]));
      if (life.extrapolated)
        items.push(
          item(
            'FRC_RATE_EXTRAPOLATED',
            'warning',
            'dK or R outside the data range of the growth model',
            'extend the data or accept as indicative',
            [params.caseId],
          ),
        );
      if (setup.aDetectable === null)
        items.push(
          item('FRC_DETECTABLE_SIZE_UNSET', 'warning', 'no detectable size: no inspection interval', 'give growth.aDetectable', [
            params.caseId,
          ]),
        );
      const crack = crackOf(doc, growthCase.crackId);
      const solved = crack === undefined ? null : solvedGeometry(crack.geometry);
      if (solved !== null && typeof solved !== 'string' && setup.a0 > sizeLimit(solved))
        items.push(
          item('FRC_K_SOLUTION_OUT_OF_RANGE', 'error', 'aInitial is beyond the validity of the K solution', 'use another geometry', [
            params.caseId,
          ]),
        );
    }
    if (growthCase.factors.scatterInterval === undefined)
      items.push(
        item(
          'FRC_SCATTER_FACTOR_UNSET',
          'error',
          'no scatterInterval factor',
          'set_damage_tolerance_factors scatterInterval={value, source} (ask the owner)',
          [params.caseId],
        ),
      );
    if (growthCase.factors.marginalBand === undefined)
      items.push(item('FRC_MARGINAL_BAND_UNSET', 'warning', 'no marginal band set', 'owner / company rule', [params.caseId]));
    items.push(
      item(
        'FRC_DISPOSITION_PENDING',
        'warning',
        'interval / threshold not accepted by a reviewer',
        'reviewer acceptance in the desktop app',
        [params.caseId],
      ),
    );
    const status = statusOfItems(items);
    return report(
      doc,
      `check_damage_tolerance ${params.caseId}: ${status}, ${items.length} item(s) [${items.map((entry) => entry.code).join(', ')}]. ${REVIEW_NOTE}`,
      { caseId: params.caseId, status, items, reviewRequired: true },
    );
  },
});
