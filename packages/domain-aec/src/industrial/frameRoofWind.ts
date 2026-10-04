/**
 * Frame-average roof cpe,10 of a rafter and rafter end geometry (x/z in mm), for the wind load cases of a frame.
 * @layer domain-aec
 * @pure
 */

import type { SteelMemberElement } from '@core/model/building';
import { FLAT_ROOF_LIMIT, frameRoofAverage } from './windCoefficients';
import { DOWNWIND_ROOF_FACTOR, type WindCase } from './frameModelTypes';

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
