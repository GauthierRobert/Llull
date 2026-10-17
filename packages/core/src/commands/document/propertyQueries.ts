/** evaluate_property / sample_property (PHY-01): read-only queries over a material's property models. */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import { BASES, PROPERTY_DIRECTIONS, PROPERTY_VARIABLES, type PropertyModel } from '../../model/propertyModel';
import {
  baseEvaluatorOf,
  cteFromThermalStrain,
  evaluatePropertyModel,
  isRefused,
  resolvePropertyModel,
  type NamedDefault,
  type PropertyEvaluation,
  type PropertyEvaluationRefused,
  type PropertyRecord,
  type VariableValues,
} from '../../model/propertyModelEval';
import { curveOf, integrateModel, samplePoints, tabulateModel, SOLVER_TABLE_REL_TOL } from '../../model/propertyTabulate';
import type { CadDocument, Material } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { commandError, rejection, report } from '../noop';

const quantity = z.object({ value: z.number().describe('Value.'), unit: z.string().describe("Unit, e.g. 'K', 'degC', 'degF', '1/s'.") });

const atSchema = z
  .record(z.string(), quantity)
  .describe(
    `Operating point: every variable the model needs (${PROPERTY_VARIABLES.join(', ')}), each { value, unit }, e.g. { T: { value: 77, unit: 'K' } }.`,
  );

const DENSITY_DEFAULT: NamedDefault = {
  name: 'allowConstant',
  value: true,
  source: 'caller: the room-temperature scalar density is used for a temperature-dependent query',
  defaulted: true,
};

const refusal = (doc: CadDocument, command: string, refused: PropertyEvaluationRefused, ids: readonly string[]): CommandResult => ({
  ...rejection(
    doc,
    `${command}: ${refused.code} — ${refused.reason}; no-op.`,
    commandError(refused.code, refused.remediation, ids, refused.path !== undefined ? [refused.path] : []),
  ),
  data: refused,
});

const missingMaterial = (doc: CadDocument, command: string, id: string): CommandResult =>
  refusal(
    doc,
    command,
    {
      available: false,
      code: 'MAT_RECORD_NOT_FOUND',
      reason: `no material '${id}'`,
      remediation: 'create_material first',
      path: 'material',
    },
    [id],
  );

/** TR-PROP-15: a private-library record without values answers available: false, never another model. */
const unresolvedMaterial = (doc: CadDocument, command: string, id: string, reason: string): CommandResult =>
  refusal(
    doc,
    command,
    {
      available: false,
      code: 'MAT_LIBRARY_UNRESOLVED',
      reason: `material '${id}' has no values on this machine (${reason})`,
      remediation: 'register the library file (register_material_library), then run resolve_material_libraries',
      path: 'material',
    },
    [id],
  );

/** The queried material and its property record, or the MAT_RECORD_NOT_FOUND / MAT_LIBRARY_UNRESOLVED refusal. */
function queriedMaterial(
  doc: CadDocument,
  command: string,
  id: string,
): { readonly material: Material; readonly record: PropertyRecord } | { readonly refusal: CommandResult } {
  const material = Object.hasOwn(doc.materials, id) ? doc.materials[id] : undefined;
  if (material === undefined) return { refusal: missingMaterial(doc, command, id) };
  if (material.record?.unresolved !== undefined)
    return { refusal: unresolvedMaterial(doc, command, id, material.record.unresolved.reason) };
  return { material, record: { name: id, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) } };
}

/** Model for the query, falling back to a derived CTE when only a thermalStrain model exists. */
function resolveFor(
  record: PropertyRecord,
  params: {
    property: string;
    modelId?: string | undefined;
    direction?: PropertyModel['direction'] | undefined;
    basis?: PropertyModel['basis'] | undefined;
    condition?: Record<string, unknown> | undefined;
  },
): { model: PropertyModel; derivedCte: boolean } | PropertyEvaluationRefused {
  const query = {
    property: params.property,
    ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
    ...(params.direction !== undefined ? { direction: params.direction } : {}),
    ...(params.basis !== undefined ? { basis: params.basis } : {}),
    ...(params.condition !== undefined ? { condition: params.condition } : {}),
  };
  const direct = resolvePropertyModel(record, query);
  if (!isRefused(direct)) return { model: direct, derivedCte: params.property === 'cte' && direct.property === 'thermalStrain' };
  if (params.property === 'cte' && params.modelId === undefined) {
    const strain = resolvePropertyModel(record, { ...query, property: 'thermalStrain' });
    if (!isRefused(strain)) return { model: strain, derivedCte: true };
  }
  return direct;
}

const atText = (at: VariableValues): string =>
  Object.entries(at)
    .map(([variable, q]) => `${variable} = ${q.value} ${q.unit}`)
    .join(', ');

/**
 * @affects nothing — read-only; data = PropertyEvaluation { available, value, unit, rangeStatus, derivative?, band?, basis, provenance,
 *   method, unverified, unverifiedReasons, reviewRequired, warnings, defaults }
 * @invariant never extrapolates; never substitutes a basis; the room-temperature density is used for a variable query only with
 *   allowConstant (then a named default)
 * @failure PROP_OUT_OF_RANGE, PROP_VARIABLE_MISSING, PROP_NO_MODEL_FOR_PROPERTY (candidates), PROP_CONSTANT_ONLY,
 *   PROP_DERIVATIVE_UNAVAILABLE, MAT_UNIT_DIMENSION, MAT_VALUE_UNVERIFIED, MAT_RECORD_NOT_FOUND -> rejection, data = the refusal
 */
export const evaluateProperty = defineCommand({
  name: 'evaluate_property',
  annotations: { readOnly: true },
  description:
    'Evaluate a material property (k, cp, E, cte, thermalStrain …) at an operating point. Give every variable the model needs with its ' +
    "unit, e.g. at.T = {value: 77, unit: 'K'} or {value: -196, unit: 'degC'}. Returns value + unit, range status (in_data_range, or " +
    "in_equation_range_only = unverified with PROP_OUTSIDE_DATA_RANGE), basis, source and `unverified`. Refuses outside the model's " +
    "valid range (PROP_OUT_OF_RANGE) and never extrapolates. cte is derived as s'(T)/(1 + s(T)) when only a thermalStrain model exists. " +
    'Use sample_property for tables, integrals and solver tables; use check_property_models before handing a result to the owner.',
  params: z.object({
    material: z.string().describe('Material id (create_material name).'),
    property: z.string().describe('Catalogue property name, e.g. k, cp, E, cte, thermalStrain, density.'),
    at: atSchema,
    direction: z.enum(PROPERTY_DIRECTIONS).optional().describe('Orientation of the model to use.'),
    basis: z.enum(BASES).optional().describe('Only a model on this basis (never substituted).'),
    condition: z.record(z.string(), z.unknown()).optional().describe('Condition fields the model must match, e.g. { rrr: 50 }.'),
    modelId: z.string().optional().describe('Use exactly this model.'),
    derivative: z.enum(PROPERTY_VARIABLES).optional().describe('Also return d(property)/d(variable).'),
    outputUnit: z.string().optional().describe("Unit of the answer, e.g. 'W/(mm*K)'. Default: the model unit."),
    band: z
      .boolean()
      .optional()
      .describe('Also return the uncertainty band [low, high] with its kind (fitErrorVsData is NOT a confidence bound).'),
    allowConstant: z
      .boolean()
      .optional()
      .describe('Allow the scalar density for a temperature-dependent query (reported as a named default).'),
    forCertification: z.boolean().optional().describe('Refuse unverified values (MAT_VALUE_UNVERIFIED); sets reviewRequired.'),
  }),
  run: (doc, params): CommandResult => {
    const command = 'evaluate_property';
    const queried = queriedMaterial(doc, command, params.material);
    if ('refusal' in queried) return queried.refusal;
    const { material, record } = queried;
    const at = params.at as VariableValues;
    const resolved = resolveFor(record, params);
    if ('available' in resolved) {
      if (
        params.property === 'density' &&
        resolved.code === 'PROP_NO_MODEL_FOR_PROPERTY' &&
        params.modelId === undefined &&
        (resolved.candidates ?? []).length === 0
      ) {
        const variables = Object.keys(at);
        if (variables.length > 0 && params.allowConstant !== true) {
          return refusal(
            doc,
            command,
            {
              available: false,
              code: 'PROP_CONSTANT_ONLY',
              reason: `only the scalar density of '${params.material}' exists`,
              remediation: 'define a T-dependent model, or pass allowConstant: true (named default in the result)',
              path: 'at',
            },
            [params.material],
          );
        }
        const unit = params.outputUnit ?? `g/${doc.units}^3`;
        const converted = convertValue(material.density, `g/${doc.units}^3`, unit);
        if (isUnitFailure(converted))
          return refusal(
            doc,
            command,
            {
              available: false,
              code: converted.code,
              reason: converted.message,
              remediation: "ask for a density unit, e.g. 'kg/m^3'",
              path: 'outputUnit',
            },
            [],
          );
        const data = {
          available: true,
          value: converted.value,
          unit,
          property: 'density',
          materialId: params.material,
          source: 'create_material scalar',
          unverified: true,
          unverifiedReasons: ['scalar density, no basis or source'],
          reviewRequired: params.forCertification === true,
          warnings: [],
          defaults: variables.length > 0 ? [DENSITY_DEFAULT] : [],
        };
        return report(
          doc,
          `evaluate_property ${params.material} density: ${converted.value} ${unit} (scalar from create_material; unverified).`,
          data,
        );
      }
      return refusal(doc, command, resolved, [params.material]);
    }
    const options = {
      ...(params.derivative !== undefined ? { derivative: params.derivative } : {}),
      ...(params.outputUnit !== undefined ? { outputUnit: params.outputUnit } : {}),
      ...(params.band !== undefined ? { band: params.band } : {}),
      ...(params.forCertification !== undefined ? { forCertification: params.forCertification } : {}),
    };
    const evaluation: PropertyEvaluation = resolved.derivedCte
      ? cteFromThermalStrain(record, resolved.model, at, options)
      : evaluatePropertyModel(record, resolved.model, at, options);
    if (!evaluation.available) return refusal(doc, command, evaluation, [params.material, resolved.model.id]);
    const flags = evaluation.unverified ? `; unverified: ${evaluation.unverifiedReasons.join(', ')}` : '';
    return report(
      doc,
      `evaluate_property ${params.material} ${evaluation.property} at ${atText(at)}: ${evaluation.value.toPrecision(9)} ${evaluation.unit} ` +
        `(${evaluation.rangeStatus}, basis ${evaluation.basis}, model ${evaluation.modelId}, ${evaluation.provenance.citation ?? evaluation.provenance.sourceId ?? ''})${flags}` +
        `${evaluation.reviewRequired ? '; needs review by a qualified engineer' : ''}.`,
      evaluation,
    );
  },
});

/**
 * @affects nothing — read-only; data { modelId, variable, variableUnit, unit, points [[x, y]…], integral?, solverTable?, defaults[] }
 * @invariant from / to inside the equation range; at most 1000 samples and 500 solver-table points
 * @failure PROP_OUT_OF_RANGE, PROP_SAMPLE_TOO_LARGE, plus every evaluate_property refusal
 */
export const sampleProperty = defineCommand({
  name: 'sample_property',
  annotations: { readOnly: true },
  description:
    'Sample a material property along one variable (e.g. k from 4 K to 300 K): `count` points (default 101, at most 1000), linear or log ' +
    'spacing; optionally the integral ∫ y dx (e.g. the conductivity integral in W/m, adaptive Gauss-Kronrod) and a piecewise-linear ' +
    'solver table whose linear interpolation stays within relTol (default 1e-3) of the model, for solver decks. Same range rules as ' +
    'evaluate_property: from / to must lie in the valid range (PROP_OUT_OF_RANGE). Read-only; numbers behind a property chart.',
  params: z.object({
    material: z.string().describe('Material id (create_material name).'),
    property: z.string().optional().describe('Property name (or modelId).'),
    modelId: z.string().optional().describe('Exact model id.'),
    variable: z.enum(PROPERTY_VARIABLES).describe('Variable to sweep, e.g. T.'),
    from: quantity.describe('Start of the sweep with its unit.'),
    to: quantity.describe('End of the sweep with its unit (> from).'),
    count: z.number().int().positive().optional().describe('Number of samples, endpoints included (default 101, max 1000).'),
    spacing: z.enum(['linear', 'log']).optional().describe('Sample spacing (log needs from > 0). Default linear.'),
    integrate: z.boolean().optional().describe('Also return ∫ y d(variable) over [from, to].'),
    solverTable: z.boolean().optional().describe('Also return a piecewise-linear solver table (for solver decks).'),
    solverTableRelTol: z
      .number()
      .positive()
      .optional()
      .describe('Max relative linear-interpolation error of the solver table (default 1e-3).'),
    fixed: atSchema.optional().describe('Values of the other variables, each with its unit.'),
    outputUnit: z.string().optional().describe('Unit of y. Default: the model unit.'),
  }),
  run: (doc, params): CommandResult => {
    const command = 'sample_property';
    const queried = queriedMaterial(doc, command, params.material);
    if ('refusal' in queried) return queried.refusal;
    const { record } = queried;
    if (params.property === undefined && params.modelId === undefined) {
      return refusal(
        doc,
        command,
        {
          available: false,
          code: 'PROP_NO_MODEL_FOR_PROPERTY',
          reason: 'give property or modelId',
          remediation: 'name the property to sample',
          path: 'property',
        },
        [],
      );
    }
    const resolved = resolvePropertyModel(record, {
      property: params.property ?? '',
      ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
    });
    if (isRefused(resolved)) return refusal(doc, command, resolved, [params.material]);
    const model = resolved;
    const count = params.count ?? 101;
    if (count > 1000)
      return refusal(
        doc,
        command,
        {
          available: false,
          code: 'PROP_SAMPLE_TOO_LARGE',
          reason: `count ${count} > 1000`,
          remediation: 'sample fewer points',
          path: 'count',
        },
        [],
      );
    const spec = model.variables.find((v) => v.variable === params.variable);
    if (spec === undefined)
      return refusal(
        doc,
        command,
        {
          available: false,
          code: 'PROP_VARIABLE_MISSING',
          reason: `'${model.id}' does not depend on ${params.variable}`,
          remediation: `sweep one of ${model.variables.map((v) => v.variable).join(', ')}`,
          path: 'variable',
        },
        [model.id],
      );
    const fixed = (params.fixed ?? {}) as VariableValues;
    const ends: number[] = [];
    for (const end of [params.from, params.to]) {
      const probe = evaluatePropertyModel(record, model, { ...fixed, [params.variable]: end });
      if (!probe.available) return refusal(doc, command, probe, [model.id]);
      ends.push(probe.at[params.variable]?.value ?? Number.NaN);
    }
    const [a = 0, b = 0] = ends;
    if (!(b > a))
      return refusal(
        doc,
        command,
        { available: false, code: 'PROP_OUT_OF_RANGE', reason: 'to must be greater than from', remediation: 'swap from / to', path: 'to' },
        [],
      );
    const spacing = params.spacing ?? 'linear';
    if (spacing === 'log' && !(a > 0))
      return refusal(
        doc,
        command,
        {
          available: false,
          code: 'PROP_OUT_OF_RANGE',
          reason: 'log spacing needs from > 0',
          remediation: 'use linear spacing',
          path: 'spacing',
        },
        [],
      );
    const unit = params.outputUnit ?? model.unit;
    const defaults: NamedDefault[] = [];
    if (params.count === undefined) defaults.push({ name: 'count', value: 101, source: 'llull choice', defaulted: true });
    const points: [number, number][] = [];
    for (const x of samplePoints(a, b, count, spacing)) {
      const evaluation = evaluatePropertyModel(
        record,
        model,
        { ...fixed, [params.variable]: { value: x, unit: spec.unit } },
        { outputUnit: unit },
      );
      if (!evaluation.available) return refusal(doc, command, evaluation, [model.id]);
      points.push([x, evaluation.value]);
    }
    const scale = (() => {
      const one = convertValue(1, model.unit, unit);
      const zero = convertValue(0, model.unit, unit);
      return isUnitFailure(one) || isUnitFailure(zero) ? 1 : one.value - zero.value;
    })();
    const fixedPoint = Object.fromEntries(
      model.variables
        .filter((v) => v.variable !== params.variable)
        .map((v) => {
          const given = fixed[v.variable];
          const converted = given === undefined ? undefined : convertValue(given.value, given.unit, v.unit);
          return [v.variable, converted === undefined || isUnitFailure(converted) ? Number.NaN : converted.value];
        }),
    );
    const curve = curveOf(model, params.variable, fixedPoint, baseEvaluatorOf(record));
    const integral =
      params.integrate === true
        ? { value: integrateModel(model, params.variable, a, b, curve) * scale, unit: `(${unit})*(${spec.unit})` }
        : undefined;
    let solverTable: { points: readonly (readonly [number, number])[]; maxRelError: number; relTol: number } | undefined;
    if (params.solverTable === true) {
      const relTol = params.solverTableRelTol ?? SOLVER_TABLE_REL_TOL;
      if (params.solverTableRelTol === undefined)
        defaults.push({
          name: 'solverTableRelTol',
          value: SOLVER_TABLE_REL_TOL,
          source: 'llull choice; below the 0.5 % best NIST fit error',
          defaulted: true,
        });
      const table = tabulateModel(model, params.variable, a, b, relTol, curve);
      if (table === null)
        return refusal(
          doc,
          command,
          {
            available: false,
            code: 'PROP_SAMPLE_TOO_LARGE',
            reason: 'the solver table needs more than 500 points',
            remediation: 'narrow the range or relax relTol',
            path: 'solverTableRelTol',
          },
          [model.id],
        );
      solverTable = { points: table.points.map(([x, y]) => [x, y * scale] as const), maxRelError: table.maxRelError, relTol };
    }
    if (
      (integral !== undefined && !Number.isFinite(integral.value)) ||
      (solverTable !== undefined && !Number.isFinite(solverTable.maxRelError))
    ) {
      return refusal(
        doc,
        command,
        {
          available: false,
          code: 'PROP_OUT_OF_RANGE',
          reason: `'${model.id}' cannot be evaluated everywhere between ${a} and ${b} ${spec.unit} (a table or segment does not cover it)`,
          remediation: 'sample a range the model covers, or fix the model so its form covers its whole valid range',
          path: 'to',
        },
        [model.id],
      );
    }
    const data = {
      modelId: model.id,
      property: model.property,
      variable: params.variable,
      variableUnit: spec.unit,
      unit,
      points,
      ...(integral !== undefined ? { integral } : {}),
      ...(solverTable !== undefined ? { solverTable } : {}),
      coefficientsSha256: model.coefficientsSha256,
      defaults,
    };
    return report(
      doc,
      `sample_property ${params.material}/${model.id}: ${points.length} points over ${params.variable} ${a}…${b} ${spec.unit}` +
        `${integral !== undefined ? `; integral ${integral.value.toPrecision(9)} ${integral.unit}` : ''}` +
        `${solverTable !== undefined ? `; solver table ${solverTable.points.length} points, max rel. error ${solverTable.maxRelError.toExponential(2)}` : ''}.`,
      data,
    );
  },
});
