/**
 * Frame load inputs: candidate frames of a level (rafters chained into halls), frame-average roof
 * wind coefficients and crane rail wheel loads (EN 1991-3). Lengths in mm.
 * @layer domain-aec
 * @pure
 */
import type { SteelMemberElement } from '@core/model/building';
import { FLAT_ROOF_LIMIT, frameRoofAverage } from './windCoefficients';
import {
  DOWNWIND_ROOF_FACTOR,
  type WindCase,
  CRANE_FACTORS,
  type FrameLoads,
  type NodeCaseLoad,
  craneActions,
} from './frameModelTypes';

interface FrameCandidate {
  readonly y: number;
  range: [number, number];
  readonly rafters: SteelMemberElement[];
}

export function frameCandidates(
  rafters: ReadonlyArray<SteelMemberElement>,
  mm: (value: number) => number,
  tolerance: number,
): { candidates: FrameCandidate[]; tributaryOf: (candidate: FrameCandidate) => number } {
  const planeOf = (member: SteelMemberElement): number => Math.round(mm(member.start[1]));
  const xRange = (member: SteelMemberElement): [number, number] => [
    Math.min(mm(member.start[0]), mm(member.end[0])),
    Math.max(mm(member.start[0]), mm(member.end[0])),
  ];
  const candidates: FrameCandidate[] = [];
  for (const y of [...new Set(rafters.map(planeOf))].sort((a, b) => a - b)) {
    const inPlane = rafters
      .filter((rafter) => planeOf(rafter) === y)
      .sort((a, b) => xRange(a)[0] - xRange(b)[0]);
    for (const rafter of inPlane) {
      const [low, high] = xRange(rafter);
      const last = candidates[candidates.length - 1];
      if (last && last.y === y && low <= last.range[1] + tolerance) {
        last.range = [last.range[0], Math.max(last.range[1], high)];
        last.rafters.push(rafter);
      } else {
        candidates.push({ y, range: [low, high], rafters: [rafter] });
      }
    }
  }
  // Halls: candidates (across planes) whose x-ranges overlap; tributary widths per hall.
  const hallOf = new Map<FrameCandidate, FrameCandidate[]>();
  for (const candidate of candidates) {
    const hall = [...new Set(hallOf.values())].find((hallMembers) =>
      hallMembers.some(
        (other) => candidate.range[0] < other.range[1] && candidate.range[1] > other.range[0],
      ),
    );
    if (hall) {
      hall.push(candidate);
      hallOf.set(candidate, hall);
    } else {
      hallOf.set(candidate, [candidate]);
    }
  }
  const tributaryOf = (candidate: FrameCandidate): number => {
    const ys = [...new Set((hallOf.get(candidate) ?? [candidate]).map((other) => other.y))].sort(
      (a, b) => a - b,
    );
    const index = ys.indexOf(candidate.y);
    return ((ys[index + 1] ?? candidate.y) - (ys[index - 1] ?? candidate.y)) / 2;
  };
  return { candidates, tributaryOf };
}

interface RafterEnds {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  /** true when the member is stored right-to-left. */
  readonly flip: boolean;
}

interface FrameRoof {
  readonly low: number;
  readonly high: number;
  readonly rafters: ReadonlyArray<SteelMemberElement>;
  /** Plan x of the valley lines between spans, mm. */
  readonly valleys: ReadonlyArray<number>;
}

export function frameRoofWind(
  roof: FrameRoof,
  mm: (value: number) => number,
  near: (a: number, b: number) => boolean,
): {
  rafterEnds: (rafter: SteelMemberElement) => RafterEnds;
  roofCpe: (rafter: SteelMemberElement, windCase: WindCase) => number;
} {
  const { low, high, valleys } = roof;
  const rafterEnds = (rafter: SteelMemberElement): RafterEnds => {
    const flip = rafter.start[0] > rafter.end[0];
    const [first, second] = flip ? [rafter.end, rafter.start] : [rafter.start, rafter.end];
    return {
      x0: mm(first[0]),
      z0: mm(first[2]),
      x1: mm(second[0]),
      z1: mm(second[2]),
      flip,
    };
  };
  // A monopitch rafter has no partner meeting it at its high end (no apex).
  const highEnd = (point: readonly number[], other: readonly number[]): boolean =>
    (point[2] ?? 0) >= (other[2] ?? 0);
  const hasApex = (rafter: SteelMemberElement): boolean =>
    roof.rafters.some((other) => {
      if (other.id === rafter.id) return false;
      const [mine, theirs] = [
        highEnd(rafter.start, rafter.end) ? rafter.start : rafter.end,
        highEnd(other.start, other.end) ? other.start : other.end,
      ];
      return mine.every((value, axis) => near(mm(value), mm(theirs[axis] ?? 0)));
    });
  /**
   * Frame-average roof cpe,10 of a rafter for a wind case (EN 1991-1-4 via windCoefficients.ts):
   * duopitch windward slope H, leeward I/J; monopitch H of the wind direction; flat (< 5°) roofs H on the
   * windward half of the hall and I on the other, weighted by the rafter length in each half. Spans
   * downwind of the windward span (Fig. 7.10, simplified) keep their suction × DOWNWIND_ROOF_FACTOR.
   */
  const roofCpe = (rafter: SteelMemberElement, windCase: WindCase): number => {
    const { x0, z0, x1, z1 } = rafterEnds(rafter);
    const pitchDegrees = (Math.atan2(Math.abs(z1 - z0), Math.abs(x1 - x0)) * 180) / Math.PI;
    const fromLeft = windCase.from === 'left';
    const apex = hasApex(rafter);
    if (pitchDegrees < FLAT_ROOF_LIMIT) {
      const middle = (low + high) / 2;
      const [half0, half1] = fromLeft ? [low, middle] : [middle, high];
      const overlap = Math.max(0, Math.min(x1, half1) - Math.max(x0, half0));
      const share = Math.min(1, overlap / Math.max(x1 - x0, 1));
      const flat = (slope: 'windward' | 'leeward'): number =>
        frameRoofAverage('flat', pitchDegrees, 0, windCase.roofSet, slope);
      return share * flat('windward') + (1 - share) * flat('leeward');
    }
    const faces = fromLeft === z1 > z0;
    if (!apex) {
      return frameRoofAverage('monopitch', pitchDegrees, faces ? 0 : 180, windCase.roofSet);
    }
    const spanIndex = valleys.filter((valley) => valley < (x0 + x1) / 2).length;
    const cpe = frameRoofAverage(
      'duopitch',
      pitchDegrees,
      0,
      windCase.roofSet,
      faces ? 'windward' : 'leeward',
    );
    const windwardSpan = spanIndex === (fromLeft ? 0 : valleys.length);
    return windwardSpan || cpe > 0 ? cpe : DOWNWIND_ROOF_FACTOR * cpe;
  };

  return { rafterEnds, roofCpe };
}

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
