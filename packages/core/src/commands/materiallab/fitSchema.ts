/** Parameter schema of fit_material_model (kept apart so the linear and non-linear branches share the inferred type). */

import { BASES } from '../../model/propertyModel';
import { validRangeSchema } from '../document/materialLawSchema';
import { z } from '../schema';

export const LINEAR_KINDS = [
  'hyper_neo_hooke',
  'hyper_mooney_rivlin',
  'hyper_yeoh',
  'hyper_polynomial',
  'hyper_reduced_polynomial',
  'ramberg_osgood',
  'visco_prony',
] as const;
export const NONLINEAR_KINDS = ['hyper_ogden', 'hyper_arruda_boyce', 'j2_voce', 'j2_chaboche', 'creep_garofalo'] as const;

export const fitParamsSchema = z.object({
  kind: z.enum([...LINEAR_KINDS, ...NONLINEAR_KINDS]).describe('Law to fit.'),
  tests: z
    .array(
      z.object({
        mode: z
          .string()
          .describe(
            'uniaxial | equibiaxial | planar (hyperelastic), uniaxial_plastic (ramberg_osgood, j2_voce, j2_chaboche), relaxation (visco_prony), creep_rate (creep_garofalo).',
          ),
        rows: z
          .array(z.array(z.number()))
          .describe('Rows [x, y] (creep_rate: [stress, temperature, rate]); at most 10 000 over all tests.'),
        xMeasure: z.string().describe("What x is: 'stretch', 'total_strain', 'plastic_strain', 'time', 'stress'."),
        yMeasure: z.string().describe("What y is: 'nominal_stress', 'true_stress', 'shear_modulus', 'creep_rate'."),
        units: z
          .record(z.string(), z.string())
          .optional()
          .describe("Units of the columns: { y: 'MPa' } (and x for time: { x: 's' }; creep_rate: { x: 'MPa', T: 'K', y: '1/s' })."),
        weight: z.number().optional().describe('Weight of the test (> 0, default 1).'),
      }),
    )
    .describe('The test data.'),
  order: z.number().int().optional().describe('Order 1-3 of hyper_polynomial / hyper_reduced_polynomial (default 2).'),
  terms: z
    .number()
    .int()
    .optional()
    .describe('Number of terms of the non-linear series: hyper_ogden 1-3, j2_chaboche 1-10, visco_prony with free relaxation times 1-20.'),
  objective: z
    .enum(['absolute', 'relative'])
    .optional()
    .describe("Residual weighting: 'absolute' nominal-stress residual (default, named) or 'relative'."),
  form: z
    .enum(['engineering', 'true_stress'])
    .optional()
    .describe(
      "ramberg_osgood only: 'engineering' (default) ε = σ/E + 0.002 (σ/σ0.2)^n by linear regression; 'true_stress' E ε = σ + α (|σ|/σ0)^(n−1) σ by Levenberg-Marquardt (fixed.sigma0 required).",
    ),
  fixed: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Fixed values as {value, unit}: ramberg_osgood { E, nu } (+ sigma0 for true_stress); visco_prony { tau: [{value, unit}…] } fits g_i only, omit tau (and give terms) to fit the times too, G0? when the t = 0 row is absent; j2_chaboche { yieldStress }; creep_garofalo { activationEnergy? } (omit to fit it from several temperatures).',
    ),
  start: z
    .record(z.string(), z.number())
    .optional()
    .describe(
      'Non-linear fits: starting values by parameter name in kernel units (MPa, s, 1/MPa, J/mol), all of them. Replaces the deterministic multi-start. Names: hyper_ogden mu1…, alpha1…; hyper_arruda_boyce mu, lambdaM; visco_prony g1…, tau1…; ramberg_osgood true_stress alpha, n; j2_voce sigmaY, Q, b; j2_chaboche C1…, gamma1…; creep_garofalo A, alpha, n, activationEnergy.',
    ),
  bounds: z
    .record(z.string(), z.tuple([z.number().nullable(), z.number().nullable()]))
    .optional()
    .describe('Non-linear fits: [lower, upper] per parameter name (null keeps that side of the named default bound).'),
  positive: z
    .boolean()
    .optional()
    .describe('hyper_ogden: require every shear term μ_i ≥ 0 (default true, named); false allows negative terms.'),
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
});

export type FitParams = z.infer<typeof fitParamsSchema>;
