/**
 * Crane wheel loads on the frame: per rail, runway weight (G) and the max / min wheel reactions with
 * transverse forces of the crane groups 1, 5 and static (EN 1991-3).
 * @layer domain-aec
 * @pure
 */

import { CRANE_FACTORS, type FrameLoads, type NodeCaseLoad, craneActions } from './frameModelTypes';

/** Crane rail of a frame: bracket node, rail x (mm), eccentricity to the column axis, capacity (t), runway G (kN). */
export interface CraneRail {
  readonly node: number;
  readonly x: number;
  readonly eccentricity: number;
  readonly capacity: number;
  readonly self: number;
}

/** Rails paired left → right per crane bay; CL = maximum reaction on the left rail. */
export function craneRailLoads(
  rails: ReadonlyArray<CraneRail>,
  craneModel: FrameLoads['craneModel'],
  bayWidth: number,
): NodeCaseLoad[] {
  const nodeLoads: NodeCaseLoad[] = [];
  const ordered = [...rails].sort((a, b) => a.x - b.x);
  ordered.forEach((rail, index) => {
    const isLeft = index % 2 === 0;
    const partner = ordered[isLeft ? index + 1 : index - 1];
    const actions = craneActions(
      rail.capacity,
      partner ? Math.abs(partner.x - rail.x) : bayWidth,
      craneModel,
    );
    nodeLoads.push({
      node: rail.node,
      loadCase: 'G',
      fx: 0,
      fy: -rail.self,
      mz: -rail.self * rail.eccentricity,
    });
    // Drive HT acts in the same direction on both rails (CL / CR = +x / −x); skewing HS is a
    // guide reaction balanced by the other rail, hence opposite directions.
    const groups = [
      {
        max: actions.group1.max,
        min: actions.group1.min,
        h: [actions.group1.transverseMax, actions.group1.transverseMin],
        cases: ['CL', 'CR'],
        opposite: false,
      },
      {
        max: actions.group5.max,
        min: actions.group5.min,
        h: [actions.group5.skewMax, actions.group5.skewMin],
        cases: ['CL5', 'CR5'],
        opposite: true,
      },
      {
        max: actions.staticMax,
        min: actions.staticMin,
        h: [
          actions.group1.transverseMax / CRANE_FACTORS.phi5,
          actions.group1.transverseMin / CRANE_FACTORS.phi5,
        ],
        cases: ['CLk', 'CRk'],
        opposite: false,
      },
    ] as const;
    for (const group of groups) {
      for (const loadCase of group.cases) {
        const maximum = !partner || (loadCase === group.cases[0]) === isLeft;
        const reaction = maximum ? group.max : group.min;
        const transverse = maximum ? group.h[0] : group.h[1];
        nodeLoads.push({
          node: rail.node,
          loadCase,
          fx:
            (loadCase === group.cases[0] ? transverse : -transverse) *
            (group.opposite && !maximum ? -1 : 1),
          fy: -reaction,
          mz: -reaction * rail.eccentricity,
        });
      }
    }
  });
  return nodeLoads;
}
