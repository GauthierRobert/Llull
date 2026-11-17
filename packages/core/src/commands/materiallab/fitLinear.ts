/** The fits of fit_material_model that are linear in their parameters (or fixed-time Prony): Ramberg-Osgood engineering form, Prony with fixed times, hyperelastic polynomials. */

import { druckerScan } from '../../model/materialLaws/drucker';
import { fitHyperelastic, fitProny, fitRambergOsgood, type HyperFitKind } from '../../model/materialLaws/fit';
import { isLawFailure } from '../../model/materialLaws/resolve';
import { druckerIssues } from '../../model/materialLaws/validateHyper';
import type { MaterialValidRange } from '../../model/materialModel';
import type { NamedDefault } from '../../model/propertyModelEval';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { hyperTests, pairs, quantityOf, refuse, stressIn } from './fitInputs';
import type { NonlinearParts } from './fitNonlinear';
import type { FitParams } from './fitSchema';

const MAX_PRONY_TERMS = 20;

export type LinearParts = Pick<NonlinearParts, 'model' | 'summary' | 'perTest' | 'range' | 'stability' | 'residualUnit'>;

export function fitRambergOsgoodEngineering(doc: CadDocument, params: FitParams): LinearParts | CommandResult {
  const test = params.tests[0];
  const E = quantityOf(params.fixed?.['E']);
  const nu = quantityOf(params.fixed?.['nu']);
  if (test === undefined || params.tests.length !== 1 || test.mode !== 'uniaxial_plastic')
    return refuse(doc, 'MATL_LAW_PARAMS_INVALID', "ramberg_osgood takes ONE test with mode 'uniaxial_plastic'", 'tests');
  if (E === null || nu === null) return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'give fixed.E and fixed.nu as {value, unit}', 'fixed');
  const unit = test.units?.['y'];
  const rows = pairs(test, 0);
  const modulus = stressIn(E.value, E.unit, 'MPa');
  if (unit === undefined || typeof rows === 'string' || modulus === null)
    return refuse(
      doc,
      'MATL_LAW_PARAMS_INVALID',
      'rows must be finite [total strain, true stress] pairs with units.y and a stress unit for E',
      'tests',
    );
  const stressRows: [number, number][] = [];
  for (const [strain, stress] of rows) {
    const mpa = stressIn(stress, unit, 'MPa');
    if (mpa === null) return refuse(doc, 'MATL_LAW_PARAMS_INVALID', `'${unit}' is not a stress unit`, 'tests[0].units');
    stressRows.push([strain, mpa]);
  }
  const fit = fitRambergOsgood(stressRows, modulus, nu.value, test.weight ?? 1);
  if (isLawFailure(fit)) return refuse(doc, fit.code, fit.message, fit.path, fit.remediation);
  return {
    model: fit.law,
    summary: fit.summary,
    perTest: fit.perTest,
    residualUnit: '1',
    range: { variable: 'equivalentPlasticStrain', unit: '1', data: [0, fit.plasticStrainMax] },
    stability: { note: 'monotonic deformation theory: valid for proportional loading only' },
  };
}

export function fitPronyFixedTimes(doc: CadDocument, params: FitParams): LinearParts | CommandResult {
  const test = params.tests[0];
  const taus = Array.isArray(params.fixed?.['tau']) ? (params.fixed['tau'] as unknown[]).map(quantityOf) : [];
  if (test === undefined || params.tests.length !== 1 || test.mode !== 'relaxation')
    return refuse(doc, 'MATL_LAW_PARAMS_INVALID', "visco_prony takes ONE test with mode 'relaxation'", 'tests');
  if (taus.length > MAX_PRONY_TERMS)
    return refuse(doc, 'MATL_LAW_PARAMS_INVALID', `at most ${MAX_PRONY_TERMS} relaxation times`, 'fixed.tau');
  if (taus.length === 0 || taus.some((tau) => tau === null))
    return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'give fixed.tau as a list of {value, unit} times', 'fixed.tau');
  const tauSeconds = taus.map((tau) => (tau === null ? null : stressIn(tau.value, tau.unit, 's')));
  const rows = pairs(test, 0);
  const xUnit = test.units?.['x'];
  const yUnit = test.units?.['y'];
  if (tauSeconds.some((tau) => tau === null || !(tau > 0)) || typeof rows === 'string' || xUnit === undefined || yUnit === undefined)
    return refuse(
      doc,
      'MATL_LAW_PARAMS_INVALID',
      'rows must be finite [time, modulus] pairs with units.x (time) and units.y (modulus); every tau > 0',
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
  const initial = timed.find(([t]) => t === 0)?.[1];
  const fixedG0 = quantityOf(params.fixed?.['G0']);
  const G0 = initial ?? (fixedG0 === null ? null : stressIn(fixedG0.value, fixedG0.unit, 'MPa'));
  if (G0 === null || !(G0 > 0)) return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'include the row t = 0 or give fixed.G0', 'fixed.G0');
  const fit = fitProny(
    timed.filter(([t]) => t > 0),
    G0,
    tauSeconds as number[],
    test.weight ?? 1,
  );
  if (isLawFailure(fit)) return refuse(doc, fit.code, fit.message, fit.path, fit.remediation);
  return {
    model: fit.law,
    summary: fit.summary,
    perTest: fit.perTest,
    residualUnit: '1',
    range: { variable: 'time', unit: 's', data: [fit.timeRange[0], fit.timeRange[1]] },
    stability: { note: 'Prony weights g_i > 0 and Σ g_i < 1 hold' },
  };
}

export function fitHyperelasticPolynomial(
  doc: CadDocument,
  params: FitParams,
  objective: 'absolute' | 'relative',
  validity: MaterialValidRange[] | undefined,
  defaults: NamedDefault[],
  warnings: { code: string; message: string }[],
): LinearParts | CommandResult {
  const tests = hyperTests(doc, params.tests);
  if (!Array.isArray(tests)) return tests;
  const order =
    params.kind === 'hyper_neo_hooke' || params.kind === 'hyper_mooney_rivlin' || params.kind === 'hyper_yeoh' ? 0 : (params.order ?? 2);
  if (params.order === undefined && order > 0) defaults.push({ name: 'order', value: 2, source: 'llull choice', defaulted: true });
  if (order < 0 || order > 3 || (params.kind === 'hyper_polynomial' && order < 1))
    return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'order must be 1, 2 or 3', 'order');
  const fit = fitHyperelastic(params.kind as HyperFitKind, order, tests, objective);
  if (isLawFailure(fit)) return refuse(doc, fit.code, fit.message, fit.path, fit.remediation);
  const range: MaterialValidRange = { variable: 'stretch', unit: '1', data: [fit.stretchRange[0], fit.stretchRange[1]] };
  const scan = druckerScan(fit.resolved);
  for (const issue of druckerIssues(scan, validity ?? [range]))
    warnings.push({ code: issue.code, message: `${issue.severity}: ${issue.message}` });
  if (new Set(tests.map((test) => test.mode)).size === 1)
    warnings.push({
      code: 'MATL_FIT_INSUFFICIENT_MODES',
      message: `hyperelastic fit from one mode (${tests[0]?.mode}): add equibiaxial / planar data`,
    });
  defaults.push({
    name: 'compressibility',
    value: 0,
    source: 'D = 0 (incompressible); fit to incompressible nominal-stress modes',
    defaulted: true,
  });
  return {
    model: fit.law,
    summary: fit.summary,
    perTest: fit.perTest,
    residualUnit: 'MPa',
    range,
    stability: { drucker: scan, shearModulus: fit.resolved.shearModulus },
  };
}
