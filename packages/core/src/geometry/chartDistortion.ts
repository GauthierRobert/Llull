/**
 * How much a chart stretches a sketch (03 WRP, TECHNICAL_SPEC §5.2): the relative length change of the sketch outlines carried onto the face and the area ratio
 * of the regions. A develop chart (plane, cylinder, cone) is an isometry and reports zero without sampling.
 * @invariant strain = (3D chord / chart chord) - 1 over consecutive samples at most a 200th of the sketch size apart; the area ratio is the area on the face (exact
 *   quadrature of the area element in (u, v)) over the area of the sketch regions
 */

import type { Vec2 } from '../model/vectors';
import type { FaceChart } from './chartFrame';
import { sampleSegment, segmentLength, type PlaneSegment } from './planeSegments';
import { integrateDu, loopOfPieces } from './uvIntegrals';

export interface ChartDistortion {
  /** Largest |strain| over the samples. */
  readonly maxLengthStrain: number;
  /** Mean |strain| weighted by chart length. */
  readonly meanLengthStrain: number;
  /** Area on the face over area in the sketch (1 = none). */
  readonly areaRatio: number;
  /** Where the largest |strain| is: the chart (sketch) point and its signed strain. */
  readonly worst: { readonly chart: Vec2; readonly strain: number } | null;
  readonly samples: number;
}

const NONE: ChartDistortion = { maxLengthStrain: 0, meanLengthStrain: 0, areaRatio: 1, worst: null, samples: 0 };
const MIN_PER_SEGMENT = 16;
const MAX_PER_SEGMENT = 400;
const SIZE_DIVISOR = 200;

/** One closed loop of (u, v) pieces and whether it is a hole of its region. */
export interface UvChain {
  readonly pieces: readonly PlaneSegment[];
  readonly hole: boolean;
}

/** Area on the face of the regions bounded by `loops` (outer loops add, holes subtract). */
function faceArea(chart: FaceChart, loops: readonly UvChain[]): number {
  let total = 0;
  for (const { pieces, hole } of loops) {
    const area = Math.abs(integrateDu(loopOfPieces(pieces), chart.areaG));
    total += hole ? -area : area;
  }
  return total;
}

/**
 * @param chains sketch outlines (closed loops and open chains) in chart coordinates
 * @param uvLoops the closed loops mapped to (u, v), for the area ratio
 * @param chartArea area of the sketch regions (outer minus holes)
 */
export function measureDistortion(
  chart: FaceChart,
  chains: ReadonlyArray<readonly PlaneSegment[]>,
  uvLoops: readonly UvChain[],
  chartArea: number,
): ChartDistortion {
  if (chart.method === 'develop') return NONE;
  const points = chains.flat().flatMap((segment) => sampleSegment(segment, 9));
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const size = points.length === 0 ? 0 : Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const step = size / SIZE_DIVISOR;
  let worst: { chart: Vec2; strain: number } | null = null;
  let weighted = 0;
  let length = 0;
  let samples = 0;
  for (const segment of chains.flat()) {
    const count = Math.max(MIN_PER_SEGMENT, Math.min(MAX_PER_SEGMENT, Math.ceil(segmentLength(segment) / Math.max(step, 1e-12))));
    const mapped = sampleSegment(segment, count + 1).map((q) => {
      const uv = chart.uvAt(q);
      return { q, p: uv === null ? null : chart.pointAt(uv) };
    });
    for (let k = 0; k < count; k++) {
      const [a, b] = [mapped[k], mapped[k + 1]];
      if (a === undefined || b === undefined || a.p === null || b.p === null) continue;
      const chord = Math.hypot(b.q[0] - a.q[0], b.q[1] - a.q[1]);
      if (!(chord > 1e-12)) continue;
      const strain = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]) / chord - 1;
      samples += 1;
      weighted += Math.abs(strain) * chord;
      length += chord;
      if (worst === null || Math.abs(strain) > Math.abs(worst.strain))
        worst = { chart: [(a.q[0] + b.q[0]) / 2, (a.q[1] + b.q[1]) / 2], strain };
    }
  }
  return {
    maxLengthStrain: worst === null ? 0 : Math.abs(worst.strain),
    meanLengthStrain: length > 0 ? weighted / length : 0,
    areaRatio: chartArea > 0 && uvLoops.length > 0 ? faceArea(chart, uvLoops) / chartArea : 1,
    worst,
    samples,
  };
}
