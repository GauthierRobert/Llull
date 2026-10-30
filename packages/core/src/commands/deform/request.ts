/** What a deformation command hands to the shared pipeline (01 DEF §2.2): the bodies, and per body a plan of the map. */

import type { DeformFrame, DeformLaw, DeformRegion } from '../../model/deform';
import type { LocalExtent } from '../../geometry/deform/bounds';
import type { DeformTarget, Refusal } from './target';

/** What a command decided from the target: the map and where it acts. */
export interface DeformPlan {
  readonly law: DeformLaw;
  readonly frame: DeformFrame;
  readonly region?: DeformRegion;
  /** Frame of the body in the plan's frame (for the Jacobian pre-check and the report). */
  readonly extent: LocalExtent;
  /** Local coordinates (flat xyz) of the body's own vertices, for a map whose Jacobian cannot be read off the extent box (a flow with a base curve). */
  readonly samples?: ReadonlyArray<number>;
  /** Extra local points always evaluated for that Jacobian: the base-frame grid of a flow with a base curve (`baseFlowGrid`). */
  readonly gridSamples?: ReadonlyArray<number>;
  /** Look for the result crossing itself (a bend past a quarter turn with straight parts left). */
  readonly checkOverlap?: boolean;
  /** A full-turn bend of the whole body: its end faces coincide, which only the exact kernel closes (it sews the ring). */
  readonly ring?: boolean;
  /** Names of frame fields taken from the body bounds. */
  readonly defaulted: readonly string[];
  /** Extra facts of the plan for the result `data` (a fit residual, a count). */
  readonly report?: Readonly<Record<string, unknown>>;
}

export interface OutputInput {
  readonly mode?: 'auto' | 'exact' | 'mesh' | undefined;
  readonly tolerance?: number | undefined;
  readonly preserveAnalytic?: boolean | undefined;
  readonly allowMeshFallback?: boolean | undefined;
}

export interface DeformRequest {
  readonly command: string;
  /** The bodies to deform, in order (each gets its own plan); several bodies are one feature step. */
  readonly ids: readonly string[];
  /** Keep the originals next to the results. */
  readonly keepSource?: boolean | undefined;
  readonly verb: string;
  readonly output: OutputInput | undefined;
  readonly plan: (target: DeformTarget) => DeformPlan | Refusal;
}
