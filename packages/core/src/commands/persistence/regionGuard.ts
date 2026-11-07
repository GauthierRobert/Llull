/** Saved-document check of a `region` entity: loops, exact curves that match them, hatch, and (bounded) loop validity. */

import type { CurveSegment } from '../../model/curve';
import type { Vec2 } from '../../model/types';
import { REGION_HATCH_PATTERNS } from '../../model/regionHatch';
import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber, isPositiveNumber } from '../../lib/isFiniteNumber';
import { isVec2 } from '../../lib/vec2';
import { sampleProfile } from '../../geometry/curveSegments';
import { loopBounds, regionLoopsIssue } from '../../geometry/region';
import { MAX_REGION_LOOPS, MAX_REGION_POINTS } from '../limits';
import { curvesProblem } from './curvesGuard';

/** Loops of up to this many points in total also get the touching / crossing check on load (it is quadratic); larger ones are only bounded. */
const LOAD_CONTACT_CHECK_POINTS = 1_000;

/** Slack between a stored loop and the bounds of the tessellation of its exact chain. */
const MATCH_TOLERANCE = 1e-6;

const firstFound = (problems: ReadonlyArray<string | null>): string | null => problems.find((problem) => problem !== null) ?? null;

/** Loop `index` is not the tessellation of chain `index`: their bounding boxes differ. */
function chainMismatch(loop: ReadonlyArray<Vec2>, chain: ReadonlyArray<CurveSegment<Vec2>>, index: number): string | null {
  const [a, b] = [loopBounds(loop), loopBounds(sampleProfile(chain))];
  const scale = Math.max(1, Math.hypot(a.maxX - a.minX, a.maxY - a.minY));
  const same = (x: number, y: number): boolean => Math.abs(x - y) <= MATCH_TOLERANCE * scale;
  return same(a.minX, b.minX) && same(a.minY, b.minY) && same(a.maxX, b.maxX) && same(a.maxY, b.maxY)
    ? null
    : `curves.${index} does not match loops.${index} (the loop is not the tessellation of its exact chain)`;
}

/**
 * First problem of a region: loops (count, points, caps), `curves` (one closed chain per loop, matching it), `hatch`, and for small regions
 * loops that cross, touch or self-intersect. Null when valid.
 */
export function regionProblem(v: Record<string, unknown>): string | null {
  const { loops, curves, hatch } = v;
  if (!Array.isArray(loops) || loops.length < 1 || loops.length > MAX_REGION_LOOPS)
    return `loops must be 1..${MAX_REGION_LOOPS} point lists`;
  if (!loops.every((loop) => Array.isArray(loop) && loop.length >= 3 && loop.every(isVec2)))
    return 'every loop must be >= 3 [x, y] points of finite numbers';
  const total = loops.reduce((sum: number, loop: unknown[]) => sum + loop.length, 0);
  if (total > MAX_REGION_POINTS) return `loops hold more than ${MAX_REGION_POINTS} points in total`;
  if (curves !== undefined && !(Array.isArray(curves) && curves.length === loops.length))
    return 'curves must hold one closed chain per loop';
  const chainProblem = Array.isArray(curves) ? firstFound(curves.map(curvesProblem)) : null;
  if (chainProblem !== null) return chainProblem;
  const mismatch = Array.isArray(curves)
    ? firstFound(curves.map((chain, index) => chainMismatch(loops[index] as Vec2[], chain as CurveSegment<Vec2>[], index)))
    : null;
  if (mismatch !== null) return mismatch;
  if (hatch !== undefined) {
    if (!isRecord(hatch) || !(REGION_HATCH_PATTERNS as readonly unknown[]).includes(hatch['pattern']))
      return `hatch.pattern must be one of ${REGION_HATCH_PATTERNS.join(', ')}`;
    if (!(isFiniteNumber(hatch['angle']) && isPositiveNumber(hatch['spacing']))) return 'hatch.angle must be finite and hatch.spacing > 0';
  }
  if (total > LOAD_CONTACT_CHECK_POINTS) return null;
  const curved = Array.isArray(curves) ? curves.map((chain) => (chain as CurveSegment<Vec2>[]).some((s) => s.type !== 'line')) : [];
  const issue = regionLoopsIssue(loops as Vec2[][], curved);
  return issue === null
    ? null
    : `${issue.code}: loop ${issue.index} is invalid (degenerate, self-touching, or crossing / touching another loop)`;
}
