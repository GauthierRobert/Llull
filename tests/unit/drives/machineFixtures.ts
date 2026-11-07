/** Shared fixtures of the PHY-23 DRV-M4 tests: the reference PMSM / stepper / induction sheets of drv_reference.json and a one-motor bench. */
import type { CadDocument } from '@core/model/types';
import { runSteps } from './fixtures';

export const MACHINE_SOURCE = { name: 'DRV-M4 test sheet (textbook values of drv_reference.json)', grade: 'A' };

/** drv_reference.json "pmsm": lambda 0.01 Wb, p 4, L 0.2 mH, I_max 20 A, V_bus 24 V (R is not part of the envelope). */
export const PMSM_SHEET = {
  polePairs: 4,
  phaseResistanceOhm: 0.05,
  inductanceH: 0.0002,
  fluxLinkageWb: 0.01,
  rotorInertiaKgM2: 1e-5,
  busVoltageV: 24,
  peakCurrentA: 20,
};

/** drv_reference.json "stepper": T_h 0.5 N*m, N_r = 50 (200 steps), J 1e-5. */
export const STEPPER_SHEET = {
  stepsPerRev: 200,
  holdingTorqueNm: 0.5,
  ratedCurrentA: 2,
  phaseResistanceOhm: 1.5,
  phaseInductanceH: 0.003,
  rotorInertiaKgM2: 1e-5,
};

/** drv_reference.json "induction" circuit: 230 V phase, 50 Hz, p 2, R1 0.5, R2 0.4, X1 + X2 = 2 ohm (Xm at the terminals). */
export const INDUCTION_SHEET = {
  polePairs: 2,
  ratedVoltageV: 230,
  ratedFrequencyHz: 50,
  statorResistanceOhm: 0.5,
  rotorResistanceOhm: 0.4,
  statorLeakageReactanceOhm: 1,
  rotorLeakageReactanceOhm: 1,
  magnetisingReactanceOhm: 40,
  rotorInertiaKgM2: 0.2,
};

export const THERMAL = { rthWindingHousingKPerW: 1.9, rthHousingAmbientKPerW: 4.7, tauWindingS: 41.5, tauMotorS: 809, maxWindingC: 155 };

interface Step {
  readonly command: string;
  readonly params: Record<string, unknown>;
  readonly as?: string;
}

/** A disc of axial inertia `inertia` kg*m^2 on revolute joint "j" about Z (no gravity), then the motor "m" `motor` (kind and sheet fields), then `after`. */
export function machineBench(inertia: number, motor: Record<string, unknown>, after: Step[] = []): CadDocument {
  return runSteps([
    { command: 'add_cylinder', params: { radius: 50, height: 10, position: [0, 0, 0], axis: [0, 0, 1] }, as: 'disc' },
    {
      command: 'add_rigid_body',
      params: { entityIds: ['$disc'], id: 'load', massKg: 1, inertiaKgM2: [inertia / 2, inertia / 2, inertia, 0, 0, 0] },
    },
    {
      command: 'add_body_joint',
      params: { kind: 'revolute', child: 'load', parent: 'ground', anchor: [0, 0, 0], axis: [0, 0, 1], id: 'j' },
    },
    { command: 'set_gravity', params: { gravity: [0, 0, 0] } },
    { command: 'add_motor', params: { joint: 'j', id: 'm', source: MACHINE_SOURCE, ...motor } },
    ...after,
  ]).doc;
}

/** A profile of one constant value over `seconds` (table of two equal points). */
export const constantProfile = (id: string, quantity: string, unit: string, value: number, seconds: number): Step => ({
  command: 'add_motion_profile',
  params: {
    id,
    quantity,
    unit,
    start: value,
    segments: [
      {
        kind: 'table',
        points: [
          [0, value],
          [seconds, value],
        ],
        interpolation: 'linear',
      },
    ],
  },
});
