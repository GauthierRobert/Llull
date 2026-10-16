/** fit_material_model (PHY-02 §5.7): linear-in-parameters fits of constitutive laws to test data; returns a model, never edits the document. */

import { canonicalJson } from '../../lib/canonicalJson';
import { convertValue, isUnitFailure } from '../../lib/quantity';
import { sha256Hex } from '../../lib/sha256';
import { druckerScan } from '../../model/materialLaws/drucker';
import { fitHyperelastic, fitProny, fitRambergOsgood, type HyperFitKind, type HyperTest } from '../../model/materialLaws/fit';
import { type HyperMode } from '../../model/materialLaws/hyperelastic';
import { isLawFailure } from '../../model/materialLaws/resolve';
import { druckerIssues } from '../../model/materialLaws/validateHyper';
import type { MaterialFitRecord, MaterialValidRange } from '../../model/materialModel';
import { BASES } from '../../model/propertyModel';
import type { NamedDefault } from '../../model/propertyModelEval';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { matlRefusal } from '../document/materialModelRefusal';
import { validRangeSchema } from '../document/materialLawSchema';
import { withoutUndefined } from '../document/propertyModelSchema';

const command = 'fit_material_model';
const MODE_OF: Readonly<Record<string, HyperMode>> = { uniaxial: 'UT', equibiaxial: 'ET', planar: 'PS' };
const KINDS = [
  'hyper_neo_hooke',
  'hyper_mooney_rivlin',
  'hyper_yeoh',
  'hyper_polynomial',
  'hyper_reduced_polynomial',
  'ramberg_osgood',
  'visco_prony',
] as const;
const MAX_PRONY_TERMS = 20;
const TOOL = 'llull fit_material_model (Householder QR on model rows)';

type Raw = {
  mode: string;
  rows: number[][];
  xMeasure: string;
  yMeasure: string;
  units?: Record<string, string> | undefined;
  weight?: number | undefined;
};

const refuse = (doc: CadDocument, code: string, message: string, path: string, remediation?: string): CommandResult => ({
  ...matlRefusal(doc, command, code, message, [], path, remediation),
  data: { code, path, remediation: remediation ?? null },
});

const stressIn = (value: number, unit: string, to: string): number | null => {
  const converted = convertValue(value, unit, to);
  return isUnitFailure(converted) ? null : converted.value;
};

/** Rows of one test as [x, y] pairs, finite and 2 columns wide. */
function pairs(test: Raw, index: number): ReadonlyArray<readonly [number, number]> | string {
  const out: [number, number][] = [];
  for (const [j, row] of test.rows.entries()) {
    const [x, y] = row;
    if (row.length !== 2 || x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y))
      return `tests[${index}].rows[${j}]`;
    out.push([x, y]);
  }
  return out;
}

function hyperTests(doc: CadDocument, tests: readonly Raw[]): HyperTest[] | CommandResult {
  const out: HyperTest[] = [];
  for (const [i, test] of tests.entries()) {
    const mode = MODE_OF[test.mode];
    if (mode === undefined)
      return refuse(
        doc,
        'MATL_LAW_PARAMS_INVALID',
        `hyperelastic fits take modes uniaxial, equibiaxial, planar, got '${test.mode}'`,
        `tests[${i}].mode`,
      );
    if (test.xMeasure !== 'stretch' || test.yMeasure !== 'nominal_stress')
      return refuse(
        doc,
        'MATL_LAW_PARAMS_INVALID',
        "hyperelastic rows are [stretch, nominal_stress]: set xMeasure 'stretch' and yMeasure 'nominal_stress'",
        `tests[${i}].yMeasure`,
      );
    const unit = test.units?.['y'];
    if (unit === undefined)
      return refuse(
        doc,
        'MATL_LAW_PARAMS_INVALID',
        "give units.y, the stress unit of the rows (e.g. 'MPa'); it is never defaulted",
        `tests[${i}].units`,
      );
    const rows = pairs(test, i);
    if (typeof rows === 'string') return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'rows must be finite [x, y] pairs', rows);
    const converted: [number, number][] = [];
    for (const [stretch, stress] of rows) {
      const mpa = stressIn(stress, unit, 'MPa');
      if (mpa === null || !(stretch > 0))
        return refuse(doc, 'MATL_LAW_PARAMS_INVALID', `stretch must be > 0 and '${unit}' a stress unit`, `tests[${i}].rows`);
      converted.push([stretch, mpa]);
    }
    if (!(test.weight === undefined || test.weight > 0))
      return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'weight must be > 0', `tests[${i}].weight`);
    out.push({ mode, rows: converted, weight: test.weight ?? 1 });
  }
  return out;
}

const quantityOf = (value: unknown): { value: number; unit: string } | null => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record['value'] === 'number' && typeof record['unit'] === 'string'
    ? { value: record['value'], unit: record['unit'] }
    : null;
};

/**
 * @affects nothing — read-only; data { model, fit: FitRecord, validity, basis, residualsPerTest[], stability, defaults[], warnings[] }
 * @invariant deterministic (QR without pivoting); the returned model is accepted unchanged by add_material_model; the fit never attaches itself
 * @failure rows ≤ parameters -> MATL_FIT_INSUFFICIENT_DATA; condition > 1e12 -> MATL_FIT_ILL_CONDITIONED; Prony weights invalid ->
 *   MATL_PRONY_INVALID; bad rows / units -> MATL_LAW_PARAMS_INVALID; single hyperelastic mode -> warning MATL_FIT_INSUFFICIENT_MODES
 */
export const fitMaterialModel = defineCommand({
  name: command,
  annotations: { readOnly: true },
  description:
    'Fit a constitutive law that is linear in its parameters to test data and return the model, residuals per test and its stability (deterministic, ' +
    'exact QR). kind hyper_neo_hooke | hyper_mooney_rivlin | hyper_yeoh | hyper_polynomial | hyper_reduced_polynomial (order 1-3): tests with mode ' +
    "uniaxial | equibiaxial | planar, rows [stretch, nominal stress], xMeasure 'stretch', yMeasure 'nominal_stress', units { y: 'MPa' }; the Drucker " +
    'stability scan is returned (MATL_HYPERELASTIC_UNSTABLE) and a single mode warns MATL_FIT_INSUFFICIENT_MODES. kind ramberg_osgood: one test ' +
    "mode 'uniaxial_plastic', rows [total strain, true stress], fixed { E, nu } (engineering form ε = σ/E + 0.002 (σ/σ0.2)^n). kind visco_prony: " +
    "one test mode 'relaxation', rows [time, shear modulus], fixed { tau: [{value, unit}…], G0? } (relaxation times fixed, weights g_i fitted). " +
    'Objective absolute (default, named) or relative. Nothing is added to the document: pass data.model with data.validity, basis and fit to ' +
    'add_material_model. Output is unverified until a data source is given and a reviewer accepts it.',
  params: z.object({
    kind: z.enum(KINDS).describe('Law to fit.'),
    tests: z
      .array(
        z.object({
          mode: z
            .string()
            .describe('uniaxial | equibiaxial | planar (hyperelastic), uniaxial_plastic (ramberg_osgood), relaxation (visco_prony).'),
          rows: z.array(z.array(z.number())).describe('Rows [x, y] (at most 10 000 over all tests).'),
          xMeasure: z.string().describe("What x is: 'stretch', 'total_strain', 'time'."),
          yMeasure: z.string().describe("What y is: 'nominal_stress', 'true_stress', 'shear_modulus'."),
          units: z.record(z.string(), z.string()).optional().describe("Units of the columns: { y: 'MPa' } (and x for time: { x: 's' })."),
          weight: z.number().optional().describe('Weight of the test (> 0, default 1).'),
        }),
      )
      .describe('The test data.'),
    order: z.number().int().optional().describe('Order 1-3 of hyper_polynomial / hyper_reduced_polynomial (default 2).'),
    objective: z
      .enum(['absolute', 'relative'])
      .optional()
      .describe("Residual weighting: 'absolute' nominal-stress residual (default, named) or 'relative'."),
    fixed: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Fixed values: ramberg_osgood { E, nu } as {value, unit}; visco_prony { tau: [{value, unit}…], G0? }.'),
    validity: z.array(validRangeSchema).optional().describe('Validity to attach (default: the stretch / strain / time range of the data).'),
    basis: z.enum(BASES).optional().describe('Basis (default unspecified ⇒ unverified).'),
    dataSource: z
      .object({
        citation: z.string().describe('Citation.'),
        locator: z.string().optional().describe('Locator.'),
        url: z.string().optional().describe('URL.'),
        accessed: z.string().optional().describe('Access date.'),
      })
      .optional()
      .describe('Where the rows come from (absent ⇒ unverified).'),
  }),
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
    let validity: MaterialValidRange[] | undefined =
      params.validity === undefined ? undefined : withoutUndefined<MaterialValidRange[]>(params.validity);
    let model: Record<string, unknown>;
    let summary;
    let perTest: readonly object[];
    let range: MaterialValidRange;
    let stability: unknown;
    let method: MaterialFitRecord['method'] = 'linear_least_squares';
    if (params.kind === 'ramberg_osgood') {
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
      ({ law: model, summary, perTest } = fit);
      range = { variable: 'equivalentPlasticStrain', unit: '1', data: [0, fit.plasticStrainMax] };
      stability = { note: 'monotonic deformation theory: valid for proportional loading only' };
    } else if (params.kind === 'visco_prony') {
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
      ({ law: model, summary, perTest } = fit);
      range = { variable: 'time', unit: 's', data: [fit.timeRange[0], fit.timeRange[1]] };
      stability = { note: 'Prony weights g_i > 0 and Σ g_i < 1 hold' };
    } else {
      const tests = hyperTests(doc, params.tests);
      if (!Array.isArray(tests)) return tests;
      const order =
        params.kind === 'hyper_neo_hooke' || params.kind === 'hyper_mooney_rivlin' || params.kind === 'hyper_yeoh'
          ? 0
          : (params.order ?? 2);
      if (params.order === undefined && order > 0) defaults.push({ name: 'order', value: 2, source: 'llull choice', defaulted: true });
      if (order < 0 || order > 3 || (params.kind === 'hyper_polynomial' && order < 1))
        return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'order must be 1, 2 or 3', 'order');
      const fit = fitHyperelastic(params.kind as HyperFitKind, order, tests, objective);
      if (isLawFailure(fit)) return refuse(doc, fit.code, fit.message, fit.path, fit.remediation);
      ({ law: model, summary, perTest } = fit);
      range = { variable: 'stretch', unit: '1', data: [fit.stretchRange[0], fit.stretchRange[1]] };
      validity ??= [range];
      const scan = druckerScan(fit.resolved);
      stability = { drucker: scan, shearModulus: fit.resolved.shearModulus };
      for (const issue of druckerIssues(scan, validity))
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
      method = 'linear_least_squares';
    }
    validity ??= [range];
    const provenance =
      params.dataSource === undefined ? undefined : withoutUndefined<NonNullable<MaterialFitRecord['dataProvenance']>>(params.dataSource);
    const fit: MaterialFitRecord = {
      method,
      objective,
      points: summary.points,
      datasetSha256: sha256Hex(canonicalJson(params.tests)),
      ...(provenance !== undefined ? { dataProvenance: provenance } : {}),
      residual: {
        rms: summary.rms,
        maxAbs: summary.maxAbs,
        maxRel: summary.maxRel,
        unit: params.kind === 'ramberg_osgood' || params.kind === 'visco_prony' ? '1' : 'MPa',
        rSquared: summary.rSquared,
      },
      conditionNumber: summary.conditionNumber,
      fittedRange: [range],
      tool: TOOL,
    };
    const unverifiedReasons = [
      `basis ${basis}`.replace(/^basis (A|B|S|company)$/, ''),
      provenance === undefined ? 'fit without data provenance' : '',
      'fit not reviewed',
    ].filter((reason) => reason !== '');
    return report(
      doc,
      `${command} ${params.kind}: ${summary.points} rows, RMS ${summary.rms.toPrecision(6)}, max |r| ${summary.maxAbs.toPrecision(6)}, condition ${summary.conditionNumber.toPrecision(4)}; ${warnings.length} warning(s)${
        warnings.length > 0 ? ` (${[...new Set(warnings.map((w) => w.code))].join(', ')})` : ''
      }; unverified until reviewed.`,
      {
        model,
        fit,
        validity,
        basis,
        residualsPerTest: perTest,
        stability,
        defaults,
        warnings,
        unverified: true,
        unverifiedReasons,
        reviewRequired: true,
      },
    );
  },
});
