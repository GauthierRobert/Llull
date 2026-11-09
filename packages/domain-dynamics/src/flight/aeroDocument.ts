/** Load-time validation of the aero surface table and of the turbulence / pivot fields of `CadDocument.flight` (13 FLT M4). */

import { z } from '@core/commands/schema';
import { isRecord } from '@lib/isRecord';
import { MAX_TURBULENCE_TAU_S } from './turbulence';

const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const text = z.string().trim().min(1);
const finite = z.number();
const positive = z.number().positive();
const vec3 = z.tuple([finite, finite, finite]);
const grid = z.array(z.array(finite).min(1).max(100)).min(2).max(100);

export const turbulenceSchema = z.strictObject({
  sigmaMps: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]),
  lengthScaleM: z.tuple([positive, positive, positive]),
  airspeedMps: positive,
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/** Why `spec` (a turbulence field) cannot be realised, or null: a filter time constant L / V over MAX_TURBULENCE_TAU_S. */
export function turbulenceProblem(spec: { readonly lengthScaleM: readonly number[]; readonly airspeedMps: number }): string | null {
  const tau = Math.max(...spec.lengthScaleM) / spec.airspeedMps;
  return tau > MAX_TURBULENCE_TAU_S
    ? `turbulence lengthScaleM / airspeedMps = ${tau.toPrecision(4)} s exceeds ${MAX_TURBULENCE_TAU_S} s`
    : null;
}

/** Reserved record keys among the pivot commands of the raw flight slice's scenarios (zod would drop an own "__proto__" key). */
export function reservedPivotKeys(slice: unknown): string[] {
  const scenarios = isRecord(slice) && isRecord(slice['scenarios']) ? slice['scenarios'] : {};
  return Object.entries(scenarios).flatMap(([key, scenario]) => {
    const setpoints = isRecord(scenario) && Array.isArray(scenario['setpoints']) ? scenario['setpoints'] : [];
    return setpoints.flatMap((setpoint: unknown, k) => {
      const commands = isRecord(setpoint) && isRecord(setpoint['pivotDeg']) ? setpoint['pivotDeg'] : {};
      return Object.keys(commands)
        .filter((name) => RESERVED_KEYS.has(name))
        .map((name) => `flight.scenarios.${key}.setpoints.${k}.pivotDeg.${name}: reserved key`);
    });
  });
}

export const pivotCommandsSchema = z.record(text, finite).optional();

export const aeroSurfaceSchema = z.strictObject({
  id: text,
  bodyId: text,
  momentCentre: vec3,
  forward: z.enum(['+x', '-x', '+y', '-y']),
  refAreaM2: positive,
  refChordM: positive,
  refSpanM: positive,
  airDensity: positive,
  table: z.strictObject({
    alphaDeg: z.array(finite).min(2).max(100),
    pivotDeg: z.array(finite).min(1).max(100),
    cl: grid,
    cd: grid,
    cm: grid,
  }),
  validAlphaDeg: z.tuple([finite, finite]),
  profileDrag: z.strictObject({ cd0: z.number().min(0), clMax: positive.nullable(), source: text.nullable() }),
  provenance: z.literal('vlm+polar'),
  unverified: z.boolean(),
  servo: z.strictObject({ rateDegS: positive, minDeg: finite, maxDeg: finite, neutralDeg: finite }).nullable(),
  inputsHash: text,
  designHash: text,
  solver: z.strictObject({ engine: text, panels: z.number().int().min(0), calls: z.number().int().min(1) }),
  defaulted: z.array(z.string()),
});

const increasing = (axis: readonly number[]): boolean => axis.every((value, i) => i === 0 || value > (axis[i - 1] ?? Infinity));

interface AeroSlice {
  readonly rotors: Readonly<Record<string, unknown>>;
  readonly controllers?: Readonly<Record<string, unknown>> | undefined;
  readonly scenarios?:
    | Readonly<
        Record<
          string,
          {
            readonly bodyId: string;
            readonly wind: { readonly turbulence?: z.infer<typeof turbulenceSchema> | undefined };
            readonly setpoints: readonly { readonly pivotDeg?: Readonly<Record<string, number>> | undefined }[];
          }
        >
      >
    | undefined;
  readonly batteries?: Readonly<Record<string, unknown>> | undefined;
  readonly powertrains?: Readonly<Record<string, unknown>> | undefined;
  readonly aeroSurfaces?: Readonly<Record<string, z.infer<typeof aeroSurfaceSchema>>> | undefined;
}

/** Key, id, table shape, servo and pivot-command checks of the aero surfaces the schema cannot express. */
export function aeroErrors(slice: AeroSlice, dynamicsIds: ReadonlySet<string>, bodyCheck: (at: string, id: string) => void): string[] {
  const errors: string[] = [];
  const surfaces = slice.aeroSurfaces ?? {};
  for (const [key, entry] of Object.entries(surfaces)) {
    const at = `flight.aeroSurfaces.${key}`;
    if (entry.id !== key) errors.push(`${at}.id must equal its key`);
    const other = [slice.rotors, slice.controllers, slice.scenarios, slice.batteries, slice.powertrains].some(
      (table) => table !== undefined && Object.hasOwn(table, key),
    );
    if (dynamicsIds.has(key) || other) errors.push(`${at}: id '${key}' is also a dynamics record or another flight record`);
    bodyCheck(at, entry.bodyId);
    const { table } = entry;
    if (!increasing(table.alphaDeg) || !increasing(table.pivotDeg))
      errors.push(`${at}.table: alphaDeg and pivotDeg must strictly increase`);
    for (const name of ['cl', 'cd', 'cm'] as const)
      if (table[name].length !== table.alphaDeg.length || table[name].some((row) => row.length !== table.pivotDeg.length))
        errors.push(`${at}.table.${name}: needs one row per angle of attack and one column per pivot angle`);
    if (!(entry.validAlphaDeg[0] <= entry.validAlphaDeg[1])) errors.push(`${at}.validAlphaDeg: must be ascending`);
    const { servo } = entry;
    const pivotLow = table.pivotDeg[0] ?? 0;
    const pivotHigh = table.pivotDeg[table.pivotDeg.length - 1] ?? 0;
    if ((servo === null) !== (table.pivotDeg.length === 1))
      errors.push(`${at}.servo: present exactly when the table has more than one pivot angle`);
    else if (
      servo !== null &&
      !(
        pivotLow <= servo.minDeg &&
        servo.minDeg <= servo.maxDeg &&
        servo.maxDeg <= pivotHigh &&
        servo.minDeg <= servo.neutralDeg &&
        servo.neutralDeg <= servo.maxDeg
      )
    )
      errors.push(`${at}.servo: minDeg <= neutralDeg <= maxDeg must lie inside the table's pivot range`);
  }
  for (const [key, scenario] of Object.entries(slice.scenarios ?? {})) {
    const turbulence = scenario.wind.turbulence;
    const problem = turbulence === undefined ? null : turbulenceProblem(turbulence);
    if (problem !== null) errors.push(`flight.scenarios.${key}.wind: ${problem}`);
    scenario.setpoints.forEach((setpoint, k) => {
      for (const id of Object.keys(setpoint.pivotDeg ?? {})) {
        const surface = Object.hasOwn(surfaces, id) ? surfaces[id] : undefined;
        const at = `flight.scenarios.${key}.setpoints.${k}.pivotDeg`;
        if (surface === undefined || surface.servo === null) errors.push(`${at}: '${id}' is not an aero surface with a pivot servo`);
        else if (surface.bodyId !== scenario.bodyId) errors.push(`${at}: surface '${id}' is on another body`);
      }
    });
  }
  return errors;
}
