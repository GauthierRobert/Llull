/** Battery and powertrain records of the flight slice (13 FLT M3, TR-FLT-06): add_battery, add_flight_powertrain. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, codedRejection, failer } from '@core/commands/noop';
import type { DcMotorDatasheet } from '@core/model/drives';
import { idOrNext } from '@lib/explicitId';
import { checkMotorData } from '../sim/actuators/motorData';
import { ocvProblem } from '../flight/powerDocument';
import { flightOf, idTakenInDynamicsOrFlight } from '../flight/model';
import type { FlightBattery, FlightPowertrain } from '../flight/powerModel';
import { dynamicsOf } from './bodies';
import { inconsistentSheet } from './motorData';
import { datasheetSchema, toDatasheet } from './motorSchemas';

/** Typical rest open-circuit voltage of one LiPo cell against state of charge (used, and flagged `ocv` in `defaulted`, when add_battery gets none). */
const LIPO_OCV: readonly (readonly [number, number])[] = [
  [0, 3.27],
  [0.1, 3.61],
  [0.2, 3.7],
  [0.3, 3.74],
  [0.4, 3.78],
  [0.5, 3.82],
  [0.6, 3.87],
  [0.7, 3.92],
  [0.8, 3.99],
  [0.9, 4.08],
  [1, 4.2],
];
const DEFAULT_CUTOFF_VOLT_PER_CELL = 3.3;
const DEFAULT_ESC_EFFICIENCY = 0.95;
const DEFAULT_INITIAL_SOC = 1;
const NO_AUXILIARY_LOAD_W = 0;

const format = (value: number): string => value.toPrecision(4);

/** Energy of the pack from full to empty along its OCV curve at the capacity, Wh (the trapezoid of V dq). */
function nominalEnergyWh(battery: FlightBattery): number {
  const { ocv } = battery;
  let volts = 0;
  for (let i = 1; i < ocv.length; i++) {
    const lo = ocv[i - 1];
    const hi = ocv[i];
    if (lo !== undefined && hi !== undefined) volts += ((lo[1] + hi[1]) / 2) * (hi[0] - lo[0]);
  }
  return battery.cellsSeries * (battery.capacityMah / 1000) * volts;
}

/**
 * @affects adds 1 battery to doc.flight.batteries (affected: [batteryId])
 * @invariant cellsSeries integer >= 1; capacityMah > 0; internalResistanceOhm >= 0; ocv from state of charge 0 to 1, strictly increasing soc, non-decreasing voltage; cutoff below the full-charge voltage
 * @failure missing source, unusable ocv or cut-off -> FLT_ECM_INVALID / no-op; taken id -> no-op
 */
export const addBattery = defineCommand({
  name: 'add_battery',
  description:
    'Add a battery pack for run_flight and estimate_endurance (13 FLT): an equivalent circuit V = OCV(SoC) - R_int·I with dSoC/dt = -I / (3600·C), ' +
    'cut off when the terminal voltage falls below cutoffVoltPerCell × cellsSeries (the ESC low-voltage cut-off: the motors then stop). ' +
    'Units: capacityMah is the capacity of the WHOLE pack in mAh (a 4S2P pack of 2800 mAh cells is 5600), internalResistanceOhm the resistance of the ' +
    'whole pack in ohm (the sum over series cells divided by parallel strings), ocv the open-circuit voltage of ONE cell in volt against state of charge ' +
    '0..1 (rest voltage; the pack voltage is cellsSeries times it). Without `ocv` a typical LiPo curve (3.27 V empty, 3.82 V half, 4.20 V full) is used ' +
    'and the result is flagged unverified; without cutoffVoltPerCell 3.3 V (also flagged). `source` (datasheet, bench measurement) is required. ' +
    'Feed motors with add_flight_powertrain. Returns the battery id in affected[0].',
  params: z.object({
    cellsSeries: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe('Cells in series (the S of 4S2P): pack voltage = cellsSeries × the per-cell voltage.'),
    capacityMah: z.number().positive().describe('Capacity of the whole pack, mAh (4S2P of 2800 mAh cells = 5600).'),
    internalResistanceOhm: z
      .number()
      .min(0)
      .describe('Internal resistance of the whole pack, ohm (pack-level DC resistance; 0 = ideal source).'),
    ocv: z
      .array(z.tuple([z.number(), z.number().positive()]))
      .min(2)
      .max(200)
      .optional()
      .describe(
        '[[SoC, volts per cell], ...]: SoC 0..1 strictly increasing from 0 to 1, voltage non-decreasing (FLT_ECM_INVALID otherwise). Default: a typical LiPo curve (unverified).',
      ),
    cutoffVoltPerCell: z
      .number()
      .positive()
      .optional()
      .describe('Terminal voltage per cell, V, under which the pack is cut off (below the full-charge OCV). Default 3.3 (unverified).'),
    initialSoc: z.number().min(0).max(1).optional().describe('State of charge at the start of every run, 0..1. Default 1.'),
    source: z.string().describe('Where the numbers come from (cell datasheet, bench test); required, non-empty.'),
    id: z.string().optional().describe('Optional explicit battery id (shares the id space of the dynamics records).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_battery');
    if (params.source.trim() === '') return fail('source is empty: say where the battery numbers come from');
    const defaulted: string[] = [];
    if (params.ocv === undefined) defaulted.push('ocv');
    if (params.cutoffVoltPerCell === undefined) defaulted.push('cutoffVoltPerCell');
    const ocv = params.ocv ?? LIPO_OCV;
    const cutoffVoltPerCell = params.cutoffVoltPerCell ?? DEFAULT_CUTOFF_VOLT_PER_CELL;
    const problem = ocvProblem(ocv, cutoffVoltPerCell);
    if (problem !== null)
      return codedRejection(
        doc,
        'add_battery',
        'FLT_ECM_INVALID',
        problem,
        'Give ocv as [[0, v0], ..., [1, v1]] per cell, volts non-decreasing, and a cutoffVoltPerCell below the last voltage.',
      );
    const id = idOrNext(params.id, 'battery');
    if (idTakenInDynamicsOrFlight(doc, id)) return fail(`id '${id}' is already used`);
    const battery: FlightBattery = {
      id,
      cellsSeries: params.cellsSeries,
      capacityMah: params.capacityMah,
      internalResistanceOhm: params.internalResistanceOhm,
      ocv,
      cutoffVoltPerCell,
      initialSoc: params.initialSoc ?? DEFAULT_INITIAL_SOC,
      source: params.source.trim(),
      defaulted,
    };
    const flight = flightOf(doc);
    const nominalWh = nominalEnergyWh(battery);
    return changed(
      { ...doc, flight: { ...flight, batteries: { ...flight.batteries, [id]: battery } } },
      `add_battery: '${id}' — ${battery.cellsSeries}S, ${format(battery.capacityMah)} mAh (${format(nominalWh)} Wh, mean-OCV nominal), R_int ${format(battery.internalResistanceOhm)} Ω, ` +
        `full ${format(battery.cellsSeries * (ocv[ocv.length - 1]?.[1] ?? 0))} V, cut-off ${format(cutoffVoltPerCell * battery.cellsSeries)} V, start SoC ${format(battery.initialSoc)} (${battery.source})` +
        `${defaulted.length > 0 ? `; defaulted: ${defaulted.join(', ')} (results unverified)` : ''}.`,
      [id],
    );
  },
});

/** The dc datasheet of the motor of a powertrain: a stored direct-drive dc motor or the inline sheet, with its source and defaulted flags, or the refusal. */
function motorOf(
  doc: CadDocument,
  params: { motor?: string | undefined; datasheet?: z.infer<typeof datasheetSchema> | undefined; motorSource?: string | undefined },
): { sheet: DcMotorDatasheet; source: string; defaulted: string[] } | CommandResult {
  const fail = failer(doc, 'add_flight_powertrain');
  if ((params.motor === undefined) === (params.datasheet === undefined)) return fail('give exactly one of `motor` and `datasheet`');
  if (params.motor !== undefined) {
    const motors = dynamicsOf(doc).motors;
    const stored = Object.hasOwn(motors, params.motor) ? motors[params.motor] : undefined;
    if (stored === undefined) return fail(`motor '${params.motor}' not found (add_motor first)`);
    if (stored.kind !== 'dc')
      return fail(`motor '${params.motor}' is a ${stored.kind} motor: the power chain takes a dc datasheet (a BLDC as its Kt, R, I0)`);
    if (stored.gearhead !== undefined) return fail(`motor '${params.motor}' has a gearhead: a rotor is direct drive`);
    return {
      sheet: stored.datasheet,
      source: stored.source.name,
      defaulted: stored.acceptInconsistent === undefined ? [] : ['motor.datasheetInconsistent'],
    };
  }
  if (params.datasheet === undefined) return fail('no motor');
  if (params.motorSource === undefined || params.motorSource.trim() === '') return fail('an inline datasheet needs `motorSource`');
  const sheet = toDatasheet(params.datasheet);
  const checked = checkMotorData(sheet);
  if (!checked.consistent) return inconsistentSheet(doc, 'add_flight_powertrain', checked);
  return { sheet, source: params.motorSource.trim(), defaulted: [] };
}

/**
 * @affects adds 1 powertrain to doc.flight.powertrains (affected: [powertrainId])
 * @invariant exactly one of motor / datasheet; the motor is a direct-drive dc datasheet; battery and rotors exist and feed / are fed by no other powertrain; 0 < escEfficiency <= 1
 * @failure unknown battery, rotor or motor, a non-dc or geared motor, an inconsistent inline datasheet, a battery or rotor already in a powertrain, taken id -> no-op
 */
export const addFlightPowertrain = defineCommand({
  name: 'add_flight_powertrain',
  description:
    'Connect a battery (add_battery) to the motors of some rotors (add_rotor) through ESCs for run_flight and estimate_endurance (13 FLT). ' +
    'Per rotor and step: the rotor law gives the shaft torque Q at its speed ω; the DC motor law of the datasheet (the same datasheet as add_motor kind "dc") ' +
    'gives the current i = Q/kt + I0 and the terminal voltage V = kt·ω + R·i (kt in N·m/A = 60/(2π·Kv), R terminal resistance, I0 no-load current); ' +
    'the ESC draws V·i/escEfficiency from the pack, throttle = V / V_pack. The pack current solves V_pack·I = P_bus with V_pack = OCV(SoC) - R_int·I; ' +
    'SoC falls by I·dt/(3600·C). If the rotor speed needs more voltage than the pack gives (V_motor > V_pack) the speed is limited (FLT_PACK_VOLTAGE_LIMITED); ' +
    'at the low-voltage cut-off the motors stop. The motor is a stored datasheet motor (`motor`: a "dc" add_motor, direct drive) or an inline `datasheet` ' +
    '(+ `motorSource`; checked for consistency like check_motor_data). A brushless drone motor is entered as its Kt, R, I0 (kt = 60/(2π·Kv)). ' +
    'A battery feeds one powertrain and a rotor belongs to one. Without escEfficiency 0.95 is used (flagged unverified). Returns the powertrain id in affected[0].',
  params: z.object({
    battery: z.string().describe('Id of the battery (add_battery).'),
    rotors: z
      .array(z.string())
      .min(1)
      .max(64)
      .describe('Ids of the rotors (add_rotor) whose motors this powertrain feeds, all with the same motor.'),
    motor: z.string().optional().describe('Id of a stored datasheet motor of kind "dc" without gearhead (add_motor).'),
    datasheet: datasheetSchema
      .optional()
      .describe(
        'Alternative to `motor`: an inline dc datasheet (SI units; kt = 60/(2π·Kv) N·m/A, R phase-to-phase ohm, noLoadCurrentA I0).',
      ),
    motorSource: z.string().optional().describe('Where an inline datasheet comes from (required with `datasheet`).'),
    escEfficiency: z
      .number()
      .gt(0)
      .max(1)
      .optional()
      .describe('Share of the ESC input power that reaches the motor terminals, (0, 1]. Default 0.95 (unverified).'),
    auxiliaryPowerW: z
      .number()
      .min(0)
      .optional()
      .describe('Constant electrical load on the pack besides the motors (avionics, payload), W. Default 0.'),
    id: z.string().optional().describe('Optional explicit powertrain id (shares the id space of the dynamics records).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_flight_powertrain');
    const flight = flightOf(doc);
    const battery = Object.hasOwn(flight.batteries ?? {}, params.battery) ? flight.batteries?.[params.battery] : undefined;
    if (battery === undefined) return fail(`battery '${params.battery}' not found (add_battery first)`);
    const powertrains = Object.values(flight.powertrains ?? {});
    const busy = powertrains.find((train) => train.batteryId === battery.id);
    if (busy !== undefined) return fail(`battery '${battery.id}' already feeds powertrain '${busy.id}'`);
    if (new Set(params.rotors).size !== params.rotors.length) return fail('a rotor is listed twice');
    const missing = params.rotors.find((rotorId) => !Object.hasOwn(flight.rotors, rotorId));
    if (missing !== undefined) return fail(`rotor '${missing}' not found (add_rotor first)`);
    const taken = params.rotors.find((rotorId) => powertrains.some((train) => train.rotorIds.includes(rotorId)));
    if (taken !== undefined) return fail(`rotor '${taken}' is already on a powertrain`);
    const motor = motorOf(doc, params);
    if (!('sheet' in motor)) return motor;
    const id = idOrNext(params.id, 'powertrain');
    if (idTakenInDynamicsOrFlight(doc, id)) return fail(`id '${id}' is already used`);
    const defaulted = [...motor.defaulted, ...(params.escEfficiency === undefined ? ['escEfficiency'] : [])];
    const powertrain: FlightPowertrain = {
      id,
      batteryId: battery.id,
      rotorIds: params.rotors,
      motor: motor.sheet,
      motorSource: motor.source,
      escEfficiency: params.escEfficiency ?? DEFAULT_ESC_EFFICIENCY,
      auxiliaryPowerW: params.auxiliaryPowerW ?? NO_AUXILIARY_LOAD_W,
      defaulted,
    };
    const full = battery.cellsSeries * (battery.ocv[battery.ocv.length - 1]?.[1] ?? 0);
    return changed(
      { ...doc, flight: { ...flight, powertrains: { ...flight.powertrains, [id]: powertrain } } },
      `add_flight_powertrain: '${id}' — battery '${battery.id}' (${format(full)} V full) feeds ${params.rotors.length} rotor(s) [${params.rotors.join(', ')}] through ESCs of efficiency ${format(powertrain.escEfficiency)}; ` +
        `motor kt ${format(motor.sheet.torqueConstantNmPerA)} N·m/A, R ${format(motor.sheet.terminalResistanceOhm)} Ω, I0 ${format(motor.sheet.noLoadCurrentA === undefined ? 0 : motor.sheet.noLoadCurrentA)} A (${motor.source}), nominal ${format(motor.sheet.nominalVoltageV)} V, auxiliary ${format(powertrain.auxiliaryPowerW)} W` +
        `${defaulted.length > 0 ? `; defaulted: ${defaulted.join(', ')} (results unverified)` : ''}.`,
      [id],
    );
  },
});
