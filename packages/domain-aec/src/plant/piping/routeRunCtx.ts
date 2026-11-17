/** The state one run derivation threads through its phases (legs, end parts, result): the inputs fixed after layout and the accumulators it fills. */

import type { Vec3 } from '@core/model/vectors';
import type { Joint, RoutedPart } from '@aec/plant/types';
import type { DerivationWarning, DerivedInline, DerivedLeg } from './deriveTypes';
import type { LegShifts } from './legShifts';
import type { BranchFit } from './routeBranch';
import type { FlangeSetIds } from './routeEnds';
import type { EndSetup, Env, Mint, Slot } from './routeEnv';
import type { Turns } from './routeTurns';

export interface RunCtx {
  readonly env: Env;
  readonly start: EndSetup;
  readonly end: EndSetup;
  readonly dnStart: number;
  readonly dnEnd: number;
  readonly od: number;
  readonly points: readonly Vec3[];
  readonly dirs: readonly Vec3[];
  readonly lengths: readonly number[];
  readonly eps: number;
  readonly chosen: Turns;
  readonly shifts: LegShifts;
  readonly slotsByLeg: ReadonlyMap<number, Slot[]>;
  readonly fits: readonly BranchFit[];
  readonly mint: Mint;
  readonly startIds: FlangeSetIds | null;
  readonly startCapId: string | null;
  readonly startBlindId: string | null;
  readonly endIds: FlangeSetIds | null;
  readonly endCapId: string | null;
  readonly endBlindId: string | null;
  readonly flangedKind: Joint['kind'];
  readonly parts: RoutedPart[];
  readonly joints: Joint[];
  readonly legs: DerivedLeg[];
  readonly inline: DerivedInline[];
  readonly warnings: DerivationWarning[];
  addJoint(joint: Omit<Joint, 'id'>): void;
}
