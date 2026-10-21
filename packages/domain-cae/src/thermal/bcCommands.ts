/** add_thermal_bc / update_thermal_bc: thermal boundary conditions and loads of a heat_* analysis. */

import type { ThermalBc, ThermalBcRecord } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analysisIdSchema } from '../shared/schemas';
import { targetDistanceWarning } from '../shared/target';
import { isProblem, problem, thermalCaseOf, withThermal, type Problem, type ThermalCase } from './access';
import { amplitudeIdOf, assembleBc, BC_KINDS, bcFieldsSchema, plainSource, recordProblem, unusedFields, type BcFields } from './bcModel';
import { refuseThermal } from './codes';

const describeBc = (bc: ThermalBc): string => {
  switch (bc.kind) {
    case 'film':
      return `film h=${'value' in bc.filmCoefficient ? `${bc.filmCoefficient.value} ${bc.filmCoefficient.unit}` : 'h(T) table'}, sink ${bc.sinkTemperature.value} ${bc.sinkTemperature.unit}`;
    case 'radiation':
      return `radiation e=${bc.emissivity}, sink ${bc.sinkTemperature.value} ${bc.sinkTemperature.unit}`;
    case 'heat_generation':
      return `heat_generation ${bc.value.value} ${bc.value.unit} (${bc.mode}) in ${bc.entityId}`;
    default:
      return `${bc.kind} ${bc.value.value} ${bc.value.unit}`;
  }
};

const fieldsOf = (params: BcFields): BcFields => ({
  value: params.value,
  unit: params.unit,
  filmCoefficient: params.filmCoefficient,
  filmTable: params.filmTable,
  sinkTemperature: params.sinkTemperature,
  emissivity: params.emissivity,
  mode: params.mode,
  entityId: params.entityId,
  target: params.target,
});

const defined = (fields: BcFields): BcFields =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as BcFields;

/**
 * @affects doc.analysis.cases[analysisId].thermal.bcs (adds 1 BC, id `tb-<step>.<k>`; affected: [bcId])
 * @invariant 0 <= emissivity <= 1; h > 0; quantity dimension matches the kind; film h and emissivity carry `source`; amplitude exists
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; other case type -> THM_CASE_TYPE; wrong dimension -> THM_UNITS_MISMATCH;
 *   emissivity outside [0, 1] -> THM_EMISSIVITY_INVALID; h <= 0 -> THM_FILM_INVALID; no source -> THM_SOURCE_REQUIRED; bad target ->
 *   FEA_TARGET_UNRESOLVED / FEA_PART_NOT_IN_ANALYSIS; unused parameter -> FEA_PARAM_NOT_APPLICABLE; unknown amplitude -> THM_AMPLITUDE_INVALID
 */
export const addThermalBc = defineCommand({
  name: 'add_thermal_bc',
  description:
    'Add a thermal boundary condition or load to a heat_steady / heat_transient analysis; returns the BC id in affected[0]. kind: ' +
    'temperature (value+unit degC | K, on faces / edges / points), surface_flux (W/m^2, positive INTO the part, on faces), heat_generation ' +
    '(W/m^3, or total W with mode "total" spread over the part volume, on a part via entityId), concentrated_flux (W at points), film ' +
    '(filmCoefficient W/(m^2*K), or filmTable { points: [[T, h], ...] } for h(T) of the face temperature in heat_steady cases, and sinkTemperature), radiation (emissivity 0-1 and sinkTemperature; evaluated on absolute temperature). ' +
    'Film coefficients and emissivities are NEVER defaulted: pass `source` with a citation. Faces are given as points near them (facesNear, ' +
    'document units). amplitude names a define_amplitude curve that scales the value (sink temperature for film / radiation) over time. ' +
    'Refuses emissivity outside [0, 1], h <= 0, a wrong unit dimension or a non-thermal case. Next: set_thermal_step (transient), ' +
    'set_mesh_controls, check_thermal, then the host runs fea_mesh and fea_solve.',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Display name, e.g. "hot face film".'),
    kind: z.enum(BC_KINDS).describe('temperature | surface_flux | heat_generation | concentrated_flux | film | radiation.'),
    ...bcFieldsSchema,
  }),
  run: (doc, params): CommandResult => {
    const fail = (found: Problem): CommandResult => refuseThermal(doc, 'add_thermal_bc', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, params.analysisId);
    if (isProblem(found)) return fail(found);
    const fields = fieldsOf(params);
    const unused = unusedFields(params.kind, fields);
    if (unused.length > 0)
      return fail(
        problem('FEA_PARAM_NOT_APPLICABLE', `${unused.join(', ')} do not apply to a ${params.kind} BC`, [params.analysisId], unused),
      );
    const bc = assembleBc(params.kind, fields);
    if ('code' in bc) return fail(bc);
    let amplitude: string | undefined;
    if (params.amplitude !== undefined) {
      const id = amplitudeIdOf(found.thermal, params.amplitude);
      if (id === null)
        return fail(problem('THM_AMPLITUDE_INVALID', `no amplitude '${params.amplitude}'`, [params.analysisId], ['amplitude']));
      amplitude = id;
    }
    const record: ThermalBcRecord = {
      id: nextId('tb'),
      name: params.name,
      bc,
      ...(amplitude !== undefined ? { amplitude } : {}),
      ...(params.source !== undefined ? { source: plainSource(params.source) } : {}),
    };
    const invalid = recordProblem(doc, found.analysisCase, found.thermal, record);
    if (invalid !== null) return fail({ ...invalid, ids: invalid.ids.length > 0 ? invalid.ids : [params.analysisId] });
    const thermal = {
      ...found.thermal,
      bcs: { ...found.thermal.bcs, [record.id]: record },
      bcOrder: [...found.thermal.bcOrder, record.id],
    };
    return changed(
      withThermal(doc, found, thermal),
      `add_thermal_bc: '${record.id}' (${params.name}) ${describeBc(bc)}${amplitude !== undefined ? `, amplitude '${amplitude}'` : ''} in '${params.analysisId}'.${params.target !== undefined ? targetDistanceWarning(doc, params.target) : ''}`,
      [record.id],
    );
  },
});

const recordOf = (found: ThermalCase, bcId: string): ThermalBcRecord | undefined =>
  Object.hasOwn(found.thermal.bcs, bcId) ? found.thermal.bcs[bcId] : undefined;

/**
 * @affects doc.analysis.cases[analysisId].thermal.bcs[bcId] (given fields replaced; the kind never changes)
 * @invariant the result satisfies every add_thermal_bc invariant
 * @failure unknown analysis / BC, parameter the kind does not use, invalid result -> refusal with the add_thermal_bc codes, unchanged doc
 */
export const updateThermalBc = defineCommand({
  name: 'update_thermal_bc',
  description:
    'Change a thermal BC: name, value+unit, filmCoefficient, filmTable, sinkTemperature, emissivity, mode, entityId, target, amplitude or source. ' +
    'Only the given fields change; the kind cannot change (delete and add instead). The result is validated like add_thermal_bc ' +
    '(emissivity 0-1, h > 0, source for film / radiation, unit dimensions). amplitude "" removes the amplitude.',
  params: z.object({
    analysisId: analysisIdSchema,
    bcId: z.string().describe('BC id (affected[0] of add_thermal_bc).'),
    name: z.string().min(1).optional().describe('New display name.'),
    ...bcFieldsSchema,
  }),
  run: (doc, params): CommandResult => {
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'update_thermal_bc', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, params.analysisId);
    if (isProblem(found)) return fail(found);
    const existing = recordOf(found, params.bcId);
    if (existing === undefined)
      return fail(
        problem('THM_BC_NOT_FOUND', `no thermal BC '${params.bcId}' in '${params.analysisId}'`, [params.analysisId, params.bcId], ['bcId']),
      );
    const fields = defined(fieldsOf(params));
    const unused = unusedFields(existing.bc.kind, fields);
    if (unused.length > 0)
      return fail(
        problem('FEA_PARAM_NOT_APPLICABLE', `${unused.join(', ')} do not apply to a ${existing.bc.kind} BC`, [params.bcId], unused),
      );
    const bc = assembleBc(existing.bc.kind, fields, existing.bc);
    if ('code' in bc) return fail(bc);
    let amplitude: string | undefined = existing.amplitude;
    if (params.amplitude === '') amplitude = undefined;
    else if (params.amplitude !== undefined) {
      const id = amplitudeIdOf(found.thermal, params.amplitude);
      if (id === null) return fail(problem('THM_AMPLITUDE_INVALID', `no amplitude '${params.amplitude}'`, [params.bcId], ['amplitude']));
      amplitude = id;
    }
    const source = params.source !== undefined ? plainSource(params.source) : existing.source;
    const updated: ThermalBcRecord = {
      id: existing.id,
      name: params.name ?? existing.name,
      bc,
      ...(amplitude !== undefined ? { amplitude } : {}),
      ...(source !== undefined ? { source } : {}),
    };
    const invalid = recordProblem(doc, found.analysisCase, found.thermal, updated);
    if (invalid !== null) return fail({ ...invalid, ids: invalid.ids.length > 0 ? invalid.ids : [params.bcId] });
    const thermal = { ...found.thermal, bcs: { ...found.thermal.bcs, [updated.id]: updated } };
    return changed(
      withThermal(doc, found, thermal),
      `update_thermal_bc: '${updated.id}' (${updated.name}) now ${describeBc(bc)} in '${params.analysisId}'.${params.target !== undefined ? targetDistanceWarning(doc, params.target) : ''}`,
      [updated.id],
    );
  },
});
