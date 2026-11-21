/** The COMPONENT-ATTRIBUTE1..10 slots of a stress model's operating conditions (07 PST §6, PST-FU2); shared by `pipe_stress_pcf_attributes` and `export_pcf`. */

import { maxOf } from '@lib/arrayExtrema';
import type { OperatingConditions } from '../model/schema';

/** Meaning and unit of COMPONENT-ATTRIBUTE1..10 as CAESAR II reads them (05 ISO `pcf_keywords.json` caesarIIAttributeMap, source S3, grade B; units are llull's, stated in the result). */
export const SLOTS = [
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

export function pcfAttributeValues(conditions: OperatingConditions): {
  readonly slots: (string | null)[];
  readonly omitted: Record<string, string>;
} {
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
