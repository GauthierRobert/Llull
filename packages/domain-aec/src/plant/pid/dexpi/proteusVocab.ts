/** Words shared by the Proteus (DEXPI 1.3) mapper and the exporter: instrument locations, actuator devices and fail actions in both directions (plant 04 PID §6.1, §6.3). */

import type { PidActuating, PidInstrument } from '../model';

const LOCATIONS: ReadonlyArray<readonly [RegExp, PidInstrument['location']]> = [
  [/^field/i, 'field'],
  [/central/i, 'central'],
  [/panel/i, 'local_panel'],
  [/auxiliary/i, 'auxiliary'],
];

/** The `LocationSpecialization` value the exporter writes for each location. */
export const LOCATION_NAMES: Readonly<Record<PidInstrument['location'], string>> = {
  field: 'FieldLocation',
  central: 'CentralLocation',
  local_panel: 'LocalPanelLocation',
  auxiliary: 'AuxiliaryLocation',
};

export const locationOf = (text: string): PidInstrument['location'] => LOCATIONS.find(([pattern]) => pattern.test(text))?.[1] ?? 'field';

const ACTUATORS: ReadonlyArray<readonly [RegExp, PidActuating['actuator']]> = [
  [/diaphragm/i, 'diaphragm'],
  [/piston/i, 'piston'],
  [/motor|electric/i, 'motor'],
  [/solenoid/i, 'solenoid'],
  [/hydraulic/i, 'hydraulic'],
];

/** The `DeviceTypeNameAssignmentClass` value the exporter writes for each actuator (`general` writes none). */
export const ACTUATOR_NAMES: Readonly<Record<Exclude<PidActuating['actuator'], 'general'>, string>> = {
  diaphragm: 'DiaphragmActuator',
  piston: 'PistonActuator',
  motor: 'ElectricMotorActuator',
  solenoid: 'SolenoidActuator',
  hydraulic: 'HydraulicActuator',
};

export const actuatorOf = (text: string): PidActuating['actuator'] => ACTUATORS.find(([pattern]) => pattern.test(text))?.[1] ?? 'general';

const FAIL_ACTIONS: ReadonlyMap<string, NonNullable<PidActuating['failAction']>> = new Map([
  ['FailClose', 'FC'],
  ['FailOpen', 'FO'],
  ['FailLock', 'FL'],
  ['FailIndeterminate', 'FAI'],
]);

export const failActionOf = (text: string): PidActuating['failAction'] => FAIL_ACTIONS.get(text);

/** The `FailActionSpecialization` value for each fail action. */
export const FAIL_ACTION_NAMES: Readonly<Record<NonNullable<PidActuating['failAction']>, string>> = {
  FC: 'FailClose',
  FO: 'FailOpen',
  FL: 'FailLock',
  FAI: 'FailIndeterminate',
};
