/** fit_property_model (PHY-01 §5.4): linear least-squares fit of a property law to data rows; returns a model, never edits the document. */

import { canonicalJson } from '../../lib/canonicalJson';
import { solveLeastSquares } from '../../lib/leastSquares';
import { sha256Hex } from '../../lib/sha256';
import { GAS_CONSTANT, evaluateForm, isFormFailure } from '../../model/propertyForms';
import { BASES, PROPERTY_VARIABLES, type PropertyForm, type PropertyModel } from '../../model/propertyModel';
import { modelProblem } from '../../model/propertyModelValidate';
import type { NamedDefault } from '../../model/propertyModelEval';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { formHash, refuseWith } from './propertyModels';
import { withoutUndefined } from './propertyModelSchema';

const MAX_REL_RESIDUAL = 0.05;
const MAX_CONDITION = 1e12;
const DEFAULT_DEGREE = 3;

type FitForm = 'polynomial' | 'log10Polynomial' | 'arrhenius' | 'powerLaw' | 'table1d';
type Objective = 'absolute' | 'relative' | 'log10';

const LOG_FORMS: ReadonlySet<FitForm> = new Set(['log10Polynomial', 'arrhenius', 'powerLaw']);

/** Coefficients of Σ c_k (αx + β)^k as Σ d_k x^k. */
function unscale(coefficients: readonly number[], alpha: number, beta: number): number[] {
  const result = new Array<number>(coefficients.length).fill(0);
  coefficients.forEach((c, k) => {
    let binomial = 1;
    for (let j = 0; j <= k; j += 1) {
      result[j] = (result[j] ?? 0) + c * binomial * alpha ** j * beta ** (k - j);
      binomial = (binomial * (k - j)) / (j + 1);
    }
  });
  return result;
}

const name = 'fit_property_model';

/**
 * @affects nothing — read-only; data { model (define_property_model input, unchanged), fit: FitRecord, warnings[], defaults[] }
 * @invariant validity = data range of the rows (no equation range is invented); deterministic (QR without pivoting)
 * @failure rows ≤ parameters -> PROP_FIT_INSUFFICIENT_DATA; non-finite rows, weight ≤ 0, duplicate x, y ≤ 0 for log forms ->
 *   PROP_FIT_DATA_INVALID; condition number > 1e12 after scaling -> PROP_FIT_ILL_CONDITIONED
 */
export const fitPropertyModel = defineCommand({
  name,
  annotations: { readOnly: true },
  description:
    'Fit a property law to measured rows [x, y, weight?] (at most 10 000): polynomial (degree, y vs x), log10Polynomial (NIST form, log10 y ' +
    'vs log10 x), arrhenius (ln y vs 1/T, x must be an absolute temperature), powerLaw (ln y vs ln x) or table1d (interpolating table). ' +
    'Householder QR on a scaled basis; residuals on the original y (RMS, max |r|, max |r/y|, R²); PROP_FIT_POOR above maxRelResidual ' +
    '(default 0.05). Returns a model that define_property_model accepts unchanged (validity = the data range, basis default unspecified ' +
    '⇒ unverified until a data source is given and a reviewer accepts it). Read-only.',
  params: z.object({
    data: z
      .object({
        variable: z.enum(PROPERTY_VARIABLES).describe('Independent variable, e.g. T.'),
        variableUnit: z.string().describe("Unit of x, e.g. 'K'."),
        valueUnit: z.string().describe("Unit of y, e.g. 'W/(m*K)'."),
        rows: z.array(z.array(z.number())).describe('Rows [x, y] or [x, y, weight > 0].'),
      })
      .describe('The data to fit.'),
    form: z.enum(['polynomial', 'log10Polynomial', 'arrhenius', 'powerLaw', 'table1d']).describe('Law to fit.'),
    degree: z.number().int().nonnegative().optional().describe('Polynomial degree (default 3; log10Polynomial at most 8).'),
    temperatureExponent: z.number().optional().describe('Fixed exponent m of arrhenius y = A T^m exp(−Q/(R T)) (default 0).'),
    objective: z.enum(['absolute', 'relative', 'log10']).optional().describe('Residual weighting (default: the one the form linearises).'),
    property: z.string().describe('Catalogue property of the fitted model.'),
    id: z.string().describe('Id of the fitted model.'),
    basis: z.enum(BASES).optional().describe('Basis (default unspecified ⇒ unverified).'),
    dataSource: z
      .object({
        citation: z.string().describe('Citation.'),
        locator: z.string().optional().describe('Locator.'),
        url: z.string().optional().describe('URL.'),
      })
      .optional()
      .describe('Where the rows come from (absent ⇒ unverified).'),
    maxRelResidual: z.number().positive().optional().describe('PROP_FIT_POOR threshold on max |r/y| (default 0.05).'),
  }),
  run: (doc, params): CommandResult => {
    const { rows, variable, variableUnit, valueUnit } = params.data;
    const form = params.form as FitForm;
    const defaults: NamedDefault[] = [];
    if (rows.length > 10_000) return refuseWith(doc, name, 'PROP_FIT_DATA_INVALID', `${rows.length} rows > 10 000`, [], 'data.rows');
    const seen = new Set<number>();
    for (const [i, row] of rows.entries()) {
      const [x, y, w = 1] = row;
      const bad =
        row.length < 2 || row.length > 3 || x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y) || !(w > 0)
          ? 'needs finite [x, y] and weight > 0'
          : seen.has(x)
            ? `duplicate x ${x}`
            : LOG_FORMS.has(form) && (y <= 0 || x <= 0)
              ? `${form} needs x > 0 and y > 0`
              : null;
      if (bad !== null) return refuseWith(doc, name, 'PROP_FIT_DATA_INVALID', `row ${i}: ${bad}`, [], `data.rows[${i}]`);
      seen.add(x ?? 0);
    }
    const sorted = [...rows].sort((p, q) => (p[0] ?? 0) - (q[0] ?? 0));
    const xs = sorted.map((r) => r[0] ?? 0);
    const ys = sorted.map((r) => r[1] ?? 0);
    const ws = sorted.map((r) => r[2] ?? 1);
    const degree = params.degree ?? DEFAULT_DEGREE;
    if ((form === 'polynomial' || form === 'log10Polynomial') && params.degree === undefined)
      defaults.push({ name: 'degree', value: DEFAULT_DEGREE, source: 'llull choice', defaulted: true });
    if (form === 'log10Polynomial' && degree > 8)
      return refuseWith(doc, name, 'PROP_FORM_INVALID', 'a log10Polynomial has at most 9 coefficients (degree ≤ 8)', [], 'degree');
    const parameters = form === 'table1d' ? 1 : form === 'polynomial' || form === 'log10Polynomial' ? degree + 1 : 2;
    if (rows.length <= parameters)
      return refuseWith(doc, name, 'PROP_FIT_INSUFFICIENT_DATA', `${rows.length} rows for ${parameters} parameters`, [], 'data.rows');
    const objective: Objective = params.objective ?? (form === 'polynomial' || form === 'table1d' ? 'absolute' : 'log10');
    const supported = form === 'polynomial' ? objective !== 'log10' : form === 'table1d' || objective === 'log10';
    if (!supported) {
      return refuseWith(
        doc,
        name,
        'PROP_FIT_DATA_INVALID',
        `objective ${objective} is not available for a ${form} fit (log forms fit in log space; polynomial fits absolute or relative)`,
        [],
        'objective',
      );
    }
    if (params.objective === undefined)
      defaults.push({ name: 'objective', value: objective, source: 'the objective the form linearises', defaulted: true });
    const basis = params.basis ?? 'unspecified';
    if (params.basis === undefined)
      defaults.push({
        name: 'basis',
        value: 'unspecified',
        source: '08 FR-MAT-25: no basis given ⇒ unspecified (unverified)',
        defaulted: true,
      });

    let fitted: PropertyForm;
    let conditionNumber: number | undefined;
    if (form === 'table1d') {
      fitted = { kind: 'table1d', variable, points: xs.map((x, i) => [x, ys[i] ?? 0] as const), interpolation: 'linear' };
    } else {
      const m = params.temperatureExponent ?? 0;
      const logX = form === 'log10Polynomial';
      const abscissa = xs.map((x) => (logX ? Math.log10(x) : x));
      const lo = Math.min(...abscissa);
      const hi = Math.max(...abscissa);
      const alpha = 2 / (hi - lo);
      const beta = -(hi + lo) / (hi - lo);
      const design =
        form === 'arrhenius'
          ? xs.map((t) => [1, -1 / (GAS_CONSTANT * t)])
          : form === 'powerLaw'
            ? xs.map((x) => [1, Math.log(x)])
            : abscissa.map((x) => Array.from({ length: degree + 1 }, (_, k) => (alpha * x + beta) ** k));
      const target = ys.map((y, i) =>
        form === 'arrhenius' ? Math.log(y) - m * Math.log(xs[i] ?? 1) : form === 'powerLaw' ? Math.log(y) : logX ? Math.log10(y) : y,
      );
      const weights = ws.map((w, i) => (form === 'polynomial' && objective === 'relative' ? w / (ys[i] ?? 1) ** 2 : w));
      const solution = solveLeastSquares(design, target, weights);
      conditionNumber = solution.conditionEstimate;
      if (!(conditionNumber <= MAX_CONDITION))
        return refuseWith(
          doc,
          name,
          'PROP_FIT_ILL_CONDITIONED',
          `condition number ${conditionNumber.toExponential(2)} > 1e12 after scaling`,
          [],
          'degree',
        );
      const c = solution.coefficients;
      fitted =
        form === 'arrhenius'
          ? {
              kind: 'arrhenius',
              preFactor: Math.exp(c[0] ?? 0),
              activationEnergyJPerMol: c[1] ?? 0,
              ...(m !== 0 ? { temperatureExponent: m } : {}),
            }
          : form === 'powerLaw'
            ? { kind: 'powerLaw', variable, coefficient: Math.exp(c[0] ?? 0), exponent: c[1] ?? 0, reference: 1 }
            : { kind: form, variable, coefficients: unscale(c, alpha, beta) };
    }
    const residuals = xs.map((x, i) => {
      const value = evaluateForm(fitted, { [variable]: x });
      return (isFormFailure(value) ? Number.NaN : value.value) - (ys[i] ?? 0);
    });
    const mean = ys.reduce((s, y) => s + y, 0) / ys.length;
    const ssTotal = ys.reduce((s, y) => s + (y - mean) ** 2, 0);
    const ssResidual = residuals.reduce((s, r) => s + r * r, 0);
    const relative = residuals.flatMap((r, i) => ((ys[i] ?? 0) !== 0 ? [Math.abs(r / (ys[i] ?? 1))] : []));
    const maxRel = relative.length > 0 ? Math.max(...relative) : 0;
    const range = { variable, unit: variableUnit, data: [xs[0] ?? 0, xs[xs.length - 1] ?? 0] as [number, number] };
    const fit = {
      method: form === 'table1d' ? ('interpolating' as const) : ('linear_least_squares' as const),
      objective,
      points: rows.length,
      datasetSha256: sha256Hex(canonicalJson(rows)),
      ...(params.dataSource !== undefined ? { dataProvenance: withoutUndefined<{ citation: string }>(params.dataSource) } : {}),
      residual: {
        rms: Math.sqrt(ssResidual / rows.length),
        maxAbs: Math.max(...residuals.map(Math.abs)),
        maxRel,
        unit: valueUnit,
        ...(ssTotal > 0 ? { rSquared: 1 - ssResidual / ssTotal } : {}),
      },
      ...(conditionNumber !== undefined ? { conditionNumber } : {}),
      fittedRange: [range],
      tool: 'llull fit_property_model',
    };
    const source = withoutUndefined<{ citation: string; locator?: string; url?: string }>(
      params.dataSource ?? { citation: 'llull fit_property_model (no data source given)' },
    );
    const model = {
      id: params.id,
      property: params.property,
      unit: valueUnit,
      variables: [{ variable, unit: variableUnit }],
      form: fitted,
      validity: [range],
      basis,
      source,
      fit,
    };
    const asModel: PropertyModel = { ...model, provenance: source, coefficientsSha256: formHash(fitted) };
    const issue = modelProblem(asModel, new Set());
    if (issue !== null) return refuseWith(doc, name, issue.code, issue.message, [params.id], issue.path);
    const threshold = params.maxRelResidual ?? MAX_REL_RESIDUAL;
    if (params.maxRelResidual === undefined)
      defaults.push({
        name: 'maxRelResidual',
        value: MAX_REL_RESIDUAL,
        source: 'llull choice; equals the NIST cp fit error (5 %)',
        defaulted: true,
      });
    const warnings =
      maxRel > threshold ? [{ code: 'PROP_FIT_POOR', message: `max relative residual ${maxRel.toExponential(2)} > ${threshold}` }] : [];
    return report(
      doc,
      `fit_property_model ${params.id}: ${form} on ${rows.length} rows, max relative residual ${maxRel.toExponential(2)}, RMS ${fit.residual.rms.toExponential(3)} ${valueUnit}` +
        `${warnings.length > 0 ? ' (PROP_FIT_POOR)' : ''}; unverified until a data source is given and a reviewer accepts it. Next: define_property_model with data.model.`,
      { model, fit, warnings, defaults },
    );
  },
});
