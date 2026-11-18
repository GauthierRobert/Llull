import type { PlaneSegment } from '../../geometry/planeSegments';
import type { CommandResult } from '../types';
import { DEFAULT_MAX_LENGTH_STRAIN } from './conventions';
import { distortionData, distortionMessage, distortionOf } from './distortion';
import type { EmbossCall } from './embossRequest';
import type { ChartRegion, SketchOutline } from './sketchProfiles';
import { checkOnFace, checkWrapAround, isMappingFailure, mapOutlineRegions, probePoints, type MappingFailure } from './wrapMapping';

export const MAX_PROBES = 48;

export type Mapped = Exclude<ReturnType<typeof mapOutlineRegions>, MappingFailure>;

export interface MappedEmboss {
  readonly mapped: Mapped;
  readonly distortion: ReturnType<typeof distortionOf>;
  readonly limit: number;
  readonly holeFlags: boolean[];
}

export function mapAndCheck(call: EmbossCall, regions: ChartRegion[], outlines: SketchOutline[]): MappedEmboss | CommandResult {
  const { doc, params, session, resolved, fail, tolerance } = call;
  const { chart } = resolved;
  const mapped = mapOutlineRegions(session, chart, regions, tolerance);
  if (isMappingFailure(mapped)) return fail(mapped.code, mapped.message, ['profileIds'], params.profileIds);
  const overlap = checkWrapAround(chart, mapped.pieces, params.profileIds);
  if (overlap !== null) {
    const result = fail(overlap.code, overlap.message, ['profileIds'], params.profileIds);
    return { ...result, data: { fullWrapChartWidth: chart.fullWrapWidth, unit: doc.units } };
  }
  const outside = checkOnFace(session, probePoints(chart, mapped.pieces, MAX_PROBES), params.profileIds);
  if (outside !== null) return fail(outside.code, outside.message, [params.grid === undefined ? 'profileIds' : 'grid'], params.profileIds);
  const limit = params.maxLengthStrain ?? DEFAULT_MAX_LENGTH_STRAIN;
  const holeFlags = regions.flatMap((region) => [false, ...region.holes.map(() => true)]);
  const distortion = distortionOf(
    chart,
    outlines,
    holeFlags.map((hole, index) => ({ pieces: mapped.pieces[index] as PlaneSegment[], hole })),
  );
  if (distortion.maxLengthStrain > limit) {
    const refused = fail('WRP_DISTORTION_EXCEEDED', distortionMessage(distortion, limit, chart.method), ['placement']);
    return {
      ...refused,
      data: { distortion: distortionData(distortion, chart, resolved.method, limit, params.maxLengthStrain === undefined) },
    };
  }
  return { mapped, distortion, limit, holeFlags };
}
