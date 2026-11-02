/** Plan geometry of the platform generators (06 STA §5.5): secondary beams under a convex deck, annular-sector grating segments and brackets. */

import type { Vec2 } from '@core/model/types';
import { PERPENDICULAR_TOLERANCE_DEG, acrossExtent, clip } from '../grating/gratingSupports';

/** Default skew of a bracket from perpendicular to its panel bars: 1 deg inside the check_grating tolerance, which leaves room for the 10 mm end-cover tolerance of a wedge panel. */
const DEFAULT_SKEW_DEG = PERPENDICULAR_TOLERANCE_DEG - 1;

/** Largest angle of a chord of a discretised arc, degrees (§5.5). */
const ARC_STEP_DEG = 5;
const RAD = Math.PI / 180;

/** Caps on what one command may generate (a tiny spacing is a unit mistake, not a design): secondary beams, brackets, posts of one railing. */
export const MAX_BEAMS = 500;
export const MAX_BRACKETS = 720;
export const MAX_POSTS = 5000;

/** A beam across the bars: plan end points in mm. */
export interface BeamLine {
  readonly start: Vec2;
  readonly end: Vec2;
}

/**
 * Secondary beams of a convex deck (mm): n = ceil(extent / maxSpacing) bays along the bars, a beam at each of the n + 1 stations. A beam
 * reaches across the strips on both sides of it (the hull of their extents), so that every panel is carried over its whole width.
 */
export function framingBeams(region: ReadonlyArray<Vec2>, direction: Vec2, maxSpacingMm: number): BeamLine[] | string {
  const along = (p: Vec2): number => p[0] * direction[0] + p[1] * direction[1];
  const [sMin, sMax] = [Math.min(...region.map(along)), Math.max(...region.map(along))];
  const bays = Math.max(1, Math.ceil((sMax - sMin) / maxSpacingMm - 1e-9));
  if (bays + 1 > MAX_BEAMS) return `maxSpacing gives ${bays + 1} beams (limit ${MAX_BEAMS}): check the unit and the spacing`;
  const stations = Array.from({ length: bays + 1 }, (_, index) => sMin + ((sMax - sMin) * index) / bays);
  const across: Vec2 = [-direction[1], direction[0]];
  return stations.flatMap((s, index): BeamLine[] => {
    const lower = stations[Math.max(0, index - 1)] as number;
    const upper = stations[Math.min(bays, index + 1)] as number;
    const strip = clip(clip(region, along, lower, 'above'), along, upper, 'below');
    if (strip.length < 3) return [];
    const [from, to] = acrossExtent(strip, direction);
    const at = (p: number): Vec2 => [s * direction[0] + p * across[0], s * direction[1] + p * across[1]];
    return [{ start: at(from), end: at(to) }];
  });
}

/** Plan point at angle `angle` (radians) and radius `radius` around `centre`. */
export const polar = (centre: Vec2, radius: number, angle: number): Vec2 => [
  centre[0] + radius * Math.cos(angle),
  centre[1] + radius * Math.sin(angle),
];

export interface SectorLayout {
  /** Bracket angles, radians (a full circle has no closing duplicate). */
  readonly angles: number[];
  readonly segments: number;
  readonly stepRad: number;
  readonly closed: boolean;
}

/**
 * Bracket stations of an annular sector: nb = ceil(sweep x ro / sMax) + 1 (a full circle shares the first and last bracket). Without a given
 * spacing the step is 2 x 4 deg = 8 deg: every bracket stays within 4 deg of perpendicular to the bars of its panels, inside the check_grating criteria.
 */
export function sectorLayout(startRad: number, sweepRad: number, outerRadius: number, spacingMax: number | undefined): SectorLayout {
  const limit = spacingMax ?? outerRadius * 2 * DEFAULT_SKEW_DEG * RAD;
  const segments = Math.max(1, Math.ceil((sweepRad * outerRadius) / limit - 1e-9));
  const stepRad = sweepRad / segments;
  const closed = sweepRad >= 2 * Math.PI - 1e-9;
  return {
    angles: Array.from({ length: closed ? segments : segments + 1 }, (_, index) => startRad + index * stepRad),
    segments,
    stepRad,
    closed,
  };
}

/** Points of an arc from `from` to `to` (radians, either direction), steps of at most 5 deg, both ends included. */
export function arcPoints(centre: Vec2, radius: number, from: number, to: number): Vec2[] {
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / (ARC_STEP_DEG * RAD) - 1e-9));
  return Array.from({ length: steps + 1 }, (_, index) => polar(centre, radius, from + ((to - from) * index) / steps));
}

/** Counter-clockwise outline of the sector between two bracket angles: the outer arc forwards, the inner arc back. */
export const sectorRing = (centre: Vec2, inner: number, outer: number, from: number, to: number): Vec2[] => [
  ...arcPoints(centre, outer, from, to),
  ...arcPoints(centre, inner, to, from),
];

/** Railing vertices along an arc: equal chords of at most `chordMax` (the posts stand at the vertices); `closed` = a full ring. */
export function railArc(centre: Vec2, radius: number, from: number, to: number, chordMax: number, closed: boolean): Vec2[] {
  const chords = Math.max(1, Math.ceil((Math.abs(to - from) * radius) / chordMax - 1e-9));
  const points = Array.from({ length: chords + 1 }, (_, index) => polar(centre, radius, from + ((to - from) * index) / chords));
  // A full ring ends exactly where it starts (no rounding gap), so the railing is one closed loop.
  return closed ? [...points.slice(0, -1), points[0] as Vec2] : points;
}
