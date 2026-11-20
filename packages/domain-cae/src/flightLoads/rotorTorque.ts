/** 14 FLL-M2b: the rotor reaction and gyroscopic torques of a flight instant as a mount moment (the moments the flight model applies to the body). */

import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { isRecord } from '@lib/isRecord';
import type { FlightInstant } from './flightInstants';

export interface RotorSpin {
  /** +1 for 'ccw' (angular velocity along +axis), -1 for 'cw'. */
  readonly spin: 1 | -1;
  /** Polar inertia of the spinning parts, kg m^2. */
  readonly spinInertiaKgM2: number;
}

/**
 * Spin sense and spin inertia of every rotor of the flight model, read through the registry (inspect_dynamics; L10: no import of the dynamics plugin).
 * @failure inspect_dynamics unregistered or no rotors -> text
 */
export function rotorSpins(doc: CadDocument, ctx: ExecutionContext | undefined): Readonly<Record<string, RotorSpin>> | string {
  const inspect = ctx?.registry('inspect_dynamics');
  if (inspect === undefined) return 'inspect_dynamics is not registered (the dynamics plugin is not installed)';
  const result = inspect.run(doc, { mobility: false }, ctx);
  const flight = isRecord(result.data) ? result.data['flight'] : undefined;
  const rotors = isRecord(flight) && isRecord(flight['rotors']) ? flight['rotors'] : {};
  const spins: Record<string, RotorSpin> = {};
  for (const [id, rotor] of Object.entries(rotors))
    if (isRecord(rotor) && (rotor['spin'] === 'cw' || rotor['spin'] === 'ccw'))
      spins[id] = {
        spin: rotor['spin'] === 'ccw' ? 1 : -1,
        spinInertiaKgM2: typeof rotor['spinInertiaKgM2'] === 'number' ? rotor['spinInertiaKgM2'] : 0,
      };
  return Object.keys(spins).length > 0 ? spins : 'the document has no flight rotors (add_rotor)';
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Moment on the airframe at the mount of rotor `rotorId` at `instant`, N m in model axes: the reaction torque -s Q a with Q = shaft power / (2 pi n)
 * (the aerodynamic torque the motor holds), plus the gyroscopic moment -omega x H, H = I_s 2 pi n s a; `axis` = unit thrust axis in model axes.
 * @invariant the moment of the flight model's rotor law minus the thrust arm term (the FE mount force carries that one)
 * @failure the instant has no speed or shaft power of the rotor -> text
 */
export function rotorMountMoment(instant: FlightInstant, rotorId: string, axis: Vec3, spin: RotorSpin): Vec3 | string {
  const rpm = instant.rotorRpm[rotorId];
  const power = instant.shaftPowerW[rotorId];
  if (rpm === undefined || power === undefined) return `the run has no speed or shaft power of rotor '${rotorId}'`;
  const omegaRotor = (2 * Math.PI * Math.abs(rpm)) / 60;
  const torque = omegaRotor > 0 ? power / omegaRotor : 0;
  const momentum = spin.spinInertiaKgM2 * omegaRotor * spin.spin;
  const gyro = cross(instant.angularVelocity, [axis[0] * momentum, axis[1] * momentum, axis[2] * momentum]);
  const reaction = -spin.spin * torque;
  return [reaction * axis[0] - gyro[0], reaction * axis[1] - gyro[1], reaction * axis[2] - gyro[2]];
}
