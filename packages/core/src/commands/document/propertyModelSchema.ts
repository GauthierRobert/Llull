/** zod schemas of PHY-01 property models: the recursive form, the model input of define_property_model, and the fit record. */

import { isRecord } from '../../lib/isRecord';
import {
  BASES,
  INTERPOLATIONS,
  PROPERTY_DIRECTIONS,
  PROPERTY_VARIABLES,
  type PropertyForm,
  type PropertyModel,
} from '../../model/propertyModel';
import { modelProblem } from '../../model/propertyModelValidate';
import { z } from '../schema';

const variable = z
  .enum(PROPERTY_VARIABLES)
  .describe('State variable: T, strainRate, time, exposureTime, pressure, equivalentPlasticStrain.');
const pair = z.tuple([z.number(), z.number()]).describe('[min, max].');
const variableSpec = z.object({
  variable,
  unit: z.string().describe("Unit the coefficients assume, e.g. 'K', '1/s'."),
  axis: z.enum(['linear', 'log10']).optional().describe('table2d axis spacing (default linear).'),
});

export const formSchema: z.ZodType<PropertyForm> = z.lazy(
  () =>
    z.union([
      z.object({ kind: z.literal('constant'), value: z.number() }),
      z.object({ kind: z.literal('table1d'), variable, points: z.array(pair), interpolation: z.enum(INTERPOLATIONS) }),
      z.object({
        kind: z.literal('table2d'),
        x: variableSpec,
        y: variableSpec,
        xs: z.array(z.number()),
        ys: z.array(z.number()),
        values: z.array(z.array(z.number())),
        interpolation: z.literal('bilinear'),
      }),
      z.object({ kind: z.literal('polynomial'), variable, coefficients: z.array(z.number()), origin: z.number().optional() }),
      z.object({ kind: z.literal('log10Polynomial'), variable, coefficients: z.array(z.number()) }),
      z.object({ kind: z.literal('nistRational'), coefficients: z.array(z.number()) }),
      z.object({
        kind: z.literal('arrhenius'),
        preFactor: z.number(),
        activationEnergyJPerMol: z.number(),
        temperatureExponent: z.number().optional(),
      }),
      z.object({ kind: z.literal('powerLaw'), variable, coefficient: z.number(), exponent: z.number(), reference: z.number() }),
      z.object({ kind: z.literal('piecewise'), variable, segments: z.array(z.object({ upTo: z.number(), form: formSchema })) }),
      z.object({ kind: z.literal('product'), factors: z.array(formSchema) }),
      z.object({ kind: z.literal('rateFactor'), law: z.literal('johnsonCook'), C: z.number(), referenceRate: z.number() }),
      z.object({ kind: z.literal('rateFactor'), law: z.literal('cowperSymonds'), D: z.number(), q: z.number() }),
      z.object({ kind: z.literal('ratioOf'), baseModelId: z.string(), ratio: formSchema }),
    ]) as unknown as z.ZodType<PropertyForm>,
);

const provenance = z
  .object({
    sourceId: z.string().optional().describe('Registered source id.'),
    citation: z.string().optional().describe('Citation.'),
    locator: z.string().optional().describe('Table / page in the source.'),
    url: z.string().optional().describe('URL.'),
    accessed: z.string().optional().describe('Access date.'),
    note: z.string().optional().describe('Note.'),
  })
  .describe('Where the value comes from.');

const validRange = z.object({
  variable,
  unit: z.string().describe('Unit of the range bounds.'),
  data: pair.describe('[min, max] of the measurements.'),
  equation: pair.optional().describe('[min, max] the source allows for the fit (⊇ data; default = data).'),
});

export const fitRecordSchema = z.object({
  method: z.enum(['linear_least_squares', 'levenberg_marquardt', 'interpolating']),
  objective: z.enum(['absolute', 'relative', 'log10']),
  points: z.number().int(),
  datasetSha256: z.string(),
  dataProvenance: provenance.optional(),
  residual: z.object({ rms: z.number(), maxAbs: z.number(), maxRel: z.number(), unit: z.string(), rSquared: z.number().optional() }),
  conditionNumber: z.number().optional(),
  fittedRange: z.array(validRange),
  tool: z.string(),
});

/** Agent-facing model input of define_property_model (form and fit are validated in `run` for precise paths). */
export const modelInputSchema = z.object({
  id: z.string().min(1).describe('Model id, unique on the material, e.g. "k.nist".'),
  property: z
    .string()
    .describe('Catalogue property: k, cp, E, G, nu, density, cte, thermalStrain, Fty, Ftu, … (unit dimension is checked).'),
  unit: z.string().describe("Output unit of the form as written, e.g. 'W/(m*K)', 'J/(kg*K)', 'GPa', '1e-5' (NIST thermal strain)."),
  variables: z
    .array(variableSpec)
    .describe("Every variable the form reads with the unit its coefficients assume, e.g. [{ variable: 'T', unit: 'K' }]."),
  form: z
    .record(z.string(), z.unknown())
    .describe(
      'The law, by kind: constant {value}; table1d {variable, points [[x,y]…] strictly increasing, interpolation linear|loglinear|loglog|step}; ' +
        'table2d {x, y (variable, unit, axis linear|log10), xs, ys, values[i][j], interpolation bilinear}; polynomial {variable, coefficients c0…, origin?} ' +
        '(y = Σ c_k (x − origin)^k); log10Polynomial {variable, coefficients a…i} (log10 y = Σ c_k (log10 x)^k, NIST); nistRational {coefficients a…i, exactly 9}; ' +
        'arrhenius {preFactor, activationEnergyJPerMol, temperatureExponent?}; powerLaw {variable, coefficient, exponent, reference}; ' +
        'piecewise {variable, segments [{upTo, form}]} (left segment wins at a breakpoint); product {factors}; rateFactor {law johnsonCook, C, referenceRate} | ' +
        '{law cowperSymonds, D, q}; ratioOf {baseModelId, ratio}.',
    ),
  validity: z
    .array(validRange)
    .describe(
      'REQUIRED range per variable: data = range of the measurements; equation = range the source allows for the fit (⊇ data, default data).',
    ),
  basis: z
    .enum(BASES)
    .describe('A | B | S (allowables), typical, supplier_unstated, company, unspecified (typical / unstated / unspecified ⇒ unverified).'),
  direction: z.enum(PROPERTY_DIRECTIONS).optional().describe('Orientation: L, LT, ST, 1, 2, 3, normal, warp, fill.'),
  condition: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional()
    .describe(
      'Condition of the data, any of: temper (e.g. T6), productForm, rrr (residual resistivity ratio, a number), environment, note.',
    ),
  uncertainty: z
    .object({
      kind: z.enum(['fitErrorVsData', 'measurement', 'statistical']).describe('What the uncertainty means.'),
      relative: z.number().nonnegative().optional().describe('Relative half-width, e.g. 0.005 for 0.5 %.'),
      absolute: z
        .object({ value: z.number().describe('Half-width.'), unit: z.string().describe('Unit.') })
        .optional()
        .describe('Absolute half-width.'),
      coverage: z.number().optional().describe('Coverage probability (statistical only), e.g. 0.95.'),
      provenance: z
        .record(z.string(), z.string())
        .describe('Where the uncertainty is stated: citation or sourceId, locator, url, accessed.'),
    })
    .optional()
    .describe(
      'Uncertainty: kind fitErrorVsData (fit quality, NOT a confidence bound), measurement or statistical (with coverage); relative or absolute.',
    ),
  source: z
    .object({
      citation: z.string().describe('Bibliographic citation of the data.'),
      locator: z.string().optional().describe('Table / page / figure in the source.'),
      url: z.string().optional().describe('Where it was read.'),
      accessed: z.string().optional().describe('Access date, YYYY-MM-DD.'),
      sourceId: z.string().optional().describe('Registered source id, when one exists.'),
    })
    .describe('Provenance of the coefficients (required).'),
  fit: z.record(z.string(), z.unknown()).optional().describe('Fit record exactly as returned by fit_property_model (never hand-written).'),
  preferred: z.literal(true).optional().describe('Mark as THE model for its property / direction / basis / condition (one per key).'),
});

/** A property model as stored in a document (load-time validation; `fit` and `reviewedBy` kept as written). */
const storedModelSchema = z.looseObject({
  id: z.string().min(1),
  property: z.string(),
  unit: z.string(),
  variables: z.array(variableSpec),
  form: formSchema,
  validity: z.array(validRange),
  basis: z.enum(BASES),
  direction: z.enum(PROPERTY_DIRECTIONS).optional(),
  provenance,
  coefficientsSha256: z.string(),
  fit: fitRecordSchema.optional(),
  reviewedBy: z.object({ signatureId: z.string() }).optional(),
  preferred: z.literal(true).optional(),
});

/** First problem of a stored `propertyModels` list (shape, unique ids, well-formedness, coefficient hash), or null. */
export function storedModelsProblem(materialName: string, value: unknown, hash: (form: PropertyForm) => string): string | null {
  if (!Array.isArray(value)) return `material '${materialName}': propertyModels must be an array`;
  const ids = new Set<string>();
  for (const [i, raw] of value.entries()) {
    const parsed = storedModelSchema.safeParse(raw);
    if (!parsed.success)
      return `material '${materialName}': propertyModels[${i}] ${parsed.error.issues[0]?.path.join('.') ?? ''}: ${parsed.error.issues[0]?.message ?? ''}`;
    const model = parsed.data as unknown as PropertyModel;
    if (ids.has(model.id)) return `material '${materialName}': duplicate property model id '${model.id}'`;
    ids.add(model.id);
    if (hash(model.form) !== model.coefficientsSha256)
      return `material '${materialName}': model '${model.id}' coefficientsSha256 does not match its form`;
    const issue = modelProblem(
      model,
      new Set(
        value.flatMap((other: unknown) =>
          isRecord(other) && typeof other['id'] === 'string' && other['id'] !== model.id ? [other['id']] : [],
        ),
      ),
    );
    if (issue !== null) return `material '${materialName}': model '${model.id}' ${issue.code} at ${issue.path}: ${issue.message}`;
  }
  return null;
}

/** zod output with its `undefined` optional keys removed (JSON round trip; zod has already rejected NaN / ±∞). */
export const withoutUndefined = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;
