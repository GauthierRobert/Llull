/** The distortion block of the wrap commands' `data` (03 WRP, TECHNICAL_SPEC §5.2): measured stretch of a geodesic or parametric chart against the named limit. */

import type { FaceChart } from '../../geometry/chartFrame';
import { measureDistortion, type ChartDistortion, type UvChain } from '../../geometry/chartDistortion';
import type { SketchOutline } from './sketchProfiles';

/** Stretch of `outlines` on `chart`; a develop chart is an isometry and reports zero. */
export function distortionOf(chart: FaceChart, outlines: readonly SketchOutline[], uvLoops: readonly UvChain[]): ChartDistortion {
  const chains = outlines.flatMap((outline) => [...outline.regions.flatMap((region) => [region.outer, ...region.holes]), ...outline.open]);
  return measureDistortion(
    chart,
    chains,
    uvLoops,
    outlines.reduce((sum, outline) => sum + outline.area, 0),
  );
}

/** `data.distortion`: the numbers, the method and the limit it was held to. */
export function distortionData(
  distortion: ChartDistortion,
  chart: FaceChart,
  requested: string,
  limit: number,
  defaulted: boolean,
): Record<string, unknown> {
  return {
    /** Signed strain of the most stretched (or squeezed) place: negative = shorter on the face than in the sketch. */
    maxLengthStrain: distortion.worst === null ? 0 : distortion.worst.strain,
    maxAbsLengthStrain: distortion.maxLengthStrain,
    meanLengthStrain: distortion.meanLengthStrain,
    areaRatio: distortion.areaRatio,
    worst: distortion.worst === null ? null : { chart: distortion.worst.chart, strain: distortion.worst.strain },
    samples: distortion.samples,
    method: chart.method,
    methodRequested: requested,
    limit,
    limitDefaulted: defaulted,
    ...(chart.method === 'develop' ? { note: 'plane, cylinder and cone develop without stretch' } : {}),
  };
}

/** The refusal text for a stretch above the limit. */
export const distortionMessage = (distortion: ChartDistortion, limit: number, method: string): string =>
  `the ${method} chart stretches the sketch by up to ${(100 * distortion.maxLengthStrain).toPrecision(4)} % (limit ${(100 * limit).toPrecision(4)} %)${
    distortion.worst === null ? '' : ` near sketch point [${distortion.worst.chart.map((x) => x.toPrecision(5)).join(', ')}]`
  }`;
