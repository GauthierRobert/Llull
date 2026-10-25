/** Supports of a grating (06 STA §5.4): steel members under the panel, perpendicular to its bearing bars, and the split into panels. */

import type { CadDocument, Vec2 } from '@core/model/types';
import { fromMm, toMm } from '@core/model/units';
import type { BuildingModel, SteelMemberElement } from '@aec/building/types';
import { findProfile } from '../../../steel/profiles';

/** A member top may be this far below the grating underside, mm. */
const SUPPORT_GAP_MM = 10;
/** ... and this far above it (rounding of the model), mm. */
const SUPPORT_OVERLAP_MM = 1;
/** A support axis may deviate this much from perpendicular to the bars, degrees. */
const PERPENDICULAR_TOLERANCE_DEG = 5;
/** Supports whose axes are this close along the bars are one support line, mm. */
const SAME_LINE_MM = 5;
/** A support must reach this far under the panel width to count, mm. */
const OVERLAP_MM = 1;
/** Beams at the panel ends may be this far from the edge, mm. */
const END_TOLERANCE_MM = 10;
/** Axes within this slope (degrees) of horizontal count as horizontal. */
const HORIZONTAL_DEG = 1;

/** A steel member seen from the bearing-bar direction. All lengths in mm, absolute z. */
export interface SupportLine {
  readonly id: string;
  /** Position of the axis along the bars. */
  readonly sMm: number;
  /** Extent of the axis across the bars. */
  readonly pMin: number;
  readonly pMax: number;
  /** Half width of the top flange along the bars (clear-span deduction). */
  readonly halfWidthMm: number;
  readonly topMm: number;
  /** |cos| of the angle between the axis and the bars: 0 = perpendicular. */
  readonly parallelism: number;
}

/** Unit vector of a plan angle. */
export const barDirection = (angle: number): Vec2 => [Math.cos(angle), Math.sin(angle)];

/** Support line of a member for bars along `direction`, or null when the member is not a horizontal section of the catalogue. */
export function supportLineOf(doc: CadDocument, building: BuildingModel, member: SteelMemberElement, direction: Vec2): SupportLine | null {
  const profile = findProfile(member.profile);
  const level = building.levels[member.levelId];
  if (profile === undefined || level === undefined) return null;
  const [sx, sy, sz] = member.start.map((value) => toMm(doc, value)) as [number, number, number];
  const [ex, ey, ez] = member.end.map((value) => toMm(doc, value)) as [number, number, number];
  const plan = Math.hypot(ex - sx, ey - sy);
  const slopeDeg = (Math.atan2(Math.abs(ez - sz), plan) * 180) / Math.PI;
  if (plan <= 0 || slopeDeg > HORIZONTAL_DEG) return null;
  const axis: Vec2 = [(ex - sx) / plan, (ey - sy) / plan];
  const along = (x: number, y: number): number => x * direction[0] + y * direction[1];
  const cross = (x: number, y: number): number => -x * direction[1] + y * direction[0];
  const [cos, sin] = [Math.abs(Math.cos(member.roll)), Math.abs(Math.sin(member.roll))];
  const [pa, pb] = [cross(sx, sy), cross(ex, ey)];
  return {
    id: member.id,
    sMm: along((sx + ex) / 2, (sy + ey) / 2),
    pMin: Math.min(pa, pb),
    pMax: Math.max(pa, pb),
    halfWidthMm: (profile.b * cos + profile.h * sin) / 2,
    topMm: toMm(doc, level.elevation) + Math.max(sz, ez) + (profile.h * cos + profile.b * sin) / 2,
    parallelism: Math.abs(along(axis[0], axis[1])),
  };
}

export const isPerpendicular = (line: SupportLine): boolean => line.parallelism <= Math.sin((PERPENDICULAR_TOLERANCE_DEG * Math.PI) / 180);

/** The member top is within the allowed band below the grating underside (mm, absolute). */
export const bearsUnder = (line: SupportLine, undersideMm: number): boolean =>
  line.topMm >= undersideMm - SUPPORT_GAP_MM && line.topMm <= undersideMm + SUPPORT_OVERLAP_MM;

type Ring = ReadonlyArray<Vec2>;

/** True for a simple convex polygon: all turns the same way and the turning angles add up to one full revolution (a pentagram turns twice). */
export function isConvex(ring: Ring): boolean {
  let sign = 0;
  let turning = 0;
  for (let index = 0; index < ring.length; index++) {
    const [a, b, c] = [ring[index], ring[(index + 1) % ring.length], ring[(index + 2) % ring.length]] as [Vec2, Vec2, Vec2];
    const [ux, uy, vx, vy] = [b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]];
    const turn = ux * vy - uy * vx;
    if (Math.abs(turn) < 1e-9) continue;
    if (sign !== 0 && Math.sign(turn) !== sign) return false;
    sign = Math.sign(turn);
    turning += Math.atan2(turn, ux * vx + uy * vy);
  }
  return sign !== 0 && Math.abs(Math.abs(turning) - 2 * Math.PI) < 1e-6;
}

/** The part of a convex polygon where `value(point) >= limit` (`keep: 'above'`) or `<= limit` (`'below'`). */
function clip(ring: Ring, value: (point: Vec2) => number, limit: number, keep: 'above' | 'below'): Vec2[] {
  const sign = keep === 'above' ? 1 : -1;
  const inside = (point: Vec2): boolean => sign * (value(point) - limit) >= 0;
  const result: Vec2[] = [];
  ring.forEach((current, index) => {
    const next = ring[(index + 1) % ring.length] as Vec2;
    if (inside(current)) result.push(current);
    if (inside(current) !== inside(next)) {
      const t = (limit - value(current)) / (value(next) - value(current));
      result.push([current[0] + t * (next[0] - current[0]), current[1] + t * (next[1] - current[1])]);
    }
  });
  return result;
}

const ringArea = (ring: Ring): number =>
  Math.abs(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length] as Vec2;
      return sum + (p[0] * q[1] - q[0] * p[1]);
    }, 0) / 2,
  );

/** The members on one support line (collinear within 5 mm along the bars): together they carry the panel edge. */
export interface SupportGroup {
  /** Mean position of the axes along the bars. */
  readonly sMm: number;
  readonly halfWidthMm: number;
  readonly members: readonly SupportLine[];
}

export interface GratingPanel {
  /** Plan polygon, mm. */
  readonly ring: Vec2[];
  readonly supports: readonly [SupportGroup, SupportGroup];
}

export type PanelSplit = { readonly ok: true; readonly panels: GratingPanel[] } | { readonly ok: false; readonly reason: string };

export const groupOf = (members: ReadonlyArray<SupportLine>): SupportGroup => ({
  sMm: members.reduce((sum, line) => sum + line.sMm, 0) / members.length,
  halfWidthMm: Math.max(...members.map((line) => line.halfWidthMm)),
  members,
});

/** First stretch [from, to] of [pMin, pMax] (across the bars, mm) that the members do not cover within 10 mm, or null when they cover it all. */
export function uncoveredStretch(members: ReadonlyArray<SupportLine>, pMin: number, pMax: number): readonly [number, number] | null {
  let reached = pMin;
  for (const line of [...members].sort((x, y) => x.pMin - y.pMin)) {
    if (line.pMin - reached > END_TOLERANCE_MM) return [reached, line.pMin];
    reached = Math.max(reached, line.pMax);
  }
  return pMax - reached > END_TOLERANCE_MM ? [reached, pMax] : null;
}

/** Extent of a ring across the bars, mm. */
export function acrossExtent(ring: Ring, direction: Vec2): readonly [number, number] {
  const values = ring.map((point) => -point[0] * direction[1] + point[1] * direction[0]);
  return [Math.min(...values), Math.max(...values)];
}

/**
 * Splits a convex region (mm) at the support lines that cross it: one panel per pair of consecutive support lines along the bars.
 * Members closer than 5 mm along the bars are one line and carry the edge together: their extents across the bars must cover the panel
 * width (10 mm), else the split fails naming the unsupported stretch. The first and last line must reach the region ends (10 mm).
 */
export function splitPanels(region: Ring, direction: Vec2, candidates: ReadonlyArray<SupportLine>): PanelSplit {
  const along = (point: Vec2): number => point[0] * direction[0] + point[1] * direction[1];
  const [sMin, sMax] = [Math.min(...region.map(along)), Math.max(...region.map(along))];
  const [pMin, pMax] = acrossExtent(region, direction);
  const usable = candidates
    .filter((line) => line.sMm >= sMin - END_TOLERANCE_MM && line.sMm <= sMax + END_TOLERANCE_MM)
    .filter((line) => Math.min(line.pMax, pMax) - Math.max(line.pMin, pMin) > OVERLAP_MM)
    .sort((a, b) => a.sMm - b.sMm || a.id.localeCompare(b.id));
  const clusters: SupportLine[][] = [];
  for (const line of usable) {
    const last = clusters[clusters.length - 1];
    if (last !== undefined && line.sMm - (last[0] as SupportLine).sMm <= SAME_LINE_MM) last.push(line);
    else clusters.push([line]);
  }
  const lines = clusters.map(groupOf);
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined || lines.length < 2)
    return { ok: false, reason: `${lines.length} support line(s) cross the region; a grating needs a support at each end of its bars` };
  if (first.sMm - sMin > END_TOLERANCE_MM)
    return { ok: false, reason: `no support under the start edge (the first support is ${(first.sMm - sMin).toFixed(0)} mm inside it)` };
  if (sMax - last.sMm > END_TOLERANCE_MM)
    return { ok: false, reason: `no support under the end edge (the last support is ${(sMax - last.sMm).toFixed(0)} mm inside it)` };
  const panels: GratingPanel[] = [];
  for (let index = 0; index + 1 < lines.length; index++) {
    const [a, b] = [lines[index], lines[index + 1]] as [SupportGroup, SupportGroup];
    const strip = clip(clip(region, along, Math.max(a.sMm, sMin), 'above'), along, Math.min(b.sMm, sMax), 'below');
    if (strip.length < 3 || ringArea(strip) <= 1) continue;
    const [from, to] = acrossExtent(strip, direction);
    const carriers = [a, b].map((group) =>
      groupOf(group.members.filter((line) => Math.min(line.pMax, to) - Math.max(line.pMin, from) > OVERLAP_MM)),
    );
    for (const group of carriers) {
      const gap = group.members.length === 0 ? ([from, to] as const) : uncoveredStretch(group.members, from, to);
      if (gap !== null)
        return {
          ok: false,
          reason: `the support line at ${(group === carriers[0] ? a : b).sMm.toFixed(0)} mm leaves ${gap[0].toFixed(0)}..${gap[1].toFixed(0)} mm across the bars unsupported (panel ${from.toFixed(0)}..${to.toFixed(0)} mm)`,
        };
    }
    panels.push({
      ring: strip,
      supports: [
        { ...a, members: carriers[0]?.members ?? [] },
        { ...b, members: carriers[1]?.members ?? [] },
      ],
    });
  }
  return panels.length === 0 ? { ok: false, reason: 'the supports leave no panel area' } : { ok: true, panels };
}

/** Plan ring from document units to mm. */
export const ringToMm = (doc: CadDocument, ring: ReadonlyArray<Vec2>): Vec2[] => ring.map(([x, y]): Vec2 => [toMm(doc, x), toMm(doc, y)]);

/** Plan ring from mm to document units. */
export const ringFromMm = (doc: CadDocument, ring: ReadonlyArray<Vec2>): Vec2[] =>
  ring.map(([x, y]): Vec2 => [fromMm(doc, x), fromMm(doc, y)]);

/** The member ids of both sides of a panel, as stored on the element. */
export const supportIdsOf = (supports: readonly [SupportGroup, SupportGroup]): [string[], string[]] => [
  supports[0].members.map((line) => line.id),
  supports[1].members.map((line) => line.id),
];
