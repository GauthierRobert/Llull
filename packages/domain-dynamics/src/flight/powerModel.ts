/**
 * Battery and powertrain records of the flight slice (13 FLT M3, TR-FLT-06): plain data, every default already resolved when the record was
 * created (`defaulted` names the inputs that took one). SI units except where a name says otherwise (mAh, Wh).
 */

import type { DcMotorDatasheet } from '@core/model/drives';

/** [state of charge 0..1, open-circuit voltage of ONE cell, V]. */
type OcvPoint = readonly [soc: number, voltPerCell: number];

/**
 * A battery pack as an equivalent circuit: V = OCV(SoC) - R_int · I, dSoC/dt = -I / (3600 · C).
 * @invariant cellsSeries >= 1 integer; capacityMah, internalResistanceOhm > 0 / >= 0; ocv: >= 2 points, soc from 0 to 1 strictly increasing, voltage non-decreasing
 * @invariant 0 <= initialSoc <= 1; used by at most one powertrain
 * @invariant id unique across doc.dynamics records and the flight slice (idTakenInDynamicsOrFlight)
 */
export interface FlightBattery {
  readonly id: string;
  readonly cellsSeries: number;
  /** Capacity of the whole pack, mAh (parallel cells already counted). */
  readonly capacityMah: number;
  /** Internal resistance of the whole pack, Ω. */
  readonly internalResistanceOhm: number;
  readonly ocv: readonly OcvPoint[];
  /** Terminal voltage per cell under which the pack is cut off (the low-voltage cut-off of the ESC), V. */
  readonly cutoffVoltPerCell: number;
  /** State of charge at the start of every run, 0..1. */
  readonly initialSoc: number;
  readonly source: string;
  readonly defaulted: readonly string[];
}

/**
 * One battery feeding the motors of some rotors through ESCs: the DC motor law (kt, R, I0 of the datasheet) turns the rotor's shaft torque into
 * a current and a voltage, the ESC turns that into a throttle and a battery current with an efficiency.
 * @invariant batteryId names a battery used by no other powertrain; rotorIds non-empty, distinct, each a rotor of no other powertrain
 * @invariant motor is a direct-drive datasheet (no gearhead): the rotor shaft is the motor shaft
 * @invariant 0 < escEfficiency <= 1; auxiliaryPowerW >= 0
 */
export interface FlightPowertrain {
  readonly id: string;
  readonly batteryId: string;
  readonly rotorIds: readonly string[];
  /** The motor of every listed rotor: a dc datasheet (add_motor kind "dc" or inline), checked for consistency when it was added. */
  readonly motor: DcMotorDatasheet;
  /** Where the motor datasheet comes from. */
  readonly motorSource: string;
  /** Share of the electrical power into the ESC that reaches the motor terminals. */
  readonly escEfficiency: number;
  /** Constant load on the pack besides the motors (avionics, payload), W. */
  readonly auxiliaryPowerW: number;
  readonly defaulted: readonly string[];
}
