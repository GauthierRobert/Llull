/**
 * fit_material_model (PHY-02 §5.7): fits of constitutive laws to test data — linear in the parameters (exact QR) or by Levenberg-Marquardt
 * (Ogden, Arruda-Boyce, Prony with free times, Ramberg-Osgood true stress, Voce, Chaboche, Garofalo); returns a model, never edits the document.
 */

import { canonicalJson } from '../../lib/canonicalJson';
import { sha256Hex } from '../../lib/sha256';
import type { MaterialFitRecord, MaterialValidRange } from '../../model/materialModel';
import type { NamedDefault } from '../../model/propertyModelEval';
import type { CommandResult } from '../types';
import { defineCommand } from '../schema';
import { report } from '../noop';
import { withoutUndefined } from '../document/propertyModelSchema';
import { FIT_COMMAND, refuse } from './fitInputs';
import { fitHyperelasticPolynomial, fitPronyFixedTimes, fitRambergOsgoodEngineering, type LinearParts } from './fitLinear';
import { isNonlinearRequest, nonlinearFit, type NonlinearParts } from './fitNonlinear';
import { fitParamsSchema } from './fitSchema';
import { appendAll } from '../../lib/appendAll';

const command = FIT_COMMAND;
const TOOL_LINEAR = 'llull fit_material_model (Householder QR on model rows)';
const TOOL_NONLINEAR = 'llull fit_material_model (Levenberg-Marquardt, Marquardt scaling, central-difference Jacobian)';

/**
 * @affects nothing — read-only; data { model, fit: FitRecord, validity, basis, residualsPerTest[], stability, convergence?, defaults[], warnings[] }
 * @invariant deterministic (QR without pivoting; Levenberg-Marquardt from a fixed start list); the returned model is accepted unchanged by
 *   add_material_model; the fit never attaches itself
 * @failure rows ≤ parameters -> MATL_FIT_INSUFFICIENT_DATA; condition > 1e12 QR / 1e8 LM -> MATL_FIT_ILL_CONDITIONED; no convergence ->
 *   MATL_FIT_DID_NOT_CONVERGE; bad start / bounds -> MATL_FIT_START_INVALID; Prony weights invalid -> MATL_PRONY_INVALID; bad rows / units ->
 *   MATL_LAW_PARAMS_INVALID; single hyperelastic mode -> warning MATL_FIT_INSUFFICIENT_MODES
 */
export const fitMaterialModel = defineCommand({
  name: command,
  annotations: { readOnly: true },
  description:
    'Fit a constitutive law to test data and return the model, residuals per test, its stability and (non-linear fits) a convergence report. ' +
    'Linear in the parameters (deterministic exact QR): kind hyper_neo_hooke | hyper_mooney_rivlin | hyper_yeoh | hyper_polynomial | ' +
    'hyper_reduced_polynomial (order 1-3): tests with mode uniaxial | equibiaxial | planar, rows [stretch, nominal stress], xMeasure ' +
    "'stretch', yMeasure 'nominal_stress', units { y: 'MPa' }; the Drucker stability scan is returned (MATL_HYPERELASTIC_UNSTABLE) and a " +
    "single mode warns MATL_FIT_INSUFFICIENT_MODES. kind ramberg_osgood: one test mode 'uniaxial_plastic', rows [total strain, true stress], " +
    'fixed { E, nu } (engineering form ε = σ/E + 0.002 (σ/σ0.2)^n). kind visco_prony with fixed { tau: [{value, unit}…] } (relaxation times ' +
    "fixed, weights g_i fitted): one test mode 'relaxation', rows [time, shear modulus]. " +
    'Levenberg-Marquardt (damping 1e-3 ×10 / ÷10, stop at relative cost change < 1e-12 or 500 iterations, deterministic multi-start unless ' +
    "'start' is given, 'bounds' per parameter): hyper_ogden (terms 1-3, canonical μ_i, α_i, positive μ_i by default) and hyper_arruda_boyce on the " +
    "hyperelastic tests; visco_prony without fixed.tau (terms, free times); ramberg_osgood with form 'true_stress' (E ε = σ + α (|σ|/σ0)^(n−1) σ, " +
    'fixed { E, nu, sigma0 }); j2_voce and j2_chaboche on rows [equivalent plastic strain, true stress] (chaboche: fixed.yieldStress, terms); ' +
    "creep_garofalo on mode 'creep_rate' rows [stress, temperature, rate] with units { x, T, y }. data.convergence = { converged, stop, " +
    'iterations, evaluations, starts, cost, conditionNumber, parameters[] }. Refusals: MATL_FIT_DID_NOT_CONVERGE, MATL_FIT_ILL_CONDITIONED ' +
    '(Jacobian condition > 1e8), MATL_FIT_START_INVALID. Objective absolute (default, named) or relative. Nothing is added to the document: ' +
    'pass data.model with data.validity, basis and fit to add_material_model. Output is unverified until a data source is given and a reviewer accepts it.',
  params: fitParamsSchema,
  run: (doc, params): CommandResult => {
    const defaults: NamedDefault[] = [];
    const warnings: { code: string; message: string }[] = [];
    const total = params.tests.reduce((sum, test) => sum + test.rows.length, 0);
    if (total > 10_000) return refuse(doc, 'MATL_LAW_PARAMS_INVALID', `${total} rows > 10 000`, 'tests');
    if (params.tests.length === 0) return refuse(doc, 'MATL_FIT_INSUFFICIENT_DATA', 'no tests', 'tests', 'add data');
    const objective = params.objective ?? 'absolute';
    if (params.objective === undefined)
      defaults.push({
        name: 'objective',
        value: 'absolute',
        source: 'llull choice: absolute nominal-stress residual (TECHNICAL_SPEC §5.10)',
        defaulted: true,
      });
    const basis = params.basis ?? 'unspecified';
    if (params.basis === undefined)
      defaults.push({ name: 'basis', value: 'unspecified', source: '08 FR-MAT-25: no basis given ⇒ unverified', defaulted: true });
    const userValidity: MaterialValidRange[] | undefined =
      params.validity === undefined ? undefined : withoutUndefined<MaterialValidRange[]>(params.validity);
    let method: MaterialFitRecord['method'] = 'linear_least_squares';
    let convergence: unknown;
    let parts: LinearParts | NonlinearParts | CommandResult;
    if (isNonlinearRequest(params)) {
      const nonlinear = nonlinearFit(doc, params, objective);
      if ('document' in nonlinear) return nonlinear;
      appendAll(warnings, nonlinear.warnings);
      appendAll(defaults, nonlinear.defaults);
      ({ convergence } = nonlinear);
      parts = nonlinear;
      method = 'levenberg_marquardt';
    } else if (params.kind === 'ramberg_osgood') {
      parts = fitRambergOsgoodEngineering(doc, params);
      if ('document' in parts) return parts;
    } else if (params.kind === 'visco_prony') {
      parts = fitPronyFixedTimes(doc, params);
      if ('document' in parts) return parts;
    } else {
      parts = fitHyperelasticPolynomial(doc, params, objective, userValidity, defaults, warnings);
      if ('document' in parts) return parts;
    }
    const { model, summary, perTest, range, stability, residualUnit } = parts;
    const validity = userValidity ?? [range];
    const provenance =
      params.dataSource === undefined ? undefined : withoutUndefined<NonNullable<MaterialFitRecord['dataProvenance']>>(params.dataSource);
    const fit: MaterialFitRecord = {
      method,
      objective,
      points: summary.points,
      datasetSha256: sha256Hex(canonicalJson(params.tests)),
      ...(provenance !== undefined ? { dataProvenance: provenance } : {}),
      residual: { rms: summary.rms, maxAbs: summary.maxAbs, maxRel: summary.maxRel, unit: residualUnit, rSquared: summary.rSquared },
      conditionNumber: summary.conditionNumber,
      fittedRange: [range],
      tool: method === 'levenberg_marquardt' ? TOOL_NONLINEAR : TOOL_LINEAR,
    };
    const unverifiedReasons = [
      `basis ${basis}`.replace(/^basis (A|B|S|company)$/, ''),
      provenance === undefined ? 'fit without data provenance' : '',
      'fit not reviewed',
    ].filter((reason) => reason !== '');
    return report(
      doc,
      `${command} ${params.kind}: ${summary.points} rows, RMS ${summary.rms.toPrecision(6)}, max |r| ${summary.maxAbs.toPrecision(6)}, condition ${summary.conditionNumber.toPrecision(4)}${
        convergence === undefined
          ? ''
          : `, Levenberg-Marquardt ${(convergence as { iterations: number }).iterations} iterations (${(convergence as { stop: string }).stop})`
      }; ${warnings.length} warning(s)${
        warnings.length > 0 ? ` (${[...new Set(warnings.map((w) => w.code))].join(', ')})` : ''
      }; unverified until reviewed.`,
      {
        model,
        fit,
        validity,
        basis,
        residualsPerTest: perTest,
        stability,
        ...(convergence !== undefined ? { convergence } : {}),
        defaults,
        warnings,
        unverified: true,
        unverifiedReasons,
        reviewRequired: true,
      },
    );
  },
});
