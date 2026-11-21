/**
 * @affects document-level `siteContext` only (set / clear); `sun_position` reads it; affected:[]
 * @invariant latitude in [-90, 90], longitude in [-180, 180], dateTime ISO-8601 WITH an explicit UTC offset (never the host clock), north angle finite
 * @invariant the sun is a pure function of the stored site (NOAA solar position equations, @lib/solarPosition)
 * @failure invalid or offset-less dateTime / out-of-range angles -> no-op, affected:[]; sun_position with no site and no lat/lon -> no-op
 */

import { type SiteContext, siteContextProblem, sunAt } from '../../model/siteContext';
import { parseIsoWithOffset } from '../../lib/solarPosition';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { noop, report } from '../noop';

const dateTimeField = z
  .string()
  .describe(
    'ISO-8601 local date-time WITH an explicit UTC offset, e.g. "2026-06-21T14:30:00+02:00" or "2026-06-21T12:30:00Z". Years 1800-2200. Never read from the host clock.',
  );

export const setSiteContext = defineCommand({
  name: 'set_site_context',
  annotations: { idempotent: true },
  description:
    'Set where and when the model stands: latitude, longitude, a date-time with UTC offset and the plan rotation of true north. ' +
    'Renders (render_view raster, native raster) and the desktop viewport then light the scene with the computed sun (NOAA solar position, ~0.05 degree) ' +
    'instead of the default light; a sun below the horizon leaves sky light only. Replaces any previous site context. ' +
    'Undo-able; `clear_site_context` removes it; `sun_position` reads the resulting azimuth / elevation.',
  params: z.object({
    latitudeDeg: z.number().min(-90).max(90).describe('Latitude in degrees, north positive, in [-90, 90].'),
    longitudeDeg: z.number().min(-180).max(180).describe('Longitude in degrees, east positive, in [-180, 180].'),
    dateTime: dateTimeField,
    northAngleDeg: z
      .number()
      .optional()
      .describe(
        'Plan rotation of true north in degrees, counter-clockwise seen from +Z, measured from the model +Y axis (0 = +Y is north, 90 = true north points along -X). Default 0.',
      ),
    groundElevation: z.number().optional().describe('Ground level in document units (default: the model Z = 0 plane).'),
  }),
  run: (doc, params): CommandResult => {
    const site: SiteContext = {
      latitudeDeg: params.latitudeDeg,
      longitudeDeg: params.longitudeDeg,
      dateTime: params.dateTime,
      northAngleDeg: params.northAngleDeg ?? 0,
      ...(params.groundElevation === undefined ? {} : { groundElevation: params.groundElevation }),
    };
    const problem = siteContextProblem(site);
    if (problem !== null) return noop(doc, `set_site_context rejected: ${problem}.`);
    const sun = sunAt(site);
    if (sun === null) return noop(doc, 'set_site_context rejected: dateTime could not be read.');
    return report(
      { ...doc, siteContext: site },
      `Site context set: lat ${site.latitudeDeg}, lon ${site.longitudeDeg}, ${site.dateTime}, north angle ${site.northAngleDeg} deg. ` +
        `Sun azimuth ${sun.azimuthDeg.toFixed(2)} deg, elevation ${sun.elevationDeg.toFixed(2)} deg${sun.up ? '' : ' (below the horizon: sky light only)'}.`,
    );
  },
});

export const clearSiteContext = defineCommand({
  name: 'clear_site_context',
  annotations: { idempotent: true },
  description:
    'Remove the site context (latitude / longitude / date-time / north angle). Renders and the viewport return to the default light. No-op when none is set.',
  params: z.object({}),
  run: (doc): CommandResult => {
    if (doc.siteContext === undefined) return noop(doc, 'No site context to clear.');
    const { siteContext: _removed, ...rest } = doc;
    return report(rest as CadDocument, 'Site context cleared: renders use the default light.');
  },
});

export const sunPosition = defineCommand({
  name: 'sun_position',
  annotations: { readOnly: true },
  description:
    'Sun azimuth and elevation (NOAA solar position equations; about 0.05 degree for years 1900-2100) for the stored site context at its date-time or at a given `dateTime`. ' +
    'Returns data { azimuthDeg (clockwise from true north), elevationDeg (with refraction), geometricElevationDeg, up, planAzimuthDeg (clockwise from the model +Y axis, north angle applied), direction (unit vector toward the sun in model axes), dateTime }. ' +
    'Without a stored site, pass latitudeDeg and longitudeDeg (and dateTime). Does not change the document.',
  params: z.object({
    dateTime: dateTimeField.optional(),
    latitudeDeg: z.number().min(-90).max(90).optional().describe('Latitude override in degrees; required when no site context is stored.'),
    longitudeDeg: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Longitude override in degrees; required when no site context is stored.'),
    northAngleDeg: z
      .number()
      .optional()
      .describe('North angle override in degrees (see set_site_context); default the stored one, else 0.'),
  }),
  run: (doc, params): CommandResult => {
    const stored = doc.siteContext;
    const latitudeDeg = params.latitudeDeg ?? stored?.latitudeDeg;
    const longitudeDeg = params.longitudeDeg ?? stored?.longitudeDeg;
    const dateTime = params.dateTime ?? stored?.dateTime;
    if (latitudeDeg === undefined || longitudeDeg === undefined || dateTime === undefined)
      return noop(
        doc,
        'sun_position: no site context stored and latitudeDeg / longitudeDeg / dateTime not all given; call set_site_context first.',
      );
    if (parseIsoWithOffset(dateTime) === null)
      return noop(
        doc,
        `sun_position: dateTime "${dateTime}" is not an ISO-8601 date-time with an explicit UTC offset (e.g. 2026-06-21T14:30:00+02:00).`,
      );
    const northAngleDeg = params.northAngleDeg ?? stored?.northAngleDeg ?? 0;
    const sun = sunAt({ latitudeDeg, longitudeDeg, dateTime, northAngleDeg });
    if (sun === null) return noop(doc, 'sun_position: dateTime could not be read.');
    const planAzimuthDeg = (((sun.azimuthDeg - northAngleDeg) % 360) + 360) % 360;
    return {
      document: doc,
      affected: [],
      summary:
        `Sun at ${dateTime} (lat ${latitudeDeg}, lon ${longitudeDeg}): azimuth ${sun.azimuthDeg.toFixed(2)} deg, elevation ${sun.elevationDeg.toFixed(2)} deg` +
        `${sun.up ? '' : ' (below the horizon)'}; plan azimuth ${planAzimuthDeg.toFixed(2)} deg from +Y with north angle ${northAngleDeg}.`,
      data: {
        dateTime,
        azimuthDeg: sun.azimuthDeg,
        elevationDeg: sun.elevationDeg,
        geometricElevationDeg: sun.geometricElevationDeg,
        up: sun.up,
        planAzimuthDeg,
        direction: [...sun.direction],
      },
    };
  },
});
