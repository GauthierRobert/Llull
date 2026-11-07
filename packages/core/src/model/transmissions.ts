/**
 * Transmissions, joint physics and load schedules of `CadDocument.dynamics` (PHY-23 DRV-M2). A transmission couples two physics joints
 * kinematically (q_driven = ratio · q_driver, rad/rad or m/rad) and loses power as friction on the driver joint; joint physics replaces the
 * `friction` / `damping` shortcut of a joint with a friction model, end stops and an armature; a load schedule applies a profile as a force.
 */

import type { ParameterSource } from './drives';
import type { Vec3 } from './vectors';

interface TransmissionLosses {
  /** Forward efficiency in (0, 1] (the driver drives): the share of the input power that reaches the driven side. Absent = ideal (1). */
  readonly efficiency?: number;
  /** Efficiency when the driven side drives the driver (back-drive) in (0, 1]; default = `efficiency`. */
  readonly efficiencyBack?: number;
  readonly source?: ParameterSource;
}

/**
 * @invariant driver / driven (screw / nut, pinion / rack) are two different existing joints; every joint is DRIVEN by at most one transmission;
 *            gear and belt couple two revolute joints, screws and rack couple a revolute (driver) with a prismatic joint (driven)
 */
export type Transmission =
  | ({
      readonly kind: 'gear';
      readonly id: string;
      readonly driver: string;
      readonly driven: string;
      /** speed(driven) / speed(driver); negative reverses the direction. */
      readonly ratio: number;
      /** Tooth counts [driver, driven] the ratio was derived from; `ratio` stays authoritative. */
      readonly teeth?: readonly [number, number];
      /** Total angular gap at the driven shaft, degrees (lost motion on reversal). */
      readonly backlashDeg?: number;
      /** Contact stiffness of the mesh at the driven shaft, N·m/rad; default a 100 Hz mesh mode at the reflected inertia. */
      readonly meshStiffnessNmPerRad?: number;
      /** Damping ratio of the mesh contact, default 0.5. */
      readonly meshDampingRatio?: number;
    } & TransmissionLosses)
  | ({
      readonly kind: 'belt';
      readonly id: string;
      readonly driver: string;
      readonly driven: string;
      readonly driverDiameterMm: number;
      readonly drivenDiameterMm: number;
    } & TransmissionLosses)
  | {
      readonly kind: 'lead_screw';
      readonly id: string;
      readonly screw: string;
      readonly nut: string;
      /** Advance of the nut per screw revolution, mm. */
      readonly leadMm: number;
      readonly meanDiameterMm: number;
      /** Coefficient of friction of the thread flanks. */
      readonly mu: number;
      /** Flank half-angle, degrees (0 = square thread, 14.5 Acme, 30 trapezoidal). */
      readonly flankAngleDeg?: number;
      readonly source?: ParameterSource;
    }
  | ({
      readonly kind: 'ball_screw';
      readonly id: string;
      readonly screw: string;
      readonly nut: string;
      readonly leadMm: number;
      readonly efficiency: number;
      readonly efficiencyBack: number;
    } & Pick<TransmissionLosses, 'source'>)
  | ({
      readonly kind: 'rack_pinion';
      readonly id: string;
      readonly pinion: string;
      readonly rack: string;
      readonly pitchRadiusMm: number;
      /** Total linear gap at the rack, mm. */
      readonly backlashMm?: number;
      readonly meshStiffnessNPerM?: number;
      readonly meshDampingRatio?: number;
    } & TransmissionLosses);

/** The two joints a transmission couples: the driver (input, revolute) and the driven joint. */
export function transmissionJoints(transmission: Transmission): { readonly driver: string; readonly driven: string } {
  switch (transmission.kind) {
    case 'gear':
    case 'belt':
      return { driver: transmission.driver, driven: transmission.driven };
    case 'lead_screw':
    case 'ball_screw':
      return { driver: transmission.screw, driven: transmission.nut };
    case 'rack_pinion':
      return { driver: transmission.pinion, driven: transmission.rack };
  }
}

/** Driven coordinate per driver coordinate in SI (rad/rad for gears and belts, m/rad for screws and racks). */
export function transmissionRatio(transmission: Transmission): number {
  switch (transmission.kind) {
    case 'gear':
      return transmission.ratio;
    case 'belt':
      return transmission.driverDiameterMm / transmission.drivenDiameterMm;
    case 'lead_screw':
    case 'ball_screw':
      return (transmission.leadMm * 1e-3) / (2 * Math.PI);
    case 'rack_pinion':
      return transmission.pitchRadiusMm * 1e-3;
  }
}

/** Friction model of a joint, replacing its `friction` / `damping` shortcut. */
export type JointFriction =
  | { readonly model: 'coulomb'; readonly kinetic: number; readonly viscous?: number; readonly source: ParameterSource }
  | {
      readonly model: 'stiction';
      readonly static: number;
      readonly kinetic: number;
      readonly viscous?: number;
      readonly source: ParameterSource;
    }
  | {
      readonly model: 'stribeck';
      readonly static: number;
      readonly coulomb: number;
      readonly stribeckVelocity: number;
      readonly viscous?: number;
      readonly source: ParameterSource;
    }
  | {
      readonly model: 'load_dependent';
      /** Coefficient of friction of the bearing. */
      readonly mu: number;
      /** Radius at which the friction force acts (pin / bearing radius), mm. */
      readonly pinRadiusMm: number;
      /** Axial / radial preload added to the measured radial load, N. */
      readonly preloadN?: number;
      /** Bending-moment arm, mm: adds mu · r · |M| / arm to the normal load. */
      readonly frictionArmMm?: number;
      /** Load-independent friction torque / force, N·m or N. */
      readonly base?: number;
      readonly viscous?: number;
      readonly source: ParameterSource;
    };

/** End stops: travel limits in joint coordinates (rad or m from the modelled pose), a linear spring-damper pushing back. */
export interface JointLimits {
  readonly min: number;
  readonly max: number;
  /** N·m/rad or N/m. */
  readonly stiffness: number;
  /** Damping ratio ζ of the stop against the joint's effective inertia; default from `restitution`. */
  readonly dampingRatio?: number;
  /** Coefficient of restitution of an impact on the stop (0.57 at ζ 0.2); default 0.5. Ignored when `dampingRatio` is given. */
  readonly restitution?: number;
}

/** Physics of one joint (key of `dynamics.jointPhysics` = the joint id). */
export interface JointPhysics {
  readonly id: string;
  readonly limits?: JointLimits;
  readonly friction?: JointFriction;
  /** kg·m² (or kg) of extra inertia on the joint coordinate that belongs to no body. */
  readonly armatureKgM2?: number;
}

/** A profile applied as a force on a body (world axes, at its centre of mass) or as the generalised force of a joint. */
export interface LoadSchedule {
  readonly id: string;
  readonly target: { readonly body: string } | { readonly joint: string };
  /** 'force' (N; a body or a prismatic joint) or 'torque' (N·m; a revolute joint). */
  readonly kind: 'force' | 'torque';
  /** World direction of a body force (not unit), absent for a joint target. */
  readonly direction?: Vec3;
  /** Id of a `force` / `torque` profile; absent = the constant. */
  readonly profile?: string;
  /** N or N·m, used when there is no profile. */
  readonly constant?: number;
}

/** A transmission seen as the kinematic coupling it is: q_driven = ratio · q_driver (rad/rad or m/rad). */
export interface Coupling {
  readonly id: string;
  readonly driver: string;
  readonly driven: string;
  readonly ratio: number;
}

/** The couplings of a document's transmissions, in creation order. */
export function couplingsOf(dynamics: { readonly transmissions?: Readonly<Record<string, Transmission>> }): Coupling[] {
  return Object.values(dynamics.transmissions ?? {}).map((transmission) => ({
    id: transmission.id,
    ...transmissionJoints(transmission),
    ratio: transmissionRatio(transmission),
  }));
}
