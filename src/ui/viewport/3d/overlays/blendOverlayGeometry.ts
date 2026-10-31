// Pure data-to-geometry mapping of the blend review overlay: the `blend_overlay` answer (world coordinates) as flat xyz arrays of line-segment pairs.
// Presentation only: every point and every status comes from the command, nothing is measured or derived from the document here.

import type { Vec3 } from '@core/model/types';
import type { BlendOverlayLine, OverlayRole, OverlayStatus } from '@core/commands/brep/blendOverlay';
import { chainsSegments } from './deformOverlayGeometry';

export const OVERLAY_STATUSES: readonly OverlayStatus[] = ['pass', 'warn', 'fail', 'not_run'];
const ROLES: readonly string[] = ['contact', 'junction', 'corner', 'chamfer'];

type BlendLine = Pick<BlendOverlayLine, 'role' | 'edge' | 'profile' | 'status' | 'points'>;

export interface BlendOverlayView {
  readonly status: OverlayStatus;
  readonly lines: readonly BlendLine[];
  readonly counts: Readonly<Record<OverlayStatus, number>>;
  /** The message of the first failing finding. */
  readonly firstFailure: string | null;
  /** Lines of the answer that were damaged (unknown role, a point that is not 3 finite numbers, ...) and left out: counts are of the lines kept. */
  readonly damaged: number;
  /** Blend faces with no contact to draw (the command's blendsWithoutLines). */
  readonly unmeasuredBlends: number;
  /** Why nothing could be read, when that is so. */
  readonly notRunReason: string | null;
}

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
const isStatus = (value: unknown): value is OverlayStatus =>
  typeof value === 'string' && (OVERLAY_STATUSES as readonly string[]).includes(value);

/** The view of a `blend_overlay` answer; null when the data is not that shape (a damaged line is left out). */
export function parseBlendOverlay(data: unknown): BlendOverlayView | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!isStatus(d['status']) || !Array.isArray(d['lines'])) return null;
  const lines = (d['lines'] as unknown[]).flatMap((entry): BlendLine[] => {
    const l = (entry ?? {}) as Record<string, unknown>;
    return typeof l['role'] === 'string' &&
      ROLES.includes(l['role']) &&
      typeof l['edge'] === 'number' &&
      typeof l['profile'] === 'string' &&
      isStatus(l['status']) &&
      Array.isArray(l['points']) &&
      l['points'].every(isVec3)
      ? [{ role: l['role'] as OverlayRole, edge: l['edge'], profile: l['profile'], status: l['status'], points: l['points'] as Vec3[] }]
      : [];
  });
  const counts: Record<OverlayStatus, number> = { pass: 0, warn: 0, fail: 0, not_run: 0 };
  for (const line of lines) counts[line.status] += 1;
  const unmeasured = d['blendsWithoutLines'];
  const failure = (d['firstFailure'] ?? null) as { message?: unknown } | null;
  return {
    status: d['status'],
    lines,
    counts,
    damaged: (d['lines'] as unknown[]).length - lines.length,
    unmeasuredBlends: typeof unmeasured === 'number' && Number.isFinite(unmeasured) && unmeasured > 0 ? Math.floor(unmeasured) : 0,
    firstFailure: typeof failure?.message === 'string' ? failure.message : null,
    notRunReason: typeof d['notRunReason'] === 'string' ? d['notRunReason'] : null,
  };
}

/** The status line of a solid: the counts, then the first failing finding, or why nothing could be read. */
export function statusLine(id: string, view: BlendOverlayView): string {
  const { pass, warn, fail, not_run } = view.counts;
  if (view.lines.length === 0 && view.damaged === 0 && view.unmeasuredBlends === 0)
    return `${id}: ${view.notRunReason ?? 'no blend to review'}`;
  const notes = [
    ...(view.unmeasuredBlends > 0 ? [`${view.unmeasuredBlends} blend face(s) without a contact to draw`] : []),
    ...(view.damaged > 0 ? [`${view.damaged} damaged line(s) left out`] : []),
  ];
  const counted = `${id}: ${pass} pass, ${warn} warn, ${fail} fail, ${not_run} not run${notes.length === 0 ? '' : ` (${notes.join('; ')})`}`;
  return view.firstFailure === null ? counted : `${counted}. First failure: ${view.firstFailure}`;
}

/** The lines of one role and status (a corner: of one profile, when `profile` is given) as line segments. */
export function lineSegments(view: BlendOverlayView, role: OverlayRole, status: OverlayStatus, profile?: string): Float32Array {
  return chainsSegments(
    view.lines
      .filter((line) => line.role === role && line.status === status && (profile === undefined || line.profile === profile))
      .map((line) => line.points),
  );
}

const MARKER_FRACTION = 0.12;
const length = (points: readonly Vec3[]): number =>
  points.reduce((total, point, at) => {
    const previous = points[at - 1];
    return previous === undefined ? total : total + Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]);
  }, 0);

/** A three-axis cross at the middle sample of each junction of this status, its half-size a fraction of the junction's length. */
export function junctionMarkers(view: BlendOverlayView, status: OverlayStatus): Float32Array {
  const crosses: Vec3[][] = [];
  for (const line of view.lines) {
    const middle = line.points[Math.floor(line.points.length / 2)];
    if (line.role !== 'junction' || line.status !== status || middle === undefined) continue;
    const half = Math.max(length(line.points) * MARKER_FRACTION, 1e-6);
    for (const axis of [0, 1, 2]) {
      const low: [number, number, number] = [...middle];
      const high: [number, number, number] = [...middle];
      low[axis] = (low[axis] ?? 0) - half;
      high[axis] = (high[axis] ?? 0) + half;
      crosses.push([low, high]);
    }
  }
  return chainsSegments(crosses);
}
