/** How the exact kernel builds a sweep: the analytic pipe (constant section, twist-free frame, not along a helix) or the fitted-face path (everything else). */

import type { SweepEntity } from '../../model/types';
import { hasSweepLaws } from './laws';

export type SweepRealisation = 'analytic' | 'fitted';

/** True when a sweep needs more than the kernel's pipe operation: any law, station blend, non-default frame, or a helical path (MakePipe is only ~2e-6 exact on one). */
export function needsFittedFaces(sweep: SweepEntity): boolean {
  const mode = sweep.orientation?.mode ?? 'minimal';
  return hasSweepLaws(sweep) || mode !== 'minimal' || sweep.helix !== undefined;
}

export const sweepRealisation = (sweep: SweepEntity): SweepRealisation => (needsFittedFaces(sweep) ? 'fitted' : 'analytic');
