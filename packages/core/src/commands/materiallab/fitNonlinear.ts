/** Non-linear branch of fit_material_model (PHY-02 §5.7, V2): Levenberg-Marquardt fits with start, bounds, convergence report and refusals. */

import { druckerScan } from '../../model/materialLaws/drucker';
import type { FitSummary } from '../../model/materialLaws/fit';
import type { ConvergenceReport, FitControl } from '../../model/materialLaws/fitSearch';
import { fitArrudaBoyce, fitOgden } from '../../model/materialLaws/fitHyperNonlinear';
import { fitChaboche, fitGarofalo, fitPronyFreeTau, fitRambergOsgoodTrue, fitVoce } from '../../model/materialLaws/fitLawsNonlinear';
import type { NonlinearBase } from '../../model/materialLaws/fitCommon';
import type { ResolvedHyper } from '../../model/materialLaws/hyperelastic';
import { isLawFailure, type LawFailure } from '../../model/materialLaws/resolve';
import { druckerIssues } from '../../model/materialLaws/validateHyper';
import type { MaterialValidRange } from '../../model/materialModel';
import type { NamedDefault } from '../../model/propertyModelEval';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { fixedStress, hyperTests, isRefusal, pairs, quantityOf, refuse, stressIn, stressRows } from './fitInputs';
import type { FitParams } from './fitSchema';

export interface NonlinearParts {
  readonly model: Record<string, unknown>;
  readonly summary: FitSummary;
  readonly perTest: readonly object[];
  readonly range: MaterialValidRange;
  readonly stability: unknown;
  readonly warnings: { code: string; message: string }[];
  readonly defaults: NamedDefault[];
  readonly convergence: ConvergenceReport;
  readonly residualUnit: string;
}

/** True when the request is solved by Levenberg-Marquardt (the rest of fit_material_model is linear in its parameters). */
export const isNonlinearRequest = (params: FitParams): boolean =>
  ['hyper_ogden', 'hyper_arruda_boyce', 'j2_voce', 'j2_chaboche', 'creep_garofalo'].includes(params.kind) ||
  (params.kind === 'visco_prony' && params.fixed?.['tau'] === undefined) ||
  (params.kind === 'ramberg_osgood' && params.form === 'true_stress');

const control = (params: FitParams): FitControl => ({ start: params.start, bounds: params.bounds });

const failed = (doc: CadDocument, failure: LawFailure): CommandResult =>
  refuse(doc, failure.code, failure.message, failure.path, failure.remediation);

function termCount(doc: CadDocument, params: FitParams, max: number): number | CommandResult {
  const terms = params.terms;
  return terms === undefined || terms < 1 || terms > max
    ? refuse(doc, 'MATL_LAW_PARAMS_INVALID', `${params.kind} needs terms between 1 and ${max}`, 'terms', `give terms (1-${max})`)
    : terms;
}

function finish(
  fit: NonlinearBase,
  extra: { stability: unknown; warnings?: { code: string; message: string }[]; defaults?: NamedDefault[]; residualUnit: string },
): NonlinearParts {
  const warnings = [...(extra.warnings ?? []), ...(fit.notes ?? [])];
  for (const parameter of fit.convergence.parameters)
    if (parameter.atBound)
      warnings.push({
        code: 'MATL_FIT_PARAMETER_AT_BOUND',
        message: `${parameter.name} = ${parameter.value} sits on a bound [${parameter.lower}, ${parameter.upper}]: widen it, or the data may not need this term`,
      });
  return {
    model: fit.law,
    summary: fit.summary,
    perTest: fit.perTest,
    range: fit.range,
    stability: extra.stability,
    warnings,
    defaults: extra.defaults ?? [],
    convergence: fit.convergence,
    residualUnit: extra.residualUnit,
  };
}

/** Stability block of a fitted hyperelastic law: Drucker scan, initial shear modulus, issues against the validity. */
function hyperStability(
  doc: CadDocument,
  params: FitParams,
  resolved: ResolvedHyper,
  range: MaterialValidRange,
): CommandResult | { stability: unknown; warnings: { code: string; message: string }[] } {
  if (!(resolved.shearModulus > 0))
    return refuse(
      doc,
      'MATL_HYPERELASTIC_INITIAL_MODULUS',
      `the fitted initial shear modulus ${resolved.shearModulus} MPa is not > 0`,
      'model',
      'use more modes of data, positive terms (positive: true) or another law',
    );
  const scan = druckerScan(resolved);
  const warnings = druckerIssues(scan, params.validity === undefined ? [range] : (params.validity as MaterialValidRange[])).map(
    (issue) => ({ code: issue.code, message: `${issue.severity}: ${issue.message}` }),
  );
  return { stability: { drucker: scan, shearModulus: resolved.shearModulus }, warnings };
}

function hyperFit(doc: CadDocument, params: FitParams, objective: 'absolute' | 'relative'): NonlinearParts | CommandResult {
  const tests = hyperTests(doc, params.tests);
  if (!Array.isArray(tests)) return tests;
  const defaults: NamedDefault[] = [
    { name: 'compressibility', value: 0, source: 'D = 0 (incompressible); fit to incompressible nominal-stress modes', defaulted: true },
  ];
  let fit;
  if (params.kind === 'hyper_ogden') {
    const terms = termCount(doc, params, 3);
    if (typeof terms !== 'number') return terms;
    const positive = params.positive ?? true;
    if (params.positive === undefined)
      defaults.push({ name: 'positive', value: true, source: 'llull choice: every Ogden shear term μ_i ≥ 0', defaulted: true });
    fit = fitOgden(terms, tests, objective, positive, control(params));
  } else fit = fitArrudaBoyce(tests, objective, control(params));
  if (isLawFailure(fit)) return failed(doc, fit);
  const stability = hyperStability(doc, params, fit.resolved, fit.range);
  if (isRefusal(stability)) return stability;
  const warnings = [...stability.warnings];
  if (new Set(tests.map((test) => test.mode)).size === 1)
    warnings.push({
      code: 'MATL_FIT_INSUFFICIENT_MODES',
      message: `hyperelastic fit from one mode (${tests[0]?.mode}): add equibiaxial / planar data`,
    });
  return finish(fit, { stability: stability.stability, warnings, defaults, residualUnit: 'MPa' });
}

function pronyFit(doc: CadDocument, params: FitParams): NonlinearParts | CommandResult {
  const terms = termCount(doc, params, 20);
  if (typeof terms !== 'number') return terms;
  const test = params.tests[0];
  const xUnit = test?.units?.['x'];
  const yUnit = test?.units?.['y'];
  const rows = test === undefined ? 'tests' : pairs(test, 0);
  if (test === undefined || params.tests.length !== 1 || test.mode !== 'relaxation')
    return refuse(doc, 'MATL_LAW_PARAMS_INVALID', "visco_prony takes ONE test with mode 'relaxation'", 'tests');
  if (typeof rows === 'string' || xUnit === undefined || yUnit === undefined)
    return refuse(
      doc,
      'MATL_LAW_PARAMS_INVALID',
      'rows must be finite [time, modulus] pairs with units.x (time) and units.y (modulus)',
      'tests[0]',
    );
  const timed: [number, number][] = [];
  for (const [t, modulus] of rows) {
    const seconds = stressIn(t, xUnit, 's');
    const mpa = stressIn(modulus, yUnit, 'MPa');
    if (seconds === null || mpa === null || seconds < 0)
      return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'bad time or modulus unit', 'tests[0].units');
    timed.push([seconds, mpa]);
  }
  const fixedG0 = quantityOf(params.fixed?.['G0']);
  const G0 = timed.find(([t]) => t === 0)?.[1] ?? (fixedG0 === null ? null : stressIn(fixedG0.value, fixedG0.unit, 'MPa'));
  if (G0 === null || !(G0 > 0)) return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'include the row t = 0 or give fixed.G0', 'fixed.G0');
  const fit = fitPronyFreeTau(
    timed.filter(([t]) => t > 0),
    G0,
    terms,
    test.weight ?? 1,
    control(params),
  );
  if (isLawFailure(fit)) return failed(doc, fit);
  return finish(fit, { stability: { note: 'Prony weights g_i > 0 and Σ g_i < 1 hold; relaxation times were fitted' }, residualUnit: '1' });
}

function rambergFit(doc: CadDocument, params: FitParams): NonlinearParts | CommandResult {
  const data = stressRows(doc, params.tests, 'uniaxial_plastic', 'ramberg_osgood');
  if (isRefusal(data)) return data;
  const E = fixedStress(doc, params.fixed, 'E');
  if (typeof E !== 'number') return E;
  const sigma0 = fixedStress(doc, params.fixed, 'sigma0');
  if (typeof sigma0 !== 'number')
    return refuse(
      doc,
      'MATL_LAW_PARAMS_INVALID',
      'the true-stress form needs fixed.sigma0 {value, unit} (it is degenerate with α)',
      'fixed.sigma0',
    );
  const nu = quantityOf(params.fixed?.['nu']);
  if (nu === null) return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'give fixed.nu as {value, unit}', 'fixed.nu');
  // rows are [total strain, true stress]: stressRows returned [x, MPa]
  const fit = fitRambergOsgoodTrue(data.rows, E, nu.value, sigma0, data.weight, control(params));
  if (isLawFailure(fit)) return failed(doc, fit);
  return finish(fit, { stability: { note: 'monotonic deformation theory: valid for proportional loading only' }, residualUnit: '1' });
}

function hardeningFit(doc: CadDocument, params: FitParams): NonlinearParts | CommandResult {
  const data = stressRows(doc, params.tests, 'uniaxial_plastic', params.kind);
  if (isRefusal(data)) return data;
  let fit;
  if (params.kind === 'j2_voce') fit = fitVoce(data.rows, data.weight, control(params));
  else {
    const terms = termCount(doc, params, 10);
    if (typeof terms !== 'number') return terms;
    const yieldStress = fixedStress(doc, params.fixed, 'yieldStress');
    if (typeof yieldStress !== 'number') return yieldStress;
    fit = fitChaboche(data.rows, yieldStress, terms, data.weight, control(params));
  }
  if (isLawFailure(fit)) return failed(doc, fit);
  return finish(fit, { stability: { note: 'uniaxial monotonic fit; check against a cyclic test' }, residualUnit: 'MPa' });
}

function garofaloFit(doc: CadDocument, params: FitParams): NonlinearParts | CommandResult {
  const test = params.tests[0];
  if (test === undefined || params.tests.length !== 1 || test.mode !== 'creep_rate')
    return refuse(doc, 'MATL_LAW_PARAMS_INVALID', "creep_garofalo takes ONE test with mode 'creep_rate'", 'tests');
  const units = test.units;
  if (units?.['x'] === undefined || units['T'] === undefined || units['y'] === undefined)
    return refuse(
      doc,
      'MATL_LAW_PARAMS_INVALID',
      "give units { x: stress unit, T: temperature unit, y: rate unit } (e.g. 'MPa', 'K', '1/s')",
      'tests[0].units',
    );
  const rows: [number, number, number][] = [];
  for (const [j, row] of test.rows.entries()) {
    const [stress, T, rate] = row;
    const values =
      row.length === 3 && stress !== undefined && T !== undefined && rate !== undefined
        ? [stressIn(stress, units['x'], 'MPa'), stressIn(T, units['T'], 'K'), stressIn(rate, units['y'], '1/s')]
        : null;
    if (values === null || values.some((value) => value === null || !(value > 0)))
      return refuse(
        doc,
        'MATL_LAW_PARAMS_INVALID',
        'rows are [stress, temperature, rate], all finite > 0 with convertible units',
        `tests[0].rows[${j}]`,
      );
    rows.push(values as [number, number, number]);
  }
  const energy = quantityOf(params.fixed?.['activationEnergy']);
  const fixedEnergy = energy === null ? null : stressIn(energy.value, energy.unit, 'J/mol');
  if (energy !== null && fixedEnergy === null)
    return refuse(
      doc,
      'MATL_LAW_PARAMS_INVALID',
      `fixed.activationEnergy '${energy.unit}' is not an energy per mole`,
      'fixed.activationEnergy',
    );
  const fit = fitGarofalo(rows, fixedEnergy, test.weight ?? 1, control(params));
  if (isLawFailure(fit)) return failed(doc, fit);
  return finish(fit, { stability: { note: 'steady-state creep rate fit on ln(rate)' }, residualUnit: 'ln(1/s)' });
}

/**
 * Levenberg-Marquardt fit of the requested law.
 * @failure bad rows / units / terms -> MATL_LAW_PARAMS_INVALID; start or bounds -> MATL_FIT_START_INVALID; no convergence ->
 *   MATL_FIT_DID_NOT_CONVERGE; singular Jacobian -> MATL_FIT_ILL_CONDITIONED; Σ g ≥ 1 -> MATL_PRONY_INVALID; initial shear modulus ≤ 0 ->
 *   MATL_HYPERELASTIC_INITIAL_MODULUS
 */
export function nonlinearFit(doc: CadDocument, params: FitParams, objective: 'absolute' | 'relative'): NonlinearParts | CommandResult {
  switch (params.kind) {
    case 'hyper_ogden':
    case 'hyper_arruda_boyce':
      return hyperFit(doc, params, objective);
    case 'visco_prony':
      return pronyFit(doc, params);
    case 'ramberg_osgood':
      return rambergFit(doc, params);
    case 'creep_garofalo':
      return garofaloFit(doc, params);
    default:
      return hardeningFit(doc, params);
  }
}
