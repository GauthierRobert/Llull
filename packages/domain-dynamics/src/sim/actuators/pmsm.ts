/**
 * PMSM / BLDC law with ideal field-oriented control (PHY-23 TR-DRV-07): surface magnets (L_d = L_q = L), amplitude-invariant dq model (Krause,
 * Analysis of Electric Machinery, ch. 4; Pillay and Krishnan, IEEE Trans. Ind. Appl. 25(2), 1989).
 * T = 1.5·p·λ·i_q; v_d = R·i_d − ω_e·L·i_q, v_q = R·i_q + ω_e·(L·i_d + λ), ω_e = p·ω_m. The current loop is ideal (the commanded dq current is the
 * realised one); the torque command is cut to the voltage / current envelope at the present speed: constant torque to the base speed (i_d = 0), then field
 * weakening along the current limit circle (R = 0 in the envelope: model form, stated).
 */

import type { PmsmMotor } from '@core/model/drives';
import { drivetrainOf, type Drivetrain } from './drivetrain';

export interface PmsmParameters extends Drivetrain {
  readonly polePairs: number;
  readonly resistanceOhm: number;
  readonly inductanceH: number;
  /** λ, Wb (peak phase flux linkage). */
  readonly fluxLinkageWb: number;
  /** 1.5·p·λ, N·m per A of phase-current amplitude. */
  readonly torqueConstant: number;
  readonly busVoltageV: number;
}

export function pmsmParameters(motor: PmsmMotor): PmsmParameters {
  const sheet = motor.datasheet;
  const p = sheet.polePairs;
  // the datasheet validation guarantees one of the two; NaN marks a record that bypassed it
  const flux =
    sheet.fluxLinkageWb !== undefined
      ? sheet.fluxLinkageWb
      : sheet.torqueConstantNmPerA === undefined
        ? Number.NaN
        : sheet.torqueConstantNmPerA / (1.5 * p);
  return {
    ...drivetrainOf(motor.gearhead, sheet.rotorInertiaKgM2, sheet.frictionNm === undefined ? 0 : sheet.frictionNm, sheet.peakCurrentA),
    polePairs: p,
    resistanceOhm: sheet.phaseResistanceOhm,
    inductanceH: sheet.inductanceH,
    fluxLinkageWb: flux,
    torqueConstant: 1.5 * p * flux,
    busVoltageV: sheet.busVoltageV,
  };
}

/** The limits a drive imposes: the phase-current amplitude (A) and the DC bus voltage (V). */
export interface PmsmLimits {
  readonly currentA: number;
  readonly busVoltageV: number;
}

export interface PmsmEnvelope {
  /** Largest torque (>= 0) at this speed, N·m. */
  readonly torqueNm: number;
  readonly idA: number;
  readonly iqA: number;
}

/** Phase-voltage amplitude limit V_bus / √3 (space-vector modulation). */
export const phaseVoltageLimit = (busVoltageV: number): number => busVoltageV / Math.sqrt(3);

/**
 * Largest torque at mechanical speed `omega` (rad/s, sign ignored): the intersection of the current disc i_d² + i_q² ≤ I² and the voltage disc
 * (λ + L·i_d)² + (L·i_q)² ≤ (V/ω_e)², maximising i_q. Zero beyond ω_max = V / ((λ − L·I)·p) when λ > L·I.
 */
export function pmsmEnvelope(p: PmsmParameters, limits: PmsmLimits, omega: number): PmsmEnvelope {
  const [lambda, inductance, current] = [p.fluxLinkageWb, p.inductanceH, limits.currentA];
  const vmax = phaseVoltageLimit(limits.busVoltageV);
  const electrical = p.polePairs * Math.abs(omega);
  if (electrical * Math.hypot(lambda, inductance * current) <= vmax) return { torqueNm: p.torqueConstant * current, idA: 0, iqA: current };
  const radius = vmax / electrical;
  const centre = lambda / inductance;
  // the voltage circle's top (−λ/L, r/L) lies inside the current disc: i_q = r/L (only possible when λ/L <= I)
  if (centre <= current && centre * centre + (radius / inductance) ** 2 <= current * current)
    return { torqueNm: (p.torqueConstant * radius) / inductance, idA: -centre, iqA: radius / inductance };
  const id = (radius * radius - lambda * lambda - (inductance * current) ** 2) / (2 * lambda * inductance);
  if (id < -current) return { torqueNm: 0, idA: -current, iqA: 0 };
  const iq = Math.sqrt(Math.max(0, current * current - id * id));
  return { torqueNm: p.torqueConstant * iq, idA: id, iqA: iq };
}

export interface PmsmStep {
  readonly idA: number;
  readonly iqA: number;
  /** Realised torque at the motor shaft, N·m (the command cut to the envelope). */
  readonly torqueNm: number;
  /** The command was cut by the envelope. */
  readonly clipped: boolean;
  /** Phase-current amplitude √(i_d² + i_q²), A. */
  readonly currentA: number;
  /** Phase-voltage amplitude, V. */
  readonly voltageV: number;
  /** W: 1.5·R·(i_d² + i_q²). */
  readonly copperW: number;
  /** W: electrical input 1.5·(v_d·i_d + v_q·i_q) = copper + torque·ω (exact for L_d = L_q). */
  readonly powerW: number;
}

/** The operating point that realises torque command `torque` (N·m at the shaft) at mechanical speed `omega` (rad/s): the smallest |i_d| that keeps the voltage inside the bus. */
export function pmsmOperatingPoint(p: PmsmParameters, limits: PmsmLimits, torque: number, omega: number): PmsmStep {
  const envelope = pmsmEnvelope(p, limits, omega);
  const realised = Math.min(envelope.torqueNm, Math.max(-envelope.torqueNm, torque));
  const iq = realised / p.torqueConstant;
  const electrical = p.polePairs * omega;
  const vmax = phaseVoltageLimit(limits.busVoltageV);
  let id = 0;
  if (electrical !== 0) {
    const room = (vmax / Math.abs(electrical)) ** 2 - (p.inductanceH * iq) ** 2;
    const reach = Math.sqrt(Math.max(0, room));
    // (λ + L·i_d)² <= room: no weakening while λ is inside the voltage circle
    id = Math.min(0, (reach - p.fluxLinkageWb) / p.inductanceH);
  }
  const copperW = 1.5 * p.resistanceOhm * (id * id + iq * iq);
  const vd = p.resistanceOhm * id - electrical * p.inductanceH * iq;
  const vq = p.resistanceOhm * iq + electrical * (p.inductanceH * id + p.fluxLinkageWb);
  return {
    idA: id,
    iqA: iq,
    torqueNm: realised,
    clipped: realised !== torque,
    currentA: Math.hypot(id, iq),
    voltageV: Math.hypot(vd, vq),
    copperW,
    powerW: copperW + realised * omega,
  };
}
