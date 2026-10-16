/** set_reference_temperature / set_temperature_field: the thermo_static set-up (PHY-04 §3.1, §4). */

import type { CteBasisSpec, TemperatureFieldSource, ThermoMechSetup } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { temperatureProblem } from '../shared/quantity';
import { analysisIdSchema, quantitySchema } from '../shared/schemas';
import { expressionProblem, thermomechOf } from './field';
import { refuseTmc } from './refusal';
import { affineBetween, metresPer, temperatureIn } from './units';

const temperatureQuantity = quantitySchema.describe('Temperature { value, unit } with unit degC, K or degF. There is no default.');

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('uniform').describe('The same temperature at every node.'), value: temperatureQuantity }),
  z.object({
    kind: z.literal('expression').describe('Temperature computed at each mesh node from an expression in x, y, z.'),
    expression: z
      .string()
      .min(1)
      .describe('Arithmetic expression of x, y, z (+ - * /, pi, sqrt, hypot, pow, sin, exp, ...; no ^). Example: "20 + 0.5 * z".'),
    coordinatesUnit: z.enum(['mm', 'm', 'in']).describe('Unit x, y, z are expressed in when the expression is evaluated.'),
    temperatureUnit: z.enum(['degC', 'K', 'degF']).describe('Unit of the expression result.'),
  }),
  z.object({
    kind: z.literal('thermal_result').describe('Nodal temperatures of a solved heat_steady / heat_transient analysis on the SAME mesh.'),
    analysisId: analysisIdSchema.describe('Id of the solved heat_* analysis that provides the temperatures.'),
    time: z.union([z.number(), z.literal('last')]).describe('Output time in seconds (an output time of the thermal results) or "last".'),
  }),
  z.object({
    kind: z.literal('table').describe('Temperatures from a table of x, y, z, T rows stored in the artifact store, matched to mesh nodes.'),
    csvSha256: z.string().min(1).describe('sha256 of the table artifact in the artifact store (written by fea_import_field).'),
    rows: z.number().int().min(1).describe('Number of rows of the table (checked against the artifact).'),
    coordinatesUnit: z.string().describe('Unit of the x, y, z columns, e.g. "mm".'),
    temperatureUnit: z.string().describe('Unit of the T column: degC, K or degF.'),
  }),
]);

const cteBasisSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('secant').describe('The cte values are secant coefficients about a reference temperature.'),
    referenceTemperature: temperatureQuantity.describe('Reference temperature the secant coefficients are relative to.'),
  }),
  z.object({ kind: z.literal('instantaneous').describe('The cte values are instantaneous (tangent) coefficients.') }),
]);

function withSetup(doc: CadDocument, analysisId: string, setup: ThermoMechSetup): CadDocument {
  const analysisCase = caseOf(doc, analysisId);
  return analysisCase === undefined ? doc : withCase(doc, { ...analysisCase, thermomech: setup });
}

/**
 * @affects doc.analysis.cases[analysisId].thermomech.referenceTemperature (affected: [analysisId])
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not thermo_static -> THM_CASE_TYPE; bad value / unit -> THM_UNITS_MISMATCH (refusals)
 */
export const setReferenceTemperature = defineCommand({
  name: 'set_reference_temperature',
  description:
    'Set the stress-free (reference) temperature of a thermo_static analysis: the temperature at which the parts carry no thermal strain. ' +
    'Thermal strain is the secant CTE times (T - reference), and the reference is also the initial temperature of the solve. There is no ' +
    'default; it must be stated with a unit (degC, K, degF). Changing it makes recorded mesh-independent results stale.',
  annotations: { idempotent: true },
  params: z.object({
    analysisId: analysisIdSchema.describe('Id of a thermo_static analysis.'),
    value: z.number().describe('Reference temperature value in `unit`.'),
    unit: z.string().describe('Temperature unit: degC, K or degF.'),
  }),
  run: (doc, { analysisId, value, unit }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseTmc(
        doc,
        'set_reference_temperature',
        'FEA_ANALYSIS_NOT_FOUND',
        `no analysis '${analysisId}'`,
        [analysisId],
        ['analysisId'],
      );
    if (analysisCase.type !== 'thermo_static')
      return refuseTmc(
        doc,
        'set_reference_temperature',
        'THM_CASE_TYPE',
        `analysis '${analysisId}' is ${analysisCase.type}, not thermo_static`,
        [analysisId],
      );
    const problem = temperatureProblem({ value, unit });
    if (problem !== null)
      return refuseTmc(doc, 'set_reference_temperature', 'THM_UNITS_MISMATCH', problem, [analysisId], ['value', 'unit']);
    const setup: ThermoMechSetup = {
      temperatureScale: 'degC',
      loadCaseName: 'thermal',
      ...analysisCase.thermomech,
      referenceTemperature: { value, unit },
    };
    return changed(
      withSetup(doc, analysisId, setup),
      `set_reference_temperature: '${analysisId}' reference temperature ${value} ${unit}.`,
      [analysisId],
    );
  },
});

type SourceInput = z.output<typeof sourceSchema>;

/** Refusal text for an unusable source, or null; `code` is the stable code to raise. */
function sourceProblem(doc: CadDocument, source: SourceInput): { code: string; message: string } | null {
  switch (source.kind) {
    case 'uniform': {
      const problem = temperatureProblem(source.value);
      return problem === null ? null : { code: 'THM_UNITS_MISMATCH', message: problem };
    }
    case 'expression': {
      const problem = expressionProblem(source.expression);
      return problem === null ? null : { code: 'TMC_FIELD_INVALID', message: `expression '${source.expression}': ${problem}` };
    }
    case 'thermal_result': {
      const thermal = caseOf(doc, source.analysisId);
      if (thermal === undefined || (thermal.type !== 'heat_steady' && thermal.type !== 'heat_transient'))
        return { code: 'TMC_FIELD_SOURCE_INVALID', message: `'${source.analysisId}' is not a heat_steady / heat_transient analysis` };
      if (source.time !== 'last' && (!Number.isFinite(source.time) || source.time < 0))
        return {
          code: 'TMC_FIELD_SOURCE_INVALID',
          message: `time ${String(source.time)} must be "last" or a finite number of seconds >= 0`,
        };
      return null;
    }
    case 'table':
      return affineBetween(source.temperatureUnit, 'K') === null || metresPer(source.coordinatesUnit) === null
        ? { code: 'TMC_FIELD_SOURCE_INVALID', message: `table units '${source.coordinatesUnit}' / '${source.temperatureUnit}' are invalid` }
        : null;
  }
}

const toField = (source: SourceInput): TemperatureFieldSource =>
  source.kind === 'thermal_result' ? { ...source, mapping: 'same_mesh' } : source;

/**
 * @affects doc.analysis.cases[analysisId].thermomech.field (and cteBasis per material when given; affected: [analysisId])
 * @invariant a thermal_result source must be a heat_* analysis; expressions read only x, y, z; units valid
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not thermo_static -> THM_CASE_TYPE; missing / non-heat case or bad time / table units ->
 *   TMC_FIELD_SOURCE_INVALID; unparsable expression -> TMC_FIELD_INVALID; bad temperature -> THM_UNITS_MISMATCH (refusals)
 */
export const setTemperatureField = defineCommand({
  name: 'set_temperature_field',
  description:
    'Set the temperature field a thermo_static analysis is loaded with (replaces the previous one). source.kind: uniform (one value ' +
    'for all nodes), expression (a function of node coordinates x, y, z evaluated at every mesh node at deck time), thermal_result ' +
    '(nodal temperatures of a SOLVED heat_steady / heat_transient analysis meshed identically, at an output time or "last"; a ' +
    're-solved or edited thermal analysis makes this analysis stale) or table (x, y, z, T rows in the artifact store). Optional ' +
    'cteBasis states, per material id, whether its cte property model is secant (about a reference temperature) or instantaneous; ' +
    'without it a cte model of unstated basis is refused at solve time (a thermalStrain model needs none). Next: check_thermo_mechanical.',
  annotations: { idempotent: true },
  params: z.object({
    analysisId: analysisIdSchema.describe('Id of a thermo_static analysis.'),
    source: sourceSchema.describe('Where the nodal temperatures come from.'),
    cteBasis: z
      .record(z.string(), cteBasisSchema)
      .optional()
      .describe('Per material id: the stated basis of its cte property model. Entries replace earlier entries of the same material.'),
  }),
  run: (doc, { analysisId, source, cteBasis }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId], paths: readonly string[] = []): CommandResult =>
      refuseTmc(doc, 'set_temperature_field', code, message, ids, paths);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    const setup = thermomechOf(analysisCase);
    if (setup === undefined) return fail('THM_CASE_TYPE', `analysis '${analysisId}' is ${analysisCase.type}, not thermo_static`);
    const problem = sourceProblem(doc, source);
    if (problem !== null)
      return fail(problem.code, problem.message, source.kind === 'thermal_result' ? [analysisId, source.analysisId] : [analysisId], [
        'source',
      ]);
    const bases: Record<string, CteBasisSpec> = { ...setup.cteBasis };
    for (const [material, basis] of Object.entries(cteBasis ?? {})) {
      if (basis.kind === 'secant' && temperatureIn(basis.referenceTemperature, 'K') === null)
        return fail(
          'THM_UNITS_MISMATCH',
          `cteBasis.${material}.referenceTemperature has an invalid temperature unit`,
          [analysisId],
          ['cteBasis'],
        );
      bases[material] = basis;
    }
    const next: ThermoMechSetup = { ...setup, field: toField(source), ...(Object.keys(bases).length > 0 ? { cteBasis: bases } : {}) };
    const basisNote = cteBasis === undefined ? '' : `; cteBasis for ${Object.keys(cteBasis).join(', ') || 'no material'}`;
    return changed(
      withSetup(doc, analysisId, next),
      `set_temperature_field: '${analysisId}' field ${source.kind}${source.kind === 'thermal_result' ? ` from '${source.analysisId}' at ${String(source.time)}` : ''}${basisNote}.`,
      [analysisId],
    );
  },
});
