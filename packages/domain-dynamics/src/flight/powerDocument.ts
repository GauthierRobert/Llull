/** Load-time validation of the battery and powertrain tables of `CadDocument.flight` (13 FLT M3): the zod schemas and the cross-reference checks. */

import { z } from '@core/commands/schema';
import { datasheetSchema } from '../commands/motorSchemas';

const text = z.string().trim().min(1);

export const batterySchema = z.strictObject({
  id: text,
  cellsSeries: z.number().int().min(1).max(100),
  capacityMah: z.number().positive(),
  internalResistanceOhm: z.number().min(0),
  ocv: z
    .array(z.tuple([z.number(), z.number().positive()]))
    .min(2)
    .max(200),
  cutoffVoltPerCell: z.number().positive(),
  initialSoc: z.number().min(0).max(1),
  source: text,
  defaulted: z.array(z.string()),
});

export const powertrainSchema = z.strictObject({
  id: text,
  batteryId: text,
  rotorIds: z.array(text).min(1).max(64),
  motor: datasheetSchema,
  motorSource: text,
  escEfficiency: z.number().gt(0).max(1),
  auxiliaryPowerW: z.number().min(0),
  defaulted: z.array(z.string()),
});

/** Why `ocv` (per-cell volts against state of charge) is not a usable open-circuit curve, or null. */
export function ocvProblem(ocv: readonly (readonly [number, number])[], cutoffVoltPerCell: number): string | null {
  const first = ocv[0];
  const last = ocv[ocv.length - 1];
  if (first === undefined || last === undefined || first[0] !== 0 || last[0] !== 1)
    return 'the ocv table must start at state of charge 0 and end at 1';
  if (ocv.some((point, i) => i > 0 && point[0] <= (ocv[i - 1]?.[0] ?? Infinity))) return 'ocv state of charge must strictly increase';
  if (ocv.some((point, i) => i > 0 && point[1] < (ocv[i - 1]?.[1] ?? Infinity)))
    return 'ocv voltage must not decrease with state of charge';
  if (cutoffVoltPerCell >= last[1]) return 'cutoffVoltPerCell must be below the full-charge open-circuit voltage';
  return null;
}

interface PowerSlice {
  readonly rotors: Readonly<Record<string, unknown>>;
  readonly controllers?: Readonly<Record<string, unknown>> | undefined;
  readonly scenarios?: Readonly<Record<string, unknown>> | undefined;
  readonly batteries?: Readonly<Record<string, z.infer<typeof batterySchema>>> | undefined;
  readonly powertrains?: Readonly<Record<string, z.infer<typeof powertrainSchema>>> | undefined;
}

/** Key, id, curve and cross-reference checks of the battery and powertrain tables the schema cannot express. */
export function powerErrors(slice: PowerSlice, dynamicsIds: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const batteries = slice.batteries ?? {};
  const powertrains = slice.powertrains ?? {};
  const taken = (at: string, key: string): void => {
    const other = [slice.rotors, slice.controllers ?? {}, slice.scenarios ?? {}].some((table) => Object.hasOwn(table, key));
    if (dynamicsIds.has(key) || other) errors.push(`${at}: id '${key}' is also a dynamics record, rotor, controller or scenario`);
  };
  for (const [key, entry] of Object.entries(batteries)) {
    const at = `flight.batteries.${key}`;
    if (entry.id !== key) errors.push(`${at}.id must equal its key`);
    taken(at, key);
    if (Object.hasOwn(powertrains, key)) errors.push(`${at}: id '${key}' is also a powertrain`);
    const problem = ocvProblem(entry.ocv, entry.cutoffVoltPerCell);
    if (problem !== null) errors.push(`${at}: ${problem}`);
  }
  const usedBatteries = new Set<string>();
  const usedRotors = new Set<string>();
  for (const [key, entry] of Object.entries(powertrains)) {
    const at = `flight.powertrains.${key}`;
    if (entry.id !== key) errors.push(`${at}.id must equal its key`);
    taken(at, key);
    if (!Object.hasOwn(batteries, entry.batteryId)) errors.push(`${at}.batteryId: '${entry.batteryId}' is not a battery`);
    else if (usedBatteries.has(entry.batteryId)) errors.push(`${at}.batteryId: battery '${entry.batteryId}' feeds another powertrain`);
    usedBatteries.add(entry.batteryId);
    if (new Set(entry.rotorIds).size !== entry.rotorIds.length) errors.push(`${at}.rotorIds: a rotor is listed twice`);
    for (const rotorId of entry.rotorIds) {
      if (!Object.hasOwn(slice.rotors, rotorId)) errors.push(`${at}.rotorIds: '${rotorId}' is not a rotor`);
      else if (usedRotors.has(rotorId)) errors.push(`${at}.rotorIds: rotor '${rotorId}' is on another powertrain`);
      usedRotors.add(rotorId);
    }
  }
  return errors;
}
