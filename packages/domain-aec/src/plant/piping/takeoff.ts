/**
 * Takeoff of derived runs (02 RTE §4 `piping_takeoff`): part counts, pipe pieces with cut lengths, joints, total pipe, centreline length,
 * legs, turns and studs. Pure aggregation over `RunDerivation`s; nothing is stored.
 */

import type { Joint, RoutedPart } from '@aec/plant/types';
import type { DerivationWarning, DerivedBranch, DerivedInline, DerivedLeg, DerivedTurn, RunDerivation } from './deriveTypes';

export interface TakeoffRun {
  readonly runId: string;
  readonly derivation: RunDerivation;
}

export interface PipePieceRow {
  readonly id: string;
  readonly runId: string;
  readonly dn: number;
  readonly cutLengthMm: number;
  readonly leg: number;
  readonly catalogueKey: string;
}

export interface Takeoff {
  /** Part counts by takeoff key (`elbow90LR`, `flangeWeldNeck` ...) plus pipePieces, studs and joint counts by kind. */
  readonly counts: Readonly<Record<string, number>>;
  readonly parts: ReadonlyArray<{
    readonly id: string;
    readonly kind: RoutedPart['kind'];
    readonly typeKey: string;
    readonly catalogueKey: string;
    readonly dn: number;
    readonly cutLengthMm?: number;
    readonly angleDeg?: number;
    readonly studs?: number;
    readonly unverified: boolean;
  }>;
  readonly pipePieces: readonly PipePieceRow[];
  readonly joints: readonly Joint[];
  readonly totalPipeMm: number;
  readonly centrelineLengthMm: number;
  readonly legs: ReadonlyArray<DerivedLeg & { readonly runId: string }>;
  readonly turns: ReadonlyArray<DerivedTurn & { readonly runId: string }>;
  /** Valves and reducers as placed (faces, parts) and the branch fittings of the runs. */
  readonly inline: ReadonlyArray<DerivedInline & { readonly runId: string }>;
  readonly branches: readonly DerivedBranch[];
  readonly studs: number;
  readonly warnings: readonly DerivationWarning[];
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
}

const bump = (counts: Record<string, number>, key: string, by = 1): void => {
  counts[key] = (counts[key] ?? 0) + by;
};

const JOINT_KEYS: Readonly<Record<Joint['kind'], string>> = {
  buttWeld: 'buttWelds',
  socketWeld: 'socketWelds',
  threaded: 'threadedJoints',
  flanged: 'flangedJoints',
  fittingToFitting: 'fittingToFitting',
};

/** Round to micrometres so sums of cut lengths do not print float noise. */
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

export function takeoffOf(runs: readonly TakeoffRun[]): Takeoff {
  const counts: Record<string, number> = {};
  for (const key of ['pipePieces', 'buttWelds', 'socketWelds', 'threadedJoints', 'flangedJoints', 'fittingToFitting']) counts[key] = 0;
  const parts: Takeoff['parts'][number][] = [];
  const pipePieces: PipePieceRow[] = [];
  const joints: Joint[] = [];
  const legs: Array<DerivedLeg & { runId: string }> = [];
  const turns: Array<DerivedTurn & { runId: string }> = [];
  const inline: Array<DerivedInline & { runId: string }> = [];
  const branches: DerivedBranch[] = [];
  const warnings: DerivationWarning[] = [];
  const reasons: string[] = [];
  let totalPipe = 0;
  let centreline = 0;
  let studs = 0;
  for (const { runId, derivation } of runs) {
    for (const part of derivation.parts) {
      if (part.kind === 'pipe') {
        bump(counts, 'pipePieces');
        pipePieces.push({
          id: part.id,
          runId,
          dn: part.dn,
          cutLengthMm: round(part.cutLength ?? 0),
          leg: part.leg ?? 0,
          catalogueKey: part.catalogueKey,
        });
      } else bump(counts, part.typeKey);
      studs += part.studs ?? 0;
      parts.push({
        id: part.id,
        kind: part.kind,
        typeKey: part.typeKey,
        catalogueKey: part.catalogueKey,
        dn: part.dn,
        ...(part.cutLength === undefined ? {} : { cutLengthMm: round(part.cutLength) }),
        ...(part.angleDeg === undefined ? {} : { angleDeg: round(part.angleDeg) }),
        ...(part.studs === undefined ? {} : { studs: part.studs }),
        unverified: part.unverified,
      });
    }
    for (const joint of derivation.joints) {
      bump(counts, JOINT_KEYS[joint.kind]);
      joints.push(joint);
    }
    legs.push(...derivation.legs.map((leg) => ({ ...leg, runId })));
    turns.push(...derivation.turns.map((turn) => ({ ...turn, runId })));
    inline.push(...derivation.inline.map((item) => ({ ...item, runId })));
    branches.push(...derivation.branches);
    warnings.push(...derivation.warnings);
    reasons.push(...derivation.unverifiedReasons.filter((reason) => !reasons.includes(reason)));
    totalPipe += derivation.totalPipeMm;
    centreline += derivation.centrelineLengthMm;
  }
  counts['studs'] = studs;
  return {
    counts,
    parts,
    pipePieces,
    joints,
    totalPipeMm: round(totalPipe),
    centrelineLengthMm: round(centreline),
    legs,
    turns,
    inline,
    branches,
    studs,
    warnings,
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
  };
}
