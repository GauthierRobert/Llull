/** Types of the route plan of an imported PCF line (`plan.ts`) and the state its walk threads (`planState.ts`). */

import type { Vec3 } from '@core/model/vectors';
import type { WeldKind } from '../model';
import type { FlatSide } from './eccentric';
import type { PlannedInline } from './inlineBody';

export interface PlannedPort {
  readonly position: Vec3;
  /** Face direction toward the pipe. */
  readonly direction: Vec3;
  readonly dn: number;
}

export interface PlannedRun {
  readonly key: string;
  readonly dn: number;
  /** Start (for a branch: the point on the header), points of intersection, end. */
  readonly points: readonly Vec3[];
  readonly startPort?: PlannedPort;
  readonly endPort?: PlannedPort;
  readonly inline: readonly PlannedInline[];
  /**
   * The run ends closed by a cap or a blind flange: the pipe (a blind: its gasket) meets it at `mouth`; `tip` is its closed end when the file gives it (a CAP with two
   * END-POINTs, a FLANGE-BLIND's outer face).
   */
  readonly cap?: { readonly kind: 'cap' | 'blindFlange'; readonly mouth: Vec3; readonly tip?: Vec3 };
  /** The main run STARTS closed: the closure's closed end is the free first end of the file (`tip`), the run begins there; `mouth` is where the pipe side begins. */
  readonly startCap?: { readonly kind: 'cap' | 'blindFlange'; readonly mouth: Vec3; readonly tip: Vec3 };
  /** The run this one branches off (absent for the main run). */
  readonly parent?: string;
  readonly consumed: readonly string[];
}

export interface PlannedWeld {
  readonly componentId: string;
  readonly kind: Exclude<WeldKind, 'shop'>;
  readonly at: Vec3;
}

export interface PlannedSupport {
  readonly componentId: string;
  readonly at: Vec3;
  readonly name: string | undefined;
  readonly type: string | undefined;
}

export interface RoutePlan {
  readonly ok: true;
  /** The main run first, then the branches in discovery order (a parent before its children). */
  readonly runs: readonly PlannedRun[];
  readonly welds: readonly PlannedWeld[];
  readonly shopWelds: number;
  readonly supports: readonly PlannedSupport[];
  /** Gaskets the spec rebuilds with its flange sets (bolt sets are not counted: they have no position). */
  readonly rebuilt: readonly string[];
  /** Flanged joints the file draws without a gasket (flange against flange, a flanged body or a blind): the spec adds one (ISO_ROUTE_GASKET_ADDED). */
  readonly gasketless: readonly string[];
}

export interface RouteRefusal {
  readonly ok: false;
  readonly code: 'ISO_ROUTE_UNSUPPORTED' | 'ISO_ROUTE_TOO_LARGE' | 'ISO_ROUTE_FLAT_MISSING' | 'ISO_PARAM_INVALID';
  readonly message: string;
  readonly ids: readonly string[];
}

export interface PlanOptions {
  /** Flat side of the eccentric reducers whose END-POINTs lie on one axis (the file does not say). */
  readonly eccentricFlat?: FlatSide | undefined;
}

export interface Seed {
  readonly key: string;
  readonly start: Vec3;
  /** The node the walk starts from (the outlet of a branch fitting, the free end of the main run). */
  readonly startKey: string;
  readonly dn: number;
  readonly parent?: string;
}

export type PlannedCap = NonNullable<PlannedRun['cap']>;
