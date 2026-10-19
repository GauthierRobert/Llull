/** zod schemas of PHY-02 material laws in their stored (canonical) form, plus the durability variants and the model envelope fields. */

import { PROPERTY_VARIABLES } from '../../model/propertyModel';
import type { MaterialLaw } from '../../model/materialModel';
import { fitRecordSchema } from './propertyModelSchema';
import { z } from '../schema';

const quantity = z.strictObject({ value: z.number(), unit: z.string() });
const lawParameter = z.union([quantity, z.strictObject({ propertyModelId: z.string().min(1) })]);
const finiteList = z.array(z.number());
const unitSchema = z.string();

const isotropic = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('perfect'), yieldStress: lawParameter }),
  z.strictObject({
    kind: z.literal('linear'),
    yieldStress: lawParameter,
    modulus: lawParameter,
    modulusKind: z.enum(['plastic', 'tangent']),
  }),
  z.strictObject({
    kind: z.literal('multilinear'),
    stressUnit: unitSchema,
    curves: z.array(z.strictObject({ temperature: quantity.optional(), points: z.array(z.tuple([z.number(), z.number()])) })),
  }),
  z.strictObject({ kind: z.literal('voce'), yieldStress: lawParameter, Q: lawParameter, b: z.number() }),
  z.strictObject({
    kind: z.literal('johnson_cook'),
    A: quantity,
    B: quantity,
    n: z.number(),
    m: z.number(),
    meltTemperature: quantity,
    transitionTemperature: quantity,
  }),
]);

const kinematic = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('linear'), C: lawParameter }),
  z.strictObject({ kind: z.literal('chaboche'), backstresses: z.array(z.strictObject({ C: lawParameter, gamma: z.number() })).max(10) }),
]);

const polynomialKeys = ['C10', 'C01', 'C20', 'C11', 'C02', 'C30', 'C21', 'C12', 'C03'] as const;
const order = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const shift = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('wlf'), C1: z.number(), C2: quantity, referenceTemperature: quantity, referenceIsTg: z.boolean() }),
  z.strictObject({ kind: z.literal('arrhenius'), activationEnergy: quantity, referenceTemperature: quantity }),
]);

const fatigueConditions = z.strictObject({
  stressRatio: z.number().optional(),
  specimenKt: z.number().optional(),
  surface: z.string().optional(),
  environment: z.string().optional(),
  temperature: quantity.optional(),
  testedLifeRange: z.strictObject({ minCycles: z.number(), maxCycles: z.number() }).optional(),
  probability: z.enum(['mean', 'P90', 'P95', 'P99', 'design', 'unspecified']),
  control: z.enum(['load', 'strain']),
});

const orientation = z.enum(['L-T', 'T-L', 'L-S', 'T-S', 'S-L', 'S-T', 'isotropic']);
const crackConditions = z.strictObject({
  stressRatio: z.union([z.number(), z.literal('per_curve')]).optional(),
  environment: z.string().optional(),
  temperature: quantity.optional(),
  orientation: orientation.optional(),
  thickness: quantity.optional(),
  testStandard: z.string().optional(),
  dKRange: z.strictObject({ min: z.number(), max: z.number(), unit: z.string() }).optional(),
});
const pairList = z.array(z.tuple([z.number(), z.number()]));

const durability = [
  z.strictObject({
    kind: z.literal('sn_basquin'),
    sigmaF: quantity,
    b: z.number(),
    enduranceAmplitude: quantity.optional(),
    conditions: fatigueConditions,
  }),
  z.strictObject({
    kind: z.literal('sn_power_law'),
    k: z.number(),
    nD: z.number(),
    sD: quantity,
    k2: z.union([z.number(), z.literal('cutoff')]).optional(),
    conditions: fatigueConditions,
  }),
  z.strictObject({
    kind: z.literal('sn_table'),
    families: z.array(
      z.strictObject({
        stressRatio: z.number().optional(),
        meanStress: quantity.optional(),
        points: pairList,
        amplitudeUnit: z.string(),
        runoutCycles: z.number().optional(),
      }),
    ),
    measure: z.enum(['amplitude', 'max']),
    conditions: fatigueConditions,
  }),
  z.strictObject({
    kind: z.literal('sn_equivalent_stress'),
    a1: z.number(),
    a2: z.number(),
    a3: z.number(),
    a4: z.number(),
    unit: z.string(),
    conditions: fatigueConditions,
  }),
  z.strictObject({
    kind: z.literal('en_coffin_manson'),
    sigmaF: quantity,
    b: z.number(),
    epsF: z.number(),
    c: z.number(),
    E: quantity,
    conditions: fatigueConditions,
  }),
  z.strictObject({ kind: z.literal('cyclic_ramberg_osgood'), Kprime: quantity, nPrime: z.number(), E: quantity }),
  z.strictObject({ kind: z.literal('haigh_table'), lifeCycles: z.number(), points: pairList, unit: z.string() }),
  z.strictObject({
    kind: z.literal('da_dn_paris'),
    C: z.number(),
    m: z.number(),
    units: z.enum(['m/cycle|MPa*m^0.5', 'in/cycle|ksi*in^0.5']),
    dKth: z.number().optional(),
    conditions: crackConditions,
  }),
  z.strictObject({
    kind: z.literal('da_dn_walker'),
    C: z.number(),
    m: z.number(),
    gamma: z.number(),
    gammaNegativeR: z.number().optional(),
    convention: z.literal('dK_over_(1-R)^(1-gamma)'),
    units: z.string(),
    conditions: crackConditions,
  }),
  z.strictObject({
    kind: z.literal('da_dn_forman'),
    C: z.number(),
    n: z.number(),
    Kc: z.number(),
    units: z.string(),
    conditions: crackConditions,
  }),
  z.strictObject({
    kind: z.literal('da_dn_nasgro'),
    C: z.number(),
    n: z.number(),
    p: z.number(),
    q: z.number(),
    threshold: z.union([
      z.strictObject({ dK0: z.number(), Cth_pos: z.number().optional(), Cth_neg: z.number().optional(), a0: z.number().optional() }),
      z.strictObject({ dKth: z.number() }),
    ]),
    toughness: z.union([
      z.strictObject({ Kc: z.number() }),
      z.strictObject({ KIc: z.number(), Ak: z.number(), Bk: z.number(), t0: z.number().optional() }),
    ]),
    closure: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('newman'), alpha: z.number(), smaxOverSigma0: z.number() }),
      z.strictObject({ kind: z.literal('table'), points: pairList }),
      z.strictObject({ kind: z.literal('none') }),
    ]),
    units: z.string(),
    conditions: crackConditions,
  }),
  z.strictObject({
    kind: z.literal('da_dn_table'),
    families: z.array(z.strictObject({ stressRatio: z.number(), points: pairList })),
    interpolation: z.literal('log_log'),
    units: z.string(),
    conditions: crackConditions,
  }),
  z.strictObject({
    kind: z.literal('fracture_toughness'),
    KIc: quantity.optional(),
    Kc: z.array(z.strictObject({ thickness: quantity, value: quantity })).optional(),
    state: z.enum(['plane_strain', 'plane_stress', 'thickness_table']),
    orientation: orientation.optional(),
    testStandard: z.string().optional(),
  }),
] as const;

/** Canonical law (stored form). Input-only fields (conventions, measures) are consumed by `normalizeLawInput` before this parse. */
export const lawSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('elastic_isotropic'), E: lawParameter, nu: lawParameter }),
  z.strictObject({
    kind: z.literal('elastic_orthotropic'),
    E1: lawParameter,
    E2: lawParameter,
    E3: lawParameter,
    nu12: lawParameter,
    nu13: lawParameter,
    nu23: lawParameter,
    G12: lawParameter,
    G13: lawParameter,
    G23: lawParameter,
  }),
  z.strictObject({
    kind: z.literal('elastic_transversely_isotropic'),
    isotropyPlane: z.enum(['12', '23']),
    Ep: lawParameter,
    Et: lawParameter,
    nuP: lawParameter,
    nuPT: lawParameter,
    Gt: lawParameter,
  }),
  z.strictObject({ kind: z.literal('elastic_anisotropic'), stiffness: finiteList, unit: unitSchema }),
  z.strictObject({ kind: z.literal('j2_plasticity'), isotropic, kinematic }),
  z.strictObject({
    kind: z.literal('hill48_plasticity'),
    isotropic,
    F: z.number(),
    G: z.number(),
    H: z.number(),
    L: z.number(),
    M: z.number(),
    N: z.number(),
  }),
  z.strictObject({
    kind: z.literal('ramberg_osgood'),
    E: lawParameter,
    nu: lawParameter,
    sigma0: lawParameter,
    n: z.number(),
    alpha: z.number(),
    theory: z.literal('deformation'),
  }),
  z.strictObject({ kind: z.literal('hyper_neo_hooke'), C10: quantity, D1: quantity }),
  z.strictObject({ kind: z.literal('hyper_mooney_rivlin'), C10: quantity, C01: quantity, D1: quantity }),
  z.strictObject({
    kind: z.literal('hyper_polynomial'),
    order,
    C: z.strictObject(
      Object.fromEntries(polynomialKeys.map((key) => [key, z.number().optional()])) as Record<
        (typeof polynomialKeys)[number],
        z.ZodOptional<z.ZodNumber>
      >,
    ),
    D: finiteList,
    stressUnit: unitSchema,
  }),
  z.strictObject({ kind: z.literal('hyper_reduced_polynomial'), order, Ci0: finiteList, D: finiteList, stressUnit: unitSchema }),
  z.strictObject({
    kind: z.literal('hyper_yeoh'),
    C10: quantity,
    C20: quantity,
    C30: quantity,
    D: z.tuple([z.number(), z.number(), z.number()]),
    compliance: unitSchema,
  }),
  z.strictObject({
    kind: z.literal('hyper_ogden'),
    terms: z.array(z.strictObject({ mu: z.number(), alpha: z.number() })),
    D: finiteList,
    stressUnit: unitSchema,
  }),
  z.strictObject({ kind: z.literal('hyper_arruda_boyce'), mu: quantity, lambdaM: z.number(), D: quantity }),
  z.strictObject({
    kind: z.literal('visco_prony'),
    shear: z.array(z.strictObject({ g: z.number(), tau: quantity })).max(20),
    bulk: z
      .array(z.strictObject({ k: z.number(), tau: quantity }))
      .max(20)
      .optional(),
    shift: shift.optional(),
  }),
  z.strictObject({
    kind: z.literal('creep_norton'),
    A: z.number(),
    n: z.number(),
    m: z.number(),
    stressUnit: unitSchema,
    timeUnit: unitSchema,
    hardening: z.enum(['time', 'strain']),
  }),
  z.strictObject({ kind: z.literal('creep_garofalo'), A: quantity, alpha: quantity, n: z.number(), activationEnergy: quantity }),
  z.strictObject({ kind: z.literal('rate_johnson_cook'), C: z.number(), referenceRate: quantity }),
  z.strictObject({ kind: z.literal('rate_cowper_symonds'), D: quantity, q: z.number() }),
  ...durability,
]) as unknown as z.ZodType<MaterialLaw>;

/** Validity variable names of a material model (PHY-01 variables plus the principal stretch). */
const validityVariable = z.enum([...PROPERTY_VARIABLES, 'stretch']);

export const validRangeSchema = z.strictObject({
  variable: validityVariable.describe('State variable the range applies to: T, strainRate, time, equivalentPlasticStrain, stretch …'),
  unit: z.string().describe("Unit of the bounds, e.g. 'K', '1/s', '1'."),
  data: z.tuple([z.number(), z.number()]).describe('[min, max] of the data the parameters were derived from.'),
  equation: z.tuple([z.number(), z.number()]).optional().describe('[min, max] the source allows (⊇ data; default = data).'),
});

/** Fit record as returned by fit_material_model (PHY-01 record with a fitted range that may be in stretch). */
export const materialFitSchema = fitRecordSchema.omit({ fittedRange: true }).extend({ fittedRange: z.array(validRangeSchema) });
