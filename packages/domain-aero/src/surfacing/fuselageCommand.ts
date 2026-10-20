/** loft_fuselage: a fuselage outer surface skinned through FS stations of conic / circle / superellipse sections, optionally guided by control curves. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { BodyDef, FuselageSection } from '@core/model/aero';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { placedCurve, tessellateSurface } from '@core/geometry/nurbsSurface';
import { gordonSurface } from '@lib/nurbs/gordon';
import { skinCurves } from '@lib/nurbs/surfaceFit';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { briefNumbers, sig } from '../shared/results';
import { withBody } from './aeroState';
import { refuseAero } from './codes';
import { sectionCurve } from './fuselageSections';

const MAX_STATIONS = 60;

const sectionSchema = z.object({
  type: z
    .enum(['point', 'conic', 'circle', 'superellipse'])
    .describe(
      '"point" = an apex (nose / tail tip, first or last station only); "conic" = four rho-conic arcs; "circle"; "superellipse" (|y/a|^n + |z/b|^n = 1).',
    ),
  wl: z.number().describe('point / circle / superellipse: water line of the point or of the section centre, document units.').optional(),
  bl: z.number().describe('Buttock line of the section centre (default 0 = the centre plane).').optional(),
  radius: z.number().describe('circle: radius > 0.').optional(),
  halfBreadth: z
    .number()
    .describe('conic / superellipse: half of the maximum breadth (distance from the centre to the max-breadth points) > 0.')
    .optional(),
  halfHeight: z.number().describe('superellipse: half height > 0.').optional(),
  exponent: z.number().describe('superellipse: exponent n in (1, 50], 2 = ellipse, larger = boxier.').optional(),
  wlMaxBreadth: z.number().describe('conic: water line of the max-breadth points.').optional(),
  upper: z
    .object({
      wlExtreme: z.number().describe('Water line of the crown (above wlMaxBreadth).'),
      rho: z.number().describe('Liming rho in (0, 1) of the upper arcs; 0.4142 = circular, 0.5 = parabola.'),
    })
    .describe('conic: the upper (crown) arcs.')
    .optional(),
  lower: z
    .object({
      wlExtreme: z.number().describe('Water line of the keel (below wlMaxBreadth).'),
      rho: z.number().describe('Liming rho in (0, 1) of the lower arcs.'),
    })
    .describe('conic: the lower (keel) arcs.')
    .optional(),
});

/** Enclosed volume of a closed surface of revolution-like patch from its tessellation (divergence theorem), or null when it is not closed at both ends. */
function enclosedVolume(surface: NurbsSurfaceData): number {
  const { positions, indices } = tessellateSurface(surface, 12);
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map(
      (i) => [positions[3 * (i as number)], positions[3 * (i as number) + 1], positions[3 * (i as number) + 2]] as [number, number, number],
    ) as [[number, number, number], [number, number, number], [number, number, number]];
    sum += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return Math.abs(sum);
}

/**
 * @affects creates 1 nurbs_surface (the closed outer skin) and doc.aero.bodies[id]
 * @invariant stations are skinned exactly (rational conic sections stay exact); with control curves the skin also contains them
 * @failure fewer than 2 or more than 60 stations -> SRF_LOFT_SECTIONS_TOO_FEW; fs not strictly increasing -> AERO_FS_NOT_INCREASING; a point station inside -> AERO_PARAM_INVALID; rho outside (0, 1) -> SRF_CONIC_RHO_RANGE; a control curve missing a station -> SRF_LOFT_GUIDE_MISSES_SECTION
 */
export const loftFuselage = defineCommand({
  name: 'loft_fuselage',
  description:
    'Loft a fuselage outer skin from a station table in the aircraft frame (FS along +x aft, BL along +y right, WL along +z up, document units). ' +
    '`stations` is a list of { fs, section } with fs strictly increasing; a section is "point" (the nose / tail tip, allowed only first or last), ' +
    '"circle" { radius, wl }, "superellipse" { halfBreadth, halfHeight, exponent, wl } or "conic" { halfBreadth, wlMaxBreadth, upper { wlExtreme, rho }, ' +
    'lower { wlExtreme, rho } } (Liming conic halves: rho 0.4142 is circular, 0.5 parabolic; all sections are exact rational NURBS). The skin is the exact ' +
    'skin through the sections (cubic across stations by default). `controlCurveIds` (nurbs_curve ids such as the crown, keel or max-breadth ' +
    'lines made with interpolate_curve) must cross every station and turn the skin into a Gordon surface that contains them. The result is one ' +
    'closed nurbs_surface sheet (no volume entity: use thicken_surface for a shell); the summary and data report the enclosed volume when both ' +
    'ends are points. Reference: Sears-Haack body L 10, R 0.5 has volume 3 pi^2 R^2 L / 16 = 4.6264. Next: analyze_surface_curvature, check_continuity.',
  params: z.object({
    stations: z
      .array(
        z.object({
          fs: z.number().describe('Fuselage station (x), document units; strictly increasing along the list.'),
          section: sectionSchema.describe('The cross-section at this station.'),
        }),
      )
      .describe('2..60 stations in order of increasing fs.'),
    controlCurveIds: z
      .array(z.string())
      .describe(
        'Optional nurbs_curve ids (crown, keel, max-breadth lines) crossing every station; they must meet each section within `controlTolerance`.',
      )
      .optional(),
    degreeV: z
      .number()
      .describe(
        'Degree of the skin along the fuselage, integer 1..5. Default 3 (capped by stations - 1); 1 gives straight lofting between stations.',
      )
      .optional(),
    controlTolerance: z
      .number()
      .describe('Largest distance (document units) between a control curve and a section. Default 1e-4 x the fuselage length.')
      .optional(),
  }),
  run: (doc, { stations, controlCurveIds = [], degreeV = 3, controlTolerance }, ctx): CommandResult => {
    const refuse = (code: string, message: string, path: string, ids: string[] = []): CommandResult =>
      refuseAero(doc, 'loft_fuselage', code, message, ids, [`params.${path}`]);
    if (stations.length < 2 || stations.length > MAX_STATIONS)
      return refuse('SRF_LOFT_SECTIONS_TOO_FEW', `a fuselage needs 2..${MAX_STATIONS} stations (got ${stations.length})`, 'stations');
    const unordered = stations.findIndex((s, i) => i > 0 && !(s.fs > (stations[i - 1] as { fs: number }).fs));
    if (unordered > 0)
      return refuse(
        'AERO_FS_NOT_INCREASING',
        `station ${unordered} (fs ${stations[unordered]?.fs}) is not beyond station ${unordered - 1}`,
        `stations.${unordered}.fs`,
      );
    const curves: NurbsCurveData[] = [];
    for (const [index, station] of stations.entries()) {
      if (station.section.type === 'point' && index !== 0 && index !== stations.length - 1)
        return refuse('AERO_PARAM_INVALID', 'a point station is only allowed first or last', `stations.${index}.section.type`);
      const made = sectionCurve(station.fs, station.section as FuselageSection);
      if ('code' in made) return refuse(made.code, `station ${index}: ${made.message}`, `stations.${index}.section`);
      curves.push(made.curve);
    }
    const guides: NurbsCurveData[] = [];
    for (const [index, id] of controlCurveIds.entries()) {
      const entity = doc.entities[id];
      if (entity?.kind !== 'nurbs_curve') return refuse('SRF_NOT_NURBS', `"${id}" is not a nurbs_curve`, `controlCurveIds.${index}`, [id]);
      guides.push(placedCurve(entity));
    }
    const length = (stations[stations.length - 1] as { fs: number }).fs - (stations[0] as { fs: number }).fs;
    const skinDegree = Math.min(degreeV, stations.length - 1);
    let surface: NurbsSurfaceData;
    let note = '';
    if (guides.length === 0) {
      const skin = skinCurves(curves, skinDegree);
      if ('code' in skin) return refuse(skin.code, skin.message, 'stations');
      surface = skin;
    } else {
      const gordon = gordonSurface(curves, guides, controlTolerance ?? 1e-4 * length);
      if ('code' in gordon)
        return refuse(
          gordon.code,
          gordon.message,
          'controlCurveIds',
          gordon.guide === undefined ? [] : [controlCurveIds[gordon.guide] as string],
        );
      surface = gordon.surface;
      note = `, control curves within ${sig(gordon.gap)}, section deviation ${sig(gordon.deviation)}`;
    }
    const created = execute(
      doc,
      'create_nurbs_surface',
      {
        degreeU: surface.degreeU,
        degreeV: surface.degreeV,
        poles: surface.poles,
        ...(surface.weights === undefined ? {} : { weights: surface.weights }),
        knotsU: surface.knotsU,
        multiplicitiesU: surface.multiplicitiesU,
        knotsV: surface.knotsV,
        multiplicitiesV: surface.multiplicitiesV,
        name: 'fuselage',
      },
      ctx,
    );
    if (created.affected.length === 0) return created;
    const id = created.affected[0] as string;
    const closed = stations[0]?.section.type === 'point' && stations[stations.length - 1]?.section.type === 'point';
    const volume = closed ? enclosedVolume(surface) : null;
    const body: BodyDef = { id, stations, controlCurveIds, degreeV: skinDegree, entityId: id };
    return {
      ...changed(
        withBody(created.document, body),
        briefNumbers(
          `loft_fuselage: created fuselage "${id}" through ${stations.length} stations (${surface.poles.length} x ${surface.poles[0]?.length ?? 0} poles, length ${sig(length)} ${doc.units}` +
            `${note}${volume === null ? '; open at an end: no enclosed volume' : `, enclosed volume ${sig(volume)} ${doc.units}^3 from the tessellation`}).`,
        ),
        [id],
      ),
      data: { id, stations: stations.length, length: sig(length), closed, volume: volume === null ? null : sig(volume), unit: doc.units },
    };
  },
});
