/**
 * The stored pipe stress model (`doc.plant.stress`, 07 PST §3): references and rules, never a geometry copy. One zod schema per record gives the
 * TS type, the load-time validation and (for the pieces commands take as input) the tool parameters.
 */

import { z } from '@core/commands/schema';
import { RULE_SET_IDS } from '../code/ruleSets';

const finite = z.number().refine(Number.isFinite, 'must be finite');
const positive = finite.refine((value) => value > 0, 'must be positive');
const nonNegative = finite.refine((value) => value >= 0, 'must be >= 0');
const vec3 = z.tuple([finite, finite, finite]);

/** Where thermal strain comes from: the built-in carbon steel table, a document material (thermalStrain / cte model), or a constant secant coefficient. */
export const thermalSourceSchema = z.union([
  z.object({ table: z.literal('carbon-steel-c1').describe('Built-in carbon steel mean expansion from 70 degF (21.1 to 482 degC).') }),
  z.object({
    materialId: z.string().min(1).describe('Name of a document material with a thermalStrain (preferred) or cte property model.'),
    cteReferenceC: finite.describe('Only for a secant cte model: the reference temperature of the coefficient in degC.').optional(),
  }),
  z.object({
    meanCtePerK: finite.describe('Constant secant thermal expansion coefficient in 1/K (steel about 1.2e-5); flagged unverified.'),
  }),
]);

export const materialSchema = z.object({
  youngsModulusMPa: positive,
  poisson: finite.refine((value) => value > 0 && value < 0.5, 'must be in (0, 0.5)'),
  densityKgM3: positive,
  thermal: thermalSourceSchema,
  ShMPa: positive,
  ScMPa: positive,
  ferrousLowStrength: z.boolean(),
});

const indexedName = (letter: string): z.ZodType<string> => z.string().regex(new RegExp(`^${letter}[1-9]$`), `${letter}1 .. ${letter}9`);

export const conditionsSchema = z.object({
  installTempC: finite,
  temperatures: z.array(z.object({ name: indexedName('T'), tempC: finite })),
  pressures: z.array(z.object({ name: indexedName('P'), gaugeBar: nonNegative })),
  fluidDensityKgM3: nonNegative,
  corrosionAllowanceMm: nonNegative,
  cycles: finite.refine((value) => value >= 1, 'must be >= 1'),
  wallMm: positive.optional(),
  insulation: z.object({ thicknessMm: positive, densityKgM3: positive, claddingKgM2: nonNegative }).optional(),
  millTolerancePct: finite.refine((value) => value >= 0 && value < 50, 'must be in [0, 50)').optional(),
  hydro: z.object({ testPressureBar: positive, allowableMPa: positive, fluidDensityKgM3: positive }).optional(),
  poissonPressure: z.boolean(),
  material: materialSchema,
  defaulted: z.array(z.string()),
});

export const LOAD_CASE_TYPES = ['OPE', 'SUS', 'EXP', 'OCC', 'HYD'] as const;

export const loadCaseSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,15}$/, 'a short name like L1')
    .describe('Case name, e.g. L1 (letters, digits, underscore; up to 16).'),
  type: z
    .enum(LOAD_CASE_TYPES)
    .describe('SUS sustained, OPE operating, OCC occasional state, HYD hydrotest, EXP displacement range (combination of cases).'),
  basic: z
    .array(z.string().regex(/^(W|WW|HP|[TPFDU][1-9]|WIN[1-9])$/))
    .describe(
      'OPE / SUS / OCC / HYD: primitive loads solved together: W (weight), WW (weight with the hydrotest water), HP (hydrotest pressure), T1..T9, P1..P9, F1..F9, D1..D9, U1..U9 (uniform acceleration load, seismic static), WIN1..WIN9 (wind).',
    )
    .optional(),
  combine: z
    .array(
      z.object({
        case: z.string().describe('Name of a solved OPE / SUS / OCC case.'),
        factor: finite.describe('Algebraic factor, e.g. 1 and -1 for OPE - SUS.'),
      }),
    )
    .describe('EXP: algebraic combination of solved cases.')
    .optional(),
});

export const forceSchema = z.object({
  name: indexedName('F').describe('F1 .. F9: the name load cases use in basic.'),
  pipeId: z.string().min(1).describe('Pipe or run id in the model.'),
  atMm: nonNegative.describe('Arc length from the pipe start along the centreline, mm.'),
  forceN: vec3.describe('Force [x, y, z] in N, global axes.'),
  momentNmm: vec3.describe('Moment [x, y, z] in N.mm, global axes. Default none.').optional(),
});

export const displacementSchema = z.object({
  name: indexedName('D').describe('D1 .. D9: the name load cases use in basic.'),
  at: z
    .union([
      z.object({ supportId: z.string().min(1).describe('Id of an anchor pipe support.') }),
      z.object({
        pipeId: z.string().min(1).describe('Pipe or run id in the model.'),
        atMm: nonNegative.describe('Arc length from the pipe start, mm.'),
      }),
    ])
    .describe('The anchor that moves: {supportId} or {pipeId, atMm} (an anchor must sit there).'),
  translationMm: vec3.describe('Imposed translation [x, y, z] of the anchor, mm, global axes.'),
  rotationDeg: vec3.describe('Imposed rotation [x, y, z] of the anchor, degrees, global axes. Default none.').optional(),
});

export const windSchema = z.object({
  name: z
    .string()
    .regex(/^WIN[1-9]$/, 'WIN1 .. WIN9')
    .describe('WIN1 .. WIN9: the name load cases use in basic.'),
  pressureKPa: positive.describe(
    'Design velocity pressure q of the wind in kPa (from the wind code for the site and height; stated, never defaulted).',
  ),
  dragCoefficient: positive.describe('Drag (shape) coefficient Cf of the pipe cross-section, for example 0.7 to 1.2 for a round pipe.'),
  direction: vec3
    .refine((v) => Math.hypot(...v) > 0, 'must not be the zero vector')
    .describe('Direction the wind blows toward [x, y, z], global axes; normalised, normally horizontal.'),
});

export const accelerationSchema = z.object({
  name: indexedName('U').describe('U1 .. U9: the name load cases use in basic.'),
  gFactors: vec3.describe(
    'Static acceleration as fractions of g along [x, y, z]; the load is factor x weight in that direction (seismic static).',
  ),
});

const SPRING_SERIES = z.string().min(1);

export const springSizeSchema = z.object({
  size: z.string().min(1).describe('Vendor size designation, e.g. "10".'),
  series: SPRING_SERIES.describe('Vendor series (spring type), e.g. "B".'),
  minN: positive.describe('Smallest hot load of the working range of this size, N.'),
  maxN: positive.describe('Largest hot load of the working range of this size, N.'),
  rateNPerMm: positive.describe('Spring rate k, N per mm.'),
  travelMm: positive.describe('Working travel of this size, mm (up or down from the cold position).'),
});

export const springTableSchema = z.object({ id: z.string().min(1), source: z.string().min(3), sizes: z.array(springSizeSchema).min(1) });

export const springSelectionSchema = z.object({
  id: z.string().min(1),
  at: z.union([z.object({ supportId: z.string().min(1) }), z.object({ pipeId: z.string().min(1), atMm: nonNegative })]),
  kind: z.enum(['variable', 'constant']),
  tableId: z.string().optional(),
  size: z.string().optional(),
  series: z.string().optional(),
  rateNPerMm: nonNegative,
  hotLoadN: positive,
  coldLoadN: positive,
  travelUpMm: finite,
  variability: nonNegative,
});

export const sifOverrideSchema = z.object({
  id: z.string().min(1),
  at: z.union([z.object({ supportId: z.string().min(1) }), z.object({ pipeId: z.string().min(1), atMm: nonNegative })]),
  sifInPlane: finite.refine((value) => value >= 1, 'must be >= 1'),
  sifOutOfPlane: finite.refine((value) => value >= 1, 'must be >= 1'),
  flexibility: finite.refine((value) => value >= 1, 'must be >= 1').optional(),
  source: z.string().min(3),
});

export const RESTRAINT_KINDS = ['anchor', 'rest', 'guide', 'translational'] as const;

export const restraintSchema = z.object({
  id: z.string().min(1),
  at: z.union([z.object({ supportId: z.string().min(1) }), z.object({ pipeId: z.string().min(1), atMm: nonNegative })]),
  kind: z.enum(RESTRAINT_KINDS),
  axis: z.enum(['x', 'y', 'z']).optional(),
  direction: vec3.optional(),
  oneWay: z.enum(['+', '-']).optional(),
  gapMm: nonNegative.optional(),
  frictionCoefficient: nonNegative.optional(),
});

export const COMPONENT_KINDS = ['valve', 'flange', 'rigid'] as const;
export const TEE_FITTINGS = ['welding_tee', 'unreinforced_tee', 'reinforced_tee', 'weldolet'] as const;

/**
 * Data of a pipe component the stress model reads (07 PST M5a): an 02 RTE inline valve or reducer (`componentId`), the tee / olet at the start of a
 * branch pipe (`branchPipeId`), or a component declared on a pipe (`pipeId` + `atMm` + `lengthMm`: a flange pair, a valve or any rigid body of a building pipe).
 */
export const componentSchema = z.object({
  id: z.string().min(1),
  target: z.union([
    z.object({ componentId: z.string().min(1) }),
    z.object({ branchPipeId: z.string().min(1) }),
    z.object({ pipeId: z.string().min(1), atMm: nonNegative, lengthMm: positive, kind: z.enum(COMPONENT_KINDS) }),
  ]),
  weightKg: nonNegative.optional(),
  rigid: z.boolean().optional(),
  stiffnessFactor: positive.optional(),
  fitting: z.enum(TEE_FITTINGS).optional(),
  padMm: positive.optional(),
});

const recordedSchema = z.object({
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  resultHash: z.string().regex(/^[0-9a-f]{64}$/),
  solverVersion: z.string(),
  rule: z.string(),
  status: z.enum(['pass', 'fail', 'incomplete']),
  reviewRequired: z.literal(true),
  cases: z.array(z.string()),
  findings: z.array(z.object({ code: z.string(), severity: z.enum(['info', 'warn', 'fail']), ids: z.array(z.string()) })),
  governing: z.array(z.object({ case: z.string(), nodeId: z.string(), ratio: finite, rule: z.string() })),
  supportLoads: z.array(z.object({ nodeId: z.string(), supportIds: z.array(z.string()), case: z.string(), forceN: vec3, momentNmm: vec3 })),
});

const approvalSchema = z.object({
  signer: z.string().min(1),
  signatureId: z.string().min(1),
  at: z.string().min(1),
  inputHash: z.string(),
  resultHash: z.string(),
});

export const stressModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  scope: z.object({ kind: z.enum(['pipes', 'runs']), ids: z.array(z.string().min(1)).min(1) }),
  rule: z.enum(RULE_SET_IDS),
  maxElementLengthMm: positive,
  elbowRadiusFactor: nonNegative,
  frictionCoefficient: nonNegative,
  /** Named defaults taken at creation (listed in every result). */
  defaulted: z.array(z.string()),
  conditions: conditionsSchema.optional(),
  loadCases: z.array(loadCaseSchema),
  forces: z.array(forceSchema),
  restraints: z.array(restraintSchema),
  displacements: z.array(displacementSchema),
  sifOverrides: z.array(sifOverrideSchema),
  components: z.array(componentSchema),
  wind: z.array(windSchema),
  seismic: z.array(accelerationSchema),
  springTables: z.array(springTableSchema),
  springs: z.array(springSelectionSchema),
  recorded: recordedSchema.optional(),
  approval: approvalSchema.optional(),
});

export const stressSliceSchema = z.object({ models: z.record(z.string(), stressModelSchema), modelOrder: z.array(z.string()) });

export type StressModel = z.infer<typeof stressModelSchema>;
export type StressSlice = z.infer<typeof stressSliceSchema>;
export type OperatingConditions = z.infer<typeof conditionsSchema>;
export type LoadCaseDef = z.infer<typeof loadCaseSchema>;
export type StressRestraint = z.infer<typeof restraintSchema>;
export type StressComponent = z.infer<typeof componentSchema>;
export type StressDisplacement = z.infer<typeof displacementSchema>;
export type SifOverride = z.infer<typeof sifOverrideSchema>;
export type StressWind = z.infer<typeof windSchema>;
export type StressAcceleration = z.infer<typeof accelerationSchema>;
export type SpringTable = z.infer<typeof springTableSchema>;
export type SpringSelection = z.infer<typeof springSelectionSchema>;
export type StressForce = z.infer<typeof forceSchema>;
export type RecordedResults = z.infer<typeof recordedSchema>;
