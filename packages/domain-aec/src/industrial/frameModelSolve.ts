/**
 * frameModel: frameModelSolve.
 * @layer domain-aec
 */

import type { BuildingModel } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { solveFrame, type FrameResult } from '@lib/frame2d';
import type { FrameLoads, FrameModel, LoadCase } from './frameModelTypes';
import { framesOf } from './frameModelFrames';

type NodeForce = { readonly node: number; readonly fx: number };

/** Linear analysis of a frame under factored load cases (+ extra horizontal node forces). */
export function solveCombination(
  frame: FrameModel,
  factors: Partial<Record<LoadCase, number>>,
  extra: ReadonlyArray<NodeForce> = [],
): FrameResult | null {
  const nodeLoads = frame.nodes.map(() => ({ fx: 0, fy: 0, mz: 0 }));
  for (const load of frame.nodeLoads) {
    const factor = factors[load.loadCase] ?? 0;
    const target = nodeLoads[load.node];
    if (!target || factor === 0) continue;
    target.fx += factor * load.fx;
    target.fy += factor * load.fy;
    target.mz += factor * load.mz;
  }
  for (const force of extra) {
    const target = nodeLoads[force.node];
    if (target) target.fx += force.fx;
  }
  return solveFrame(
    frame.nodes.map((node, index) => ({
      ...node,
      load: nodeLoads[index] ?? { fx: 0, fy: 0, mz: 0 },
    })),
    frame.members.map((member) => {
      let [qx, qy] = [0, 0];
      for (const [loadCase, load] of Object.entries(member.loads) as [
        LoadCase,
        { qx: number; qy: number },
      ][]) {
        const factor = factors[loadCase] ?? 0;
        qx += factor * load.qx;
        qy += factor * load.qy;
      }
      return { ...member.geometry, load: { qx, qy } };
    }),
  );
}

export interface BaseReaction {
  readonly frame: string;
  readonly columnId: string;
  /**
   * Characteristic support reaction per load case on the column: horizontal (N, +x), vertical
   * (N, + up) and base moment (N·mm, counter-clockwise +; 0 for pinned bases).
   */
  readonly cases: Partial<
    Record<
      LoadCase,
      { readonly horizontal: number; readonly vertical: number; readonly moment: number }
    >
  >;
}

const LOAD_CASES: ReadonlyArray<LoadCase> = [
  'G',
  'S',
  'WL',
  'WR',
  'WLs',
  'WRs',
  'WLp',
  'WRp',
  'CL',
  'CR',
  'CL5',
  'CR5',
];

/**
 * Characteristic base reactions of every analysed frame column, per load case (first-order).
 * @pure
 */
export function baseReactions(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  levelId: string,
  loads: FrameLoads,
): BaseReaction[] {
  const { frames } = framesOf(doc, building, levelId, loads);
  return frames.flatMap((frame) => {
    const present = (loadCase: LoadCase): boolean =>
      loadCase !== 'WLp' && loadCase !== 'WRp'
        ? true
        : frame.windCases.some((windCase) => windCase.loadCase === loadCase);
    const results = LOAD_CASES.filter(present).map((loadCase) => ({
      loadCase,
      result: solveCombination(frame, { [loadCase]: 1 }),
    }));
    return frame.members.flatMap((member, index): BaseReaction[] => {
      const [a, b] = [frame.nodes[member.geometry.a], frame.nodes[member.geometry.b]];
      if (member.role !== 'column' || !member.ends[0] || !a || !b) return [];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const [c, s] = [(b.x - a.x) / length, (b.y - a.y) / length];
      const cases: BaseReaction['cases'] = {};
      const fixed = frame.nodes[member.geometry.a]?.restraint[2] === true;
      for (const { loadCase, result } of results) {
        const forces = result?.members[index];
        if (!forces) continue;
        const [axial, shear] = [-forces.axial[0], forces.shear[0]];
        cases[loadCase] = {
          horizontal: c * axial - s * shear,
          vertical: s * axial + c * shear,
          moment: fixed ? -forces.moment[0] : 0,
        };
      }
      return [{ frame: frame.label, columnId: member.elementId, cases }];
    });
  });
}
