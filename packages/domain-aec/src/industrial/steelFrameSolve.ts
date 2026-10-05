/**
 * Load cases of a moment frame: ULS 1.35 G + 1.5 Q with the equivalent horizontal forces of EN
 * 1993-1-1 §5.3.2 (φ × the vertical load at each level, both directions), SLS G + Q (+ the same
 * forces for the storey drift), and αcr from the drift under V/200 (Horne, EN 1993-1-1 §5.2.1(4)B).
 * @layer domain-aec
 * @pure
 */

import { solveFrame, type FrameResult } from '@lib/frame2d';
import type { LoadFactors } from './steelBeamAnalysis';
import { amplificationOf } from './steelDesign';
import type { FrameSystem, StoreyPiece } from './steelFrameModel';
import { GAMMA_IMPOSED, GAMMA_PERMANENT } from './steelFraming';

export interface FrameSolutions {
  /** 1.35 G + 1.5 Q with the notional forces toward +u and −u. */
  readonly uls: readonly [FrameResult, FrameResult];
  /** G + Q without horizontal forces. */
  readonly slsGravity: FrameResult;
  /** G + Q with the notional forces toward +u and −u (storey drift). */
  readonly slsSway: readonly [FrameResult, FrameResult];
  /** Elastic critical load factor; Infinity when no compressed column sways. */
  readonly alphaCritical: number;
  readonly criticalColumn: string | null;
  /** Moment amplification 1 / (1 − 1/αcr) applied when αcr < 10. */
  readonly amplification: number;
}

const ULS: LoadFactors = { permanent: GAMMA_PERMANENT, imposed: GAMMA_IMPOSED };
const SLS: LoadFactors = { permanent: 1, imposed: 1 };
/** Horne's reference horizontal force, 1/200 of the vertical load. */
const HORNE_FACTOR = 1 / 200;

/** One linear analysis; `sway` is the signed fraction of the level load applied horizontally. */
function solveCase(system: FrameSystem, factors: LoadFactors, sway: number): FrameResult | null {
  const loads = system.nodes.map(() => ({ fx: 0, fy: 0, mz: 0 }));
  for (const load of system.nodeLoads) {
    const target = loads[load.node];
    if (target) target.fy -= factors.permanent * load.permanent + factors.imposed * load.imposed;
  }
  if (sway !== 0) {
    for (const level of system.levels) {
      const vertical = factors.permanent * level.permanent + factors.imposed * level.imposed;
      for (const node of level.nodes) {
        const target = loads[node];
        if (target) target.fx += (sway * vertical) / level.nodes.length;
      }
    }
  }
  return solveFrame(
    system.nodes.map((node, index) => ({ ...node, load: loads[index] ?? { fx: 0, fy: 0, mz: 0 } })),
    system.members.map((member) => ({
      ...member.geometry,
      load: {
        qx: 0,
        qy: -(factors.permanent * member.permanent + factors.imposed * member.imposed),
      },
    })),
  );
}

/** Relative horizontal displacement over a storey piece, mm. */
export const driftOf = (result: FrameResult, piece: StoreyPiece): number =>
  Math.abs(
    (result.displacements[piece.top]?.[0] ?? 0) - (result.displacements[piece.bottom]?.[0] ?? 0),
  );

/**
 * @param notionalFactor φ of the equivalent horizontal forces
 * @returns null when the frame is a mechanism (some case cannot be solved)
 */
export function solveFrameSystem(
  system: FrameSystem,
  notionalFactor: number,
): FrameSolutions | null {
  const cases = [
    solveCase(system, ULS, notionalFactor),
    solveCase(system, ULS, -notionalFactor),
    solveCase(system, SLS, 0),
    solveCase(system, SLS, notionalFactor),
    solveCase(system, SLS, -notionalFactor),
    solveCase(system, ULS, HORNE_FACTOR),
  ];
  const [ulsPlus, ulsMinus, slsGravity, slsPlus, slsMinus, horne] = cases;
  if (!(ulsPlus && ulsMinus && slsGravity && slsPlus && slsMinus && horne)) return null;
  let alphaCritical = Infinity;
  let criticalColumn: string | null = null;
  for (const piece of system.storeyPieces) {
    const layout = system.layouts.get(piece.columnId);
    if (!layout) continue;
    const from = layout.nodes.indexOf(piece.bottom);
    const to = layout.nodes.indexOf(piece.top);
    const compression = Math.max(
      0,
      ...layout.members
        .slice(from, to)
        .flatMap((index) => (ulsPlus.members[index]?.axial ?? []).map((axial) => -axial)),
    );
    const drift = driftOf(horne, piece);
    if (!(compression > 0 && drift > 0)) continue;
    const alpha = piece.height / (200 * drift);
    if (alpha < alphaCritical) {
      alphaCritical = alpha;
      criticalColumn = piece.columnId;
    }
  }
  return {
    uls: [ulsPlus, ulsMinus],
    slsGravity,
    slsSway: [slsPlus, slsMinus],
    alphaCritical,
    criticalColumn,
    amplification: amplificationOf(alphaCritical),
  };
}
