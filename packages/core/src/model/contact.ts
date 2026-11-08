/** PHY-06 structural contact set-up of a nonlinear_static case (plugin `cae`, CalculiX `*CONTACT PAIR`). */

import type { FeaTarget } from './feaTarget';
import type { Vec3 } from './vectors';

/** CalculiX `*CONTACT PAIR, TYPE=`: one formulation per deck (CalculiX rule). */
export type ContactFormulation = 'node_to_surface' | 'surface_to_surface' | 'mortar';

/** `*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=`; slopes in the analysis unit system (stress per length), c0 / p0 in its length / stress. */
export type ContactBehaviour =
  | { readonly kind: 'hard' }
  | { readonly kind: 'linear'; readonly slope: number; readonly tensionAtLargeClearance?: number; readonly c0?: number }
  | { readonly kind: 'exponential'; readonly c0: number; readonly p0: number }
  | { readonly kind: 'tied'; readonly slope: number; readonly stickSlope: number };

export interface ContactPair {
  readonly id: string;
  readonly name: string;
  readonly slave: FeaTarget;
  readonly master: FeaTarget;
  readonly behaviour: ContactBehaviour;
  /** Coulomb friction; absent stickSlope = the CalculiX default (first elastic constant / 2), reported as a named default. */
  readonly friction?: { readonly mu: number; readonly stickSlope?: number };
  /** `ADJUST=<clearance>` in document length units; absent / none = no adjustment. */
  readonly adjust?: { readonly kind: 'clearance'; readonly value: number } | { readonly kind: 'none' };
  /** `SMALL SLIDING` (node_to_surface only). */
  readonly smallSliding?: boolean;
  /** PHY-05 step ids the pair is active in (`*MODEL CHANGE`); absent = every step. */
  readonly activeSteps?: readonly string[];
  /** The design relies on no slip here: sliding in a result step is a check_contact finding (CNT_SLIP). */
  readonly noSlipRequired?: boolean;
}

export interface ContactSettings {
  /** Fixed by the first pair. */
  readonly formulation: ContactFormulation;
  readonly pairs: Readonly<Record<string, ContactPair>>;
  readonly pairOrder: readonly string[];
}

/**
 * Bolt preload: a force (analysis force unit), or a torque with the nut factor K (T = K D P, NASA-STD-5020 A.2-1) whose force is derived when the deck is
 * written. `torque` is in analysis force x analysis length, `diameter` in document length units; the nut factor and its source are never defaulted.
 */
export type PreloadSpec =
  | { readonly kind: 'force'; readonly value: number }
  | {
      readonly kind: 'torque';
      readonly torque: number;
      readonly nutFactor: number;
      readonly diameter: number;
      readonly nutFactorSource: string;
    };

/** One `*PRE-TENSION SECTION` through a bolt part, tightened in the first step and, when `lockAfter`, held at its bolt length in later steps. */
export interface BoltPretension {
  readonly id: string;
  readonly name: string;
  readonly entityId: string;
  /** Cut plane through the bolt shank (document units): point on it and the bolt axis direction (need not be unit length). */
  readonly section: { readonly point: Vec3; readonly normal: Vec3 };
  readonly preload: PreloadSpec;
  readonly preloadStepId: string;
  readonly lockAfter: boolean;
}

/** PHY-06 M3 bolt pretensions of a nonlinear_static case (independent of contact pairs: a bar with a pretension section needs none). */
export interface PretensionSettings {
  readonly bolts: Readonly<Record<string, BoltPretension>>;
  readonly order: readonly string[];
}
