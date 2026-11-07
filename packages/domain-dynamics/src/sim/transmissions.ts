/**
 * Transmission laws (PHY-23 TR-DRV-12, 14): thread efficiencies from the geometry, the force a screw produces from a torque, and the
 * compiled couplings of a document (ratio, forward / back efficiency, backlash with its mesh stiffness) for the engine port.
 */

import type { TransmissionCoupling } from '@core/dynamics/physicsEngine';
import type { DynamicsModel } from '@core/model/dynamics';
import { transmissionJoints, transmissionRatio, type Transmission } from '@core/model/transmissions';
import { dampingRatioForRestitution } from '@lib/stopRestitution';
import { reflectedInertia, type RigidLink } from './reflectedInertia';

type LeadScrew = Extract<Transmission, { kind: 'lead_screw' }>;

export interface ScrewEfficiency {
  /** Efficiency when the screw drives the nut: tan λ / tan(λ + φ'). */
  readonly forward: number;
  /** Efficiency when the nut drives the screw: tan(λ - φ') / tan λ; <= 0 means self-locking. */
  readonly backward: number;
  readonly leadAngleRad: number;
  readonly frictionAngleRad: number;
  readonly selfLocking: boolean;
}

/** Smallest forward efficiency kept for a thread whose friction angle leaves no lifting force (a numeric floor; the command refuses it). */
const MIN_FORWARD_EFFICIENCY = 1e-6;

/**
 * Power screw (Shigley): tan λ = lead / (π d_m), tan φ' = μ / cos α_n (α_n the flank half-angle, 0 for a square thread),
 * η_f = tan λ / tan(λ + φ'), η_b = tan(λ - φ') / tan λ. The back-drive value is NOT clamped: its sign says whether the screw locks.
 */
export function leadScrewEfficiency(screw: LeadScrew): ScrewEfficiency {
  const lead = Math.atan(screw.leadMm / (Math.PI * screw.meanDiameterMm));
  const friction = Math.atan(screw.mu / Math.cos(((screw.flankAngleDeg ?? 0) * Math.PI) / 180));
  const total = lead + friction;
  const forward = total >= Math.PI / 2 ? MIN_FORWARD_EFFICIENCY : Math.max(MIN_FORWARD_EFFICIENCY, Math.tan(lead) / Math.tan(total));
  const backward = Math.tan(lead - friction) / Math.tan(lead);
  return { forward, backward, leadAngleRad: lead, frictionAngleRad: friction, selfLocking: backward <= 0 };
}

/** Forward and back efficiency of any transmission (1 = ideal). */
export function transmissionEfficiency(t: Transmission): { forward: number; backward: number } {
  if (t.kind === 'lead_screw') {
    const e = leadScrewEfficiency(t);
    return { forward: e.forward, backward: e.backward };
  }
  if (t.kind === 'ball_screw') return { forward: t.efficiency, backward: t.efficiencyBack };
  const forward = t.efficiency ?? 1;
  return { forward, backward: t.efficiencyBack ?? forward };
}

/** Axial force N of a screw turned by `torqueNm` (steady, no acceleration): F = η T 2π / lead. */
export const screwAxialForce = (torqueNm: number, leadM: number, efficiency: number): number =>
  (efficiency * torqueNm * 2 * Math.PI) / leadM;

/** Mesh damping ratio of a backlash contact when none is given. */
const DEFAULT_MESH_DAMPING = 0.5;
/** Mesh mode of the default stiffness: 100 Hz at the reflected inertia (TR-DRV-14). */
const MESH_MODE_RAD_PER_S = 2 * Math.PI * 100;

export interface CompiledCouplings {
  readonly couplings: readonly TransmissionCoupling[];
  readonly warnings: readonly string[];
}

export interface CouplingContext {
  /** +1, or -1 when the simulated coordinate of the joint is the reverse of the document's (the tree flipped its axis). */
  readonly sign: (jointId: string) => number;
  /** kg·m² (kg) the joint carries on its own coordinate: bodies and armature, no couplings. */
  readonly own: (jointId: string) => number | undefined;
  readonly timestep: number;
}

export interface CouplingRefusal {
  readonly error: string;
  readonly code: 'DRV_STEP_TOO_COARSE' | 'DRV_JOINT_INVALID';
}

/** Largest ω_n · Δt of a spring-damper constraint (end stop, backlash) before the run is refused as too coarse (error 2 % at 0.1, DRV-M0 13.2.4). */
const MAX_STIFFNESS_STEP = 0.1;

/** Why a spring-damper constraint of stiffness K on inertia J cannot be integrated at `timestep`, or null. */
export function coarseStepProblem(what: string, stiffness: number, inertia: number, timestep: number): string | null {
  const omega = Math.sqrt(stiffness / inertia);
  return omega * timestep > MAX_STIFFNESS_STEP
    ? `${what}: ω_n·Δt = ${(omega * timestep).toPrecision(3)} exceeds ${MAX_STIFFNESS_STEP} (ω_n ${omega.toPrecision(4)} rad/s): use a timestep below ${(MAX_STIFFNESS_STEP / omega).toPrecision(3)} s or a softer stop`
    : null;
}

/** Damping ratio of an end stop from `dampingRatio` / `restitution` (default restitution 0.5). */
export function stopDampingRatio(dampingRatio: number | undefined, restitution: number | undefined): number {
  return dampingRatio ?? dampingRatioForRestitution(restitution ?? 0.5) ?? 0.999;
}

/** Total gap in the driven joint's SI units (rad or m), or null when the transmission has none. */
function backlashGap(t: Transmission): number | null {
  if (t.kind === 'gear' && t.backlashDeg !== undefined) return (t.backlashDeg * Math.PI) / 180;
  if (t.kind === 'rack_pinion' && t.backlashMm !== undefined) return t.backlashMm * 1e-3;
  return null;
}

/** Rigid links (no backlash) of a document's transmissions in simulated coordinates. */
export function rigidLinks(dynamics: DynamicsModel, sign: (jointId: string) => number): RigidLink[] {
  return Object.values(dynamics.transmissions ?? {}).flatMap((t) => {
    if (backlashGap(t) !== null) return [];
    const { driver, driven } = transmissionJoints(t);
    return [{ a: driver, b: driven, ratio: (transmissionRatio(t) * sign(driven)) / sign(driver) }];
  });
}

/** The engine couplings of the document's transmissions, or why they cannot be built. */
export function compileCouplings(dynamics: DynamicsModel, context: CouplingContext): CompiledCouplings | CouplingRefusal {
  const warnings: string[] = [];
  const links = rigidLinks(dynamics, context.sign);
  const couplings: TransmissionCoupling[] = [];
  for (const t of Object.values(dynamics.transmissions ?? {})) {
    const { driver, driven } = transmissionJoints(t);
    const ratio = (transmissionRatio(t) * context.sign(driven)) / context.sign(driver);
    const losses = transmissionEfficiency(t);
    const efficiency = losses.forward === 1 && losses.backward === 1 ? {} : { efficiency: losses };
    const gap = backlashGap(t);
    if (gap === null) {
      couplings.push({ id: t.id, a: driver, b: driven, ratio, ...efficiency });
      continue;
    }
    const [inputInertia, outputInertia] = [reflectedInertia(driver, links, context.own), context.own(driven)];
    if (inputInertia === undefined || outputInertia === undefined || !(inputInertia > 0) || !(outputInertia > 0))
      return { error: `transmission '${t.id}' with backlash needs inertia on both joints`, code: 'DRV_JOINT_INVALID' };
    const row = 1 / ((ratio * ratio) / inputInertia + 1 / outputInertia);
    const given = t.kind === 'gear' ? t.meshStiffnessNmPerRad : t.kind === 'rack_pinion' ? t.meshStiffnessNPerM : undefined;
    const stiffness = given ?? row * MESH_MODE_RAD_PER_S ** 2;
    if (given === undefined)
      warnings.push(
        `DRV_MESH_STIFFNESS_ASSUMED: transmission '${t.id}' has no mesh stiffness; a 100 Hz mesh mode at the reflected inertia ${row.toExponential(3)} is used (${stiffness.toExponential(3)})`,
      );
    const refusal = coarseStepProblem(`backlash of '${t.id}'`, stiffness, row, context.timestep);
    if (refusal !== null) return { error: refusal, code: 'DRV_STEP_TOO_COARSE' };
    const zeta = (t.kind === 'gear' || t.kind === 'rack_pinion' ? t.meshDampingRatio : undefined) ?? DEFAULT_MESH_DAMPING;
    couplings.push({
      id: t.id,
      a: driver,
      b: driven,
      ratio,
      ...efficiency,
      backlash: { gap, stiffness, damping: 2 * zeta * Math.sqrt(stiffness * row), effectiveInertia: row },
    });
  }
  return { couplings, warnings };
}
