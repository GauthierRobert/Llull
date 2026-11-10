/**
 * PHY-16 PRC additive-manufacturing build set-up of an `am_build_distortion` case (plugin `cae`, inherent-strain method, CalculiX
 * `*MODEL CHANGE` layer activation). Lengths are DOCUMENT units, strains dimensionless.
 */

import type { Vec3 } from './vectors';

/** Inherent (eigen) strain of one lumped layer in the build frame (z = build direction); the source is mandatory (AF-31). */
interface AmInherentStrain {
  readonly exx: number;
  readonly eyy: number;
  readonly ezz: number;
  /** Where the numbers come from (a calibration, a paper, owner data): never a default. */
  readonly source: string;
  /** true: fitted to a measurement of this machine / material / scan strategy; false: a literature or guessed value (reported as a warning). */
  readonly calibrated: boolean;
}

/** One release step: the listed parts are removed and the part is held by a statically determinate 3-2-1 support on three points. */
export interface AmReleaseStep {
  readonly name: string;
  readonly remove: readonly ('plate' | 'supports')[];
  /** Document points; the nearest mesh nodes of the remaining parts are fixed (P1: ux uy uz, P2 / P3: the dofs `support321Dofs` derives). */
  readonly support321: readonly [Vec3, Vec3, Vec3];
}

export interface AmBuildSettings {
  /** Unit vector in document axes, pointing away from the plate. */
  readonly buildDirection: Vec3;
  /** A part of the case: the base plate, present from the start and never strained. */
  readonly plateEntityId: string;
  /** Parts of the case present from the start and never strained (removed by a release step that lists `supports`). */
  readonly supportEntityIds: readonly string[];
  /** Lumped layer thickness along the build direction. */
  readonly layerHeight: number;
  readonly inherentStrain?: AmInherentStrain;
  readonly releaseSteps: readonly AmReleaseStep[];
}
