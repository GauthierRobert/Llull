/** `pipe_stress_pcf_attributes` (07 PST §6, PST-FU2): the CAESAR II COMPONENT-ATTRIBUTE1..10 values of a stress model, for the PCF of 05 ISO. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { maxOf } from '@lib/arrayExtrema';
import { refuse } from '../codes';
import type { OperatingConditions } from '../model/schema';
import { isRefusal, modelOr } from './common';

/** Meaning and unit of COMPONENT-ATTRIBUTE1..10 as CAESAR II reads them (05 ISO `pcf_keywords.json` caesarIIAttributeMap, source S3, grade B; units are llull's, stated in the result). */
const SLOTS = [
  ['design pressure', 'bar (gauge)'],
  ['max temperature', 'degC'],
  ['material name', ''],
  ['wall thickness', 'mm'],
  ['insulation thickness', 'mm'],
  ['insulation density', 'kg/m3'],
  ['corrosion allowance', 'mm'],
  ['component weight', 'kg'],
  ['fluid density', 'kg/m3'],
  ['hydro test pressure', 'bar (gauge)'],
] as const;

const number = (value: number): string => String(Number(value.toPrecision(10)));

function values(conditions: OperatingConditions): { readonly slots: (string | null)[]; readonly omitted: Record<string, string> } {
  const pressures = conditions.pressures.map((entry) => entry.gaugeBar);
  const temps = conditions.temperatures.map((entry) => entry.tempC);
  const slots: (string | null)[] = [
    pressures.length === 0 ? null : number(maxOf(pressures)),
    temps.length === 0 ? null : number(maxOf(temps)),
    null,
    conditions.wallMm === undefined ? null : number(conditions.wallMm),
    conditions.insulation === undefined ? null : number(conditions.insulation.thicknessMm),
    conditions.insulation === undefined ? null : number(conditions.insulation.densityKgM3),
    number(conditions.corrosionAllowanceMm),
    null,
    number(conditions.fluidDensityKgM3),
    conditions.hydro === undefined ? null : number(conditions.hydro.testPressureBar),
  ];
  const omitted: Record<string, string> = {
    'COMPONENT-ATTRIBUTE3': 'the model stores material values, not a material designation: set it in the PCF',
    'COMPONENT-ATTRIBUTE8': 'component weights are per component (set_stress_component weightKg), not model-wide',
    ...(pressures.length === 0 ? { 'COMPONENT-ATTRIBUTE1': 'no pressure P1..P9 stored' } : {}),
    ...(temps.length === 0 ? { 'COMPONENT-ATTRIBUTE2': 'no temperature T1..T9 stored' } : {}),
    ...(conditions.wallMm === undefined
      ? { 'COMPONENT-ATTRIBUTE4': 'no wall override in the conditions: each pipe keeps its own wall' }
      : {}),
    ...(conditions.insulation === undefined
      ? { 'COMPONENT-ATTRIBUTE5': 'no insulation stored', 'COMPONENT-ATTRIBUTE6': 'no insulation stored' }
      : {}),
    ...(conditions.hydro === undefined ? { 'COMPONENT-ATTRIBUTE10': 'no hydrotest conditions stored' } : {}),
  };
  return { slots, omitted };
}

/**
 * @affects none (query); data = { modelId, pipeIds, runIds, attributes { "COMPONENT-ATTRIBUTE<n>": text }, lines, slots[{ key, meaning, unit, value }], omitted, unitsGrade, reviewRequired }
 * @invariant read-only; the slot meanings are the CAESAR II PCF import map of the 05 ISO keyword table (grade B); design pressure = the largest stored P gauge pressure, max temperature = the largest stored T; a slot with no stored value is omitted with its reason, never defaulted
 * @failure unknown model -> PST_MODEL_NOT_FOUND; model without operating conditions -> PST_CONDITIONS_MISSING
 */
export const pipeStressPcfAttributes = defineCommand({
  name: 'pipe_stress_pcf_attributes',
  description:
    'Query: the stress-relevant PCF component attributes of a pipe stress model, as CAESAR II reads COMPONENT-ATTRIBUTE1..10 from a PCF: 1 design pressure, 2 max temperature, 3 material name, 4 wall thickness, 5 insulation thickness, 6 insulation density, 7 corrosion allowance, 8 component weight, 9 fluid density, 10 hydro test pressure (the map is secondary-source, grade B). ' +
    'Values come from the stored operating conditions (set_pipe_operating_conditions): design pressure is the largest stored P gauge pressure in bar, max temperature the largest T in degC, then mm and kg/m3; the PCF does not state units for these attributes, so check them against the receiving tool (unitsGrade C). A slot with no stored value (material name, component weight, an unset wall / insulation / hydrotest) is listed in `omitted` with its reason, never defaulted. ' +
    'Returns data { modelId, pipeIds (building pipes of the model scope; [] for a run-scoped model), runIds (run ids of a run-scoped model; [] otherwise), the PCF lines of these pipes / runs carry the attributes, attributes, lines (one "COMPONENT-ATTRIBUTE<n> <value>" text per slot, ready for a PCF component record), slots, omitted, unitsGrade, reviewRequired }. Support-type attributes are not produced (the SUPPORT attribute names of the PCF writer are an open question, OQ-ISO-01). Read-only.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({ modelId: z.string().min(1).describe('Id of the stress model.') }),
  run: (doc, { modelId }): CommandResult => {
    const model = modelOr(doc, 'pipe_stress_pcf_attributes', modelId);
    if (isRefusal(model)) return model;
    if (model.conditions === undefined)
      return refuse(
        doc,
        'pipe_stress_pcf_attributes',
        'PST_CONDITIONS_MISSING',
        `model ${model.id} has no operating conditions`,
        [model.id],
        ['conditions'],
      );
    const { slots, omitted } = values(model.conditions);
    const rows = SLOTS.map(([meaning, unit], index) => ({
      key: `COMPONENT-ATTRIBUTE${index + 1}`,
      meaning,
      unit,
      value: slots[index] ?? null,
    }));
    const present = rows.filter((row) => row.value !== null);
    return report(
      doc,
      `pipe_stress_pcf_attributes: ${model.id}, ${present.length} of 10 attribute(s) (${present.map((row) => row.key.replace('COMPONENT-ATTRIBUTE', '')).join(', ')}), ${Object.keys(omitted).length} omitted; units are llull's (bar gauge, degC, mm, kg/m3), review required.`,
      {
        modelId: model.id,
        pipeIds: model.scope.kind === 'pipes' ? model.scope.ids : [],
        runIds: model.scope.kind === 'runs' ? model.scope.ids : [],
        attributes: Object.fromEntries(present.map((row) => [row.key, row.value])),
        lines: present.map((row) => `${row.key} ${row.value}`),
        slots: rows,
        omitted,
        unitsGrade: 'C',
        reviewRequired: true,
      },
    );
  },
});
