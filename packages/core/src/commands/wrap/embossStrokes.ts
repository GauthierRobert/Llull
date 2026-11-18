import type { Vec2 } from '../../model/types';
import { sampleSegment, segmentArea, segmentLength, type PlaneSegment } from '../../geometry/planeSegments';
import { strokeRegions } from '../../geometry/strokeRegions';
import type { CommandResult } from '../types';
import type { EmbossFail, EmbossRequest } from './embossRequest';
import type { ChartRegion, SketchOutline } from './sketchProfiles';

export interface Stroked {
  readonly outlines: SketchOutline[];
  readonly regions: ChartRegion[];
  readonly strokeLength: number;
}

/** Polylines of every outline path of `outlines`: open chains and the contours of closed regions (a groove follows a path, it does not fill). */
function paths(outlines: readonly SketchOutline[], width: number): Vec2[][] {
  const pointsOfChain = (chain: readonly PlaneSegment[]): Vec2[] => {
    const points = chain.flatMap((piece, k) => {
      const count = piece.kind === 'line' ? 2 : Math.min(200, Math.max(8, Math.ceil(segmentLength(piece) / (width / 4)))) + 1;
      return sampleSegment(piece, count).slice(k === 0 ? 0 : 1);
    });
    return points;
  };
  return outlines.flatMap((outline) => [
    ...outline.open.map(pointsOfChain),
    ...outline.regions.flatMap((region) =>
      [region.outer, ...region.holes].map((chain) => [...pointsOfChain(chain), pointsOfChain(chain)[0] as Vec2]),
    ),
  ]);
}

const lineChain = (polygon: readonly Vec2[]): PlaneSegment[] =>
  polygon.map((from, k) => ({ kind: 'line' as const, from, to: polygon[(k + 1) % polygon.length] as Vec2 }));

export function strokeOutlines(outlines: readonly SketchOutline[], params: EmbossRequest, fail: EmbossFail): Stroked | CommandResult {
  const lines = paths(outlines, params.toolWidth as number);
  const strokeLength = lines.reduce(
    (sum, line) =>
      sum +
      line.reduce((inner, p, k) => (k === 0 ? 0 : inner + Math.hypot(p[0] - (line[k - 1] as Vec2)[0], p[1] - (line[k - 1] as Vec2)[1])), 0),
    0,
  );
  const swept = strokeRegions(lines, params.toolWidth as number);
  if ('error' in swept) return fail('WRP_PROFILE_SELF_INTERSECT', swept.error, ['profileIds'], params.profileIds);
  const regions = swept.map((region) => ({ outer: lineChain(region.outer), holes: region.holes.map(lineChain) }));
  return {
    outlines: [
      {
        ...(outlines[0] as SketchOutline),
        regions,
        open: [],
        area: regions.reduce((sum, r) => sum + Math.abs(r.outer.reduce((a, s) => a + segmentArea(s), 0)), 0),
      },
    ],
    regions,
    strokeLength,
  };
}
