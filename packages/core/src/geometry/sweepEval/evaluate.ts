/**
 * The sweep evaluator: frames per orientation mode, arc-length fractions and the section transform (twist / scale / area / stretch) at each
 * frame. One evaluator feeds the mesh, the display, `inspect_sweep` and the native payload.
 * @invariant a sweep without laws, station blend or orientation is sampled and framed exactly as before the laws existed
 */

import type { CurveSegment } from '../../model/curve';
import type { SweepEntity, Vec3 } from '../../model/types';
import type { LawIssue } from '../../lib/law/types';
import { helixLength } from '../../lib/helix/helix';
import { chainLength, isClosedChain, segmentSteps } from '../curveSegments';
import { frameFractions, orientedFrames, type FrameIssue, type SweepFrame } from './frames';
import { hasSweepLaws, sectionTransforms, sweepLawIssue, twistVariation, type SectionTransform, type SweepLawShape } from './laws';

/** What a sweep's geometry depends on (a SweepEntity satisfies it). */
export type SweepShape = Pick<SweepEntity, 'path' | 'section'> &
  Partial<Pick<SweepEntity, 'stations' | 'stationBlend' | 'orientation' | 'twist' | 'scale' | 'area' | 'stretch' | 'helix'>>;

export interface SweepEvaluation {
  readonly frames: SweepFrame[];
  /** Arc-length fraction of each frame. */
  readonly fractions: number[];
  /** Per-frame section transform; null when the sweep has no law (sections are placed as they are). */
  readonly transforms: SectionTransform[] | null;
  readonly length: number;
}

/** A refused evaluation: a degenerate frame or a bad law. */
export type SweepEvaluationIssue = FrameIssue | (LawIssue & { readonly param: string });

/** Arc length of the sweep path: the exact helix length when the path is an `add_helix` curve, else the chain length. */
export function pathLength(shape: Pick<SweepShape, 'path' | 'helix'>): number {
  return shape.helix === undefined ? chainLength(shape.path) : helixLength(shape.helix);
}

/** Frames wanted per radian of twist, and the least frames of a sweep with laws. */
const FRAMES_PER_RADIAN = 24;
const MIN_LAW_FRAMES = 64;
const MAX_FRAMES = 4000;

function refinement(path: ReadonlyArray<CurveSegment<Vec3>>, shape: SweepLawShape, length: number): number {
  if (!hasSweepLaws(shape)) return 1;
  const base = path.reduce((total, segment) => total + segmentSteps(segment), 0);
  const wanted = Math.min(MAX_FRAMES, Math.max(MIN_LAW_FRAMES, Math.ceil(FRAMES_PER_RADIAN * twistVariation(shape, length))));
  return Math.max(1, Math.ceil(wanted / base));
}

/**
 * Frames, fractions and transforms of a sweep.
 * @failure invalid laws -> SWG_LAW_INVALID / SWG_LAW_NONPOSITIVE with the parameter; a degenerate frame mode -> SWG_FRAME_DEGENERATE
 */
export function evaluateSweep(shape: SweepShape): SweepEvaluation | SweepEvaluationIssue {
  const length = pathLength(shape);
  const lawIssue = sweepLawIssue(shape, length);
  if (lawIssue !== null) return lawIssue;
  const frames = orientedFrames(shape.path, shape.orientation, refinement(shape.path, shape, length));
  if (!Array.isArray(frames)) return frames;
  const list: SweepFrame[] = frames;
  const first = list[0];
  const fractions = isClosedChain(shape.path) && first !== undefined ? frameFractions([...list, first]).slice(0, -1) : frameFractions(list);
  return { frames: list, fractions, transforms: hasSweepLaws(shape) ? sectionTransforms(shape, fractions, length) : null, length };
}
