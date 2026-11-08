/** PHY-06 structural contact set-up of a nonlinear_static case (plugin `cae`, CalculiX `*CONTACT PAIR`). */

import type { FeaTarget } from './feaTarget';

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
