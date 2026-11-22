/** Site context of a document (plant 09 VIS FR-VIS-18): where and when the model stands, and the sun that follows from it; `CadDocument.siteContext`. */

import { parseIsoWithOffset, solarPosition, sunDirection } from '../lib/solarPosition';
import type { Vec3 } from './vectors';

export interface SiteContext {
  /** Degrees, north positive, [-90, 90]. */
  readonly latitudeDeg: number;
  /** Degrees, east positive, [-180, 180]. */
  readonly longitudeDeg: number;
  /** ISO-8601 local date-time with an explicit UTC offset, e.g. `2026-06-21T14:30:00+02:00`. */
  readonly dateTime: string;
  /** Degrees counter-clockwise (seen from +Z) from the model's +Y axis to true north. */
  readonly northAngleDeg: number;
  /** Ground level, in document units; absent = the model's Z = 0 (the ground plane the renderers already draw). */
  readonly groundElevation?: number;
}

/** `CadDocument` slice: the site context (absent until `set_site_context`; drives the sun of the renderers, plant 09 VIS-M8). */
export interface SiteContextFields {
  siteContext?: SiteContext;
}

export interface SunState {
  /** Compass azimuth, degrees clockwise from true north. */
  readonly azimuthDeg: number;
  /** Elevation with refraction, degrees. */
  readonly elevationDeg: number;
  /** Elevation without refraction, degrees. */
  readonly geometricElevationDeg: number;
  /** True when the sun is above the horizon (elevationDeg > 0). */
  readonly up: boolean;
  /** Unit vector toward the sun in model axes (north angle applied). */
  readonly direction: Vec3;
}

/** Why `site` is not a valid site context, or null. */
export function siteContextProblem(site: unknown): string | null {
  if (typeof site !== 'object' || site === null || Array.isArray(site)) return 'siteContext must be an object';
  const s = site as Record<string, unknown>;
  const finite = (key: string): boolean => typeof s[key] === 'number' && Number.isFinite(s[key]);
  const num = (key: string): number => s[key] as number;
  if (!finite('latitudeDeg') || Math.abs(num('latitudeDeg')) > 90) return 'siteContext.latitudeDeg must be a finite number in [-90, 90]';
  if (!finite('longitudeDeg') || Math.abs(num('longitudeDeg')) > 180)
    return 'siteContext.longitudeDeg must be a finite number in [-180, 180]';
  if (!finite('northAngleDeg') || Math.abs(num('northAngleDeg')) > 360)
    return 'siteContext.northAngleDeg must be a finite number in [-360, 360]';
  if (typeof s['dateTime'] !== 'string' || parseIsoWithOffset(s['dateTime']) === null)
    return 'siteContext.dateTime must be an ISO-8601 date-time with an explicit UTC offset (e.g. 2026-06-21T14:30:00+02:00 or ...Z), years 1800-2200';
  if (s['groundElevation'] !== undefined && !finite('groundElevation')) return 'siteContext.groundElevation must be a finite number';
  return null;
}

/** The sun of `site` at its own date-time or at `dateTime` (ISO-8601 with offset); null when the date-time is invalid. */
export function sunAt(site: SiteContext, dateTime: string = site.dateTime): SunState | null {
  const when = parseIsoWithOffset(dateTime);
  if (when === null) return null;
  const position = solarPosition(site.latitudeDeg, site.longitudeDeg, when);
  return {
    azimuthDeg: position.azimuthDeg,
    elevationDeg: position.elevationDeg,
    geometricElevationDeg: position.geometricElevationDeg,
    up: position.elevationDeg > 0,
    direction: sunDirection(position.azimuthDeg, position.elevationDeg, site.northAngleDeg),
  };
}
