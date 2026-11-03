// What the stress overlay draws: one painted tube per building pipe of the analysis, toned by its worst ratio. Pure.

import type { CadDocument } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import { pipePath, segmentPose, type SegmentPose } from './pipePaths';
import { ratioTone, worstPerPipe, type RatioTone, type StressOutcome } from './stressView';

/** The painted tube is slightly fatter than the pipe so it reads over the pipe's own shading. */
const RADIUS_FACTOR = 0.62;

export interface PaintedPipe {
  readonly pipeId: string;
  readonly tone: RatioTone;
  /** Tube radius in document units. */
  readonly radius: number;
  readonly segments: readonly SegmentPose[];
}

/** Nothing for a refused analysis; pipes that are not building pipes (02 RTE runs) are skipped: their centreline is not exposed to the UI. */
export function paintedPipes(document: CadDocument, outcome: StressOutcome, caseName: string | null): PaintedPipe[] {
  if (!outcome.ok) return [];
  const mmPerUnit = MM_PER_UNIT[document.units];
  return [...worstPerPipe(outcome.view.rows, caseName).values()].flatMap((worst): PaintedPipe[] => {
    const path = pipePath(document, worst.pipeId);
    if (path === null) return [];
    const segments = path.points.slice(1).flatMap((point, i) => {
      const pose = segmentPose(path.points[i] as (typeof path.points)[number], point);
      return pose === null ? [] : [pose];
    });
    return [{ pipeId: path.pipeId, tone: ratioTone(worst.ratio), radius: (path.odMm * RADIUS_FACTOR) / mmPerUnit, segments }];
  });
}
