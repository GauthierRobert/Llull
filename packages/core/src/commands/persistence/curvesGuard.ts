/** Saved-document checks for exact 2D curve chains (`curves` of an extrusion, revolution, sweep section or region loop). */

import type { CurveSegment } from '../../model/curve';
import type { Vec2 } from '../../model/types';
import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { chainIssue } from '../../geometry/curveSegments';

/** Points per curve segment type (`CurveSegment`). */
const SEGMENT_POINT_COUNT: Readonly<Record<string, number>> = { line: 2, arc: 3, bezier: 4, ellipse: 3 };

/** True for a `{ type, points }` segment whose points are finite `dims`-component arrays. */
export function isCurveSegment(s: unknown, dims: number): boolean {
  return (
    isRecord(s) &&
    Array.isArray(s['points']) &&
    s['points'].length === SEGMENT_POINT_COUNT[String(s['type'])] &&
    s['points'].every((p: unknown) => Array.isArray(p) && p.length === dims && p.every(isFiniteNumber))
  );
}

/** Optional exact 2D boundary (`curves`) problem, or null. */
export function curvesProblem(curves: unknown): string | null {
  if (curves === undefined) return null;
  if (!(Array.isArray(curves) && curves.every((s) => isCurveSegment(s, 2))))
    return 'curves must be line/arc/bezier/ellipse segments with [x, y] points';
  const issue = chainIssue(curves as CurveSegment<Vec2>[], true);
  return issue === null ? null : `curves must form one closed loop — ${issue}`;
}
