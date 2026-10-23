/** Laws of a sweep (twist, scale, area, stretch) applied to the section by arc-length fraction. */

import type { SweepEntity, Vec2 } from '../../model/types';
import { lawFunction, lawIssue } from '../../lib/law/evaluate';
import type { LawIssue, ScalarLaw } from '../../lib/law/types';
import { polygonArea } from '../../lib/polygon';
import type { SweepFrame } from './frames';
import { railTransforms, type RailIssue } from './rails';
import type { SectionTransform } from './sectionTransform';

/** What the laws of a sweep depend on (a SweepEntity satisfies it). */
export type SweepLawShape = Pick<
  SweepEntity,
  'section' | 'stations' | 'twist' | 'scale' | 'area' | 'stretch' | 'stationBlend' | 'rails' | 'guideMode' | 'maintainHeight' | 'anchors'
>;

/** True when the sweep carries a law or an explicit station blend (the evaluator then samples finer than the path frames). */
export const hasSweepLaws = (shape: SweepLawShape): boolean =>
  shape.twist !== undefined ||
  shape.scale !== undefined ||
  shape.area !== undefined ||
  shape.stretch !== undefined ||
  shape.stationBlend !== undefined ||
  shape.rails !== undefined;

/** Area of the constant section (outer minus bore). */
export function baseSectionArea(shape: Pick<SweepEntity, 'section'>): number {
  const { section } = shape;
  if (section.shape === 'circle') return Math.PI * (section.radius ** 2 - (section.innerRadius ?? 0) ** 2);
  return polygonArea(section.profile as Vec2[]);
}

/** First problem of the laws of a sweep (non-finite twist, non-positive scale / area / stretch), or null. */
export function sweepLawIssue(shape: SweepLawShape, length: number): (LawIssue & { param: string }) | null {
  const check = (param: string, law: ScalarLaw | undefined, positive: boolean): (LawIssue & { param: string }) | null => {
    const issue = law === undefined ? null : lawIssue(law, { positive, length });
    return issue === null ? null : { ...issue, param };
  };
  return (
    check('twist', shape.twist, false) ??
    check('scale', shape.scale, true) ??
    check('area', shape.area, true) ??
    check('stretch.x', shape.stretch?.x, true) ??
    check('stretch.y', shape.stretch?.y, true)
  );
}

/** Transform at each arc-length fraction; the laws must have passed `sweepLawIssue`. */
export function sectionTransforms(shape: SweepLawShape, fractions: readonly number[], length: number): SectionTransform[] {
  const evaluate = (law: ScalarLaw | undefined, fallback: number): ((t: number) => number) => {
    if (law === undefined) return () => fallback;
    const f = lawFunction(law);
    return (t) => f(t, length);
  };
  const twist = evaluate(shape.twist, 0);
  const scale = evaluate(shape.scale, 1);
  const area = shape.area === undefined ? null : evaluate(shape.area, 1);
  const baseArea = baseSectionArea(shape);
  const stretchX = evaluate(shape.stretch?.x, 1);
  const stretchY = evaluate(shape.stretch?.y, 1);
  return fractions.map((t) => {
    const s = area === null ? scale(t) : Math.sqrt(area(t) / baseArea);
    return { twist: twist(t), sx: s * stretchX(t), sy: s * stretchY(t) };
  });
}

/** Total variation of the twist law in radians (drives the sampling density). */
export function twistVariation(shape: Pick<SweepEntity, 'twist'>, length: number): number {
  if (shape.twist === undefined) return 0;
  const f = lawFunction(shape.twist);
  let total = 0;
  const samples = 512;
  for (let k = 0; k < samples; k++) total += Math.abs(f((k + 1) / samples, length) - f(k / samples, length));
  return total;
}

/** Placement of the section at every frame: the rails' anchor map when the sweep has rails, else its laws. */
export function stationTransforms(
  shape: SweepLawShape,
  fractions: readonly number[],
  length: number,
  frames: readonly SweepFrame[],
): SectionTransform[] | RailIssue {
  return shape.rails === undefined ? sectionTransforms(shape, fractions, length) : railTransforms(shape, frames, fractions);
}
