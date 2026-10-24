/** Result shapes of the run derivation (`routeParts.deriveRun`): parts, joints, legs, turns, inline components, branches and the trust bookkeeping. */

import type { Vec3 } from '@core/model/vectors';
import type { Joint, RoutedPart } from '@aec/plant/types';
import type { Compass } from './legs';

export interface DerivationFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

export interface DerivedLeg {
  readonly index: number;
  readonly direction: Compass | Vec3;
  readonly lengthMm: number;
  readonly start: Vec3;
  readonly end: Vec3;
  /** Cut lengths of the pipe pieces on this leg, in order. */
  readonly cutLengthsMm: readonly number[];
  /** Sloped legs only (neither horizontal nor vertical): horizontal length, drop along the flow (positive = descends) and the angle below horizontal. */
  readonly planLengthMm?: number;
  readonly dropMm?: number;
  readonly slopeDeg?: number;
}

export interface DerivedTurn {
  /** Index of the point of intersection (1-based: the turn between leg index-1 and leg index). */
  readonly index: number;
  readonly point: Vec3;
  readonly partId: string;
  readonly turnDeg: number;
  readonly nominalDeg: number;
  readonly deviationDeg: number;
  readonly centreToEnd: number;
  readonly radius: number;
  readonly catalogueKey: string;
  /** Takeoff key of the elbow (`elbow90LR`). */
  readonly typeKey: string;
}

export interface DerivationWarning {
  readonly code: string;
  readonly ids: readonly string[];
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** A valve or reducer as placed: where its faces are and which derived parts belong to it. */
export interface DerivedInline {
  readonly id: string;
  readonly type: string;
  readonly tag?: string;
  readonly leg: number;
  readonly centreDistance: number;
  /** Size entering the component; reducers: `dn2` is the size leaving. */
  readonly dn: number;
  readonly dn2?: number;
  /** Face-to-face (valves) or end-to-end (reducers) length, mm. */
  readonly lengthMm: number;
  readonly centre: Vec3;
  /** Upstream and downstream end faces of the component body. */
  readonly faces: readonly [Vec3, Vec3];
  /** The valve / reducer part and its flange sets (route order). */
  readonly partIds: readonly string[];
  readonly valvePartId: string;
  readonly stemDirection?: Vec3;
  /** Valves: the catalogue stem height (handwheel centre = centre + stem x height), mm, or null when the row has none. */
  readonly stemHeightMm: number | null;
  /** Eccentric reducers: the flat side (unit vector from the axis, perpendicular to the leg), its label and the offset of the downstream axis (vector and length, mm). */
  readonly flat?: {
    readonly direction: Vec3;
    readonly label: 'top' | 'bottom' | 'side';
    readonly offset: Vec3;
    readonly offsetMm: number;
    /** Vertical step of the pipe bottom (invert) across the reducer along the flow, mm: positive = the downstream bottom is higher (traps liquid). */
    readonly invertStepMm: number;
  };
}

/** A branch fitting on a header run (the tee / olet / stub-in a branch run starts from). */
export interface DerivedBranch {
  readonly id: string;
  readonly headerRunId: string;
  readonly branchRunId: string;
  readonly leg: number;
  readonly distance: number;
  /** `tee`: splits the header; `olet`: welded to a header piece; `stubIn`: branch pipe welded to the header, no fitting. */
  readonly kind: 'tee' | 'olet' | 'stubIn';
  /** Branch-table cell: T, RT, W, S, TH, SI, SIR. */
  readonly fittingCode: string;
  /** Takeoff key of the fitting (`tee`, `reducingTee`, `weldolet`, ...; `stubIn`). */
  readonly typeKey: string;
  readonly partId: string;
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly headerDn: number;
  readonly branchDn: number;
  /** Where the branch pipe starts, measured from the header centreline along the branch: tee M, olet A, stub-in OD / 2. */
  readonly branchStartMm: number;
  /** Which catalogue dimension gave `branchStartMm`. */
  readonly branchStartSource: string;
  /** Tee: centre-to-end on the run (C) each side of the branch point, else null. */
  readonly runCentreToEndMm: number | null;
  readonly reviewRequired: boolean;
}

export interface RunDerivation {
  readonly ok: true;
  readonly parts: readonly RoutedPart[];
  readonly joints: readonly Joint[];
  readonly legs: readonly DerivedLeg[];
  readonly turns: readonly DerivedTurn[];
  readonly inline: readonly DerivedInline[];
  readonly branches: readonly DerivedBranch[];
  readonly warnings: readonly DerivationWarning[];
  readonly centrelineLengthMm: number;
  readonly totalPipeMm: number;
  readonly spec: { readonly id: string; readonly revision: number; readonly status: string };
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly angleTolerance: { readonly valueDeg: number; readonly source: 'run' | 'spec' | 'default' };
  readonly weldGap: { readonly valueMm: number; readonly defaulted: true };
  readonly weldSpacing: { readonly minimumMm: number; readonly defaulted: true };
  /** Pipe at the run start (OD, wall, row key). */
  readonly pipe: { readonly outsideDiameterMm: number; readonly wallMm: number; readonly key: string };
  /** Size at the run start and at its end (after the reducers). */
  readonly dn: { readonly start: number; readonly end: number };
  readonly studs: number;
  /** Reasons a flanged component or branch fitting needs a human review (stub-in reinforcement). */
  readonly reviewRequired: readonly string[];
}

export const fail = (
  code: string,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
  detail?: Readonly<Record<string, unknown>>,
): DerivationFailure => ({ ok: false, code, message, ids, paths, detail });

export const isFailure = (value: object): value is DerivationFailure => 'ok' in value && value.ok === false;
