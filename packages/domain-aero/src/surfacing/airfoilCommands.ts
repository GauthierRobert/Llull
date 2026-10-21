/** airfoil_from_naca, import_airfoil, airfoil_properties: airfoil definitions in `doc.aero` backed by an exact planar nurbs_curve. */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import { nextId } from '@lib/id';
import { sha256Hex } from '@lib/sha256';
import type { AirfoilDef, AirfoilSource } from '@aero/surfacing/types';
import type { CadDocument, Vec2 } from '@core/model/types';
import { briefReport, sig } from '../shared/results';
import { nacaOrdinates, parseNaca } from '../aerodynamics/naca';
import { aeroOf, withAirfoil } from './aeroState';
import { refuseAero } from './codes';
import { crossingIndex, normalizeToChord, parseAirfoilText, trailingEdgeGap, withoutDuplicates } from './airfoilFormats';
import { airfoilMetrics } from './airfoilMetrics';

const MAX_IMPORT_POINTS = 2_000;
const RAD = Math.PI / 180;

/** Scales the chord-normalised ordinates to `chord` and rotates them nose-up by `incidenceDeg` about the leading edge. */
function placeSection(ordinates: readonly Vec2[], chord: number, incidenceDeg: number): Vec2[] {
  if (chord === 1 && incidenceDeg === 0) return [...ordinates];
  const [cos, sin] = [Math.cos(incidenceDeg * RAD), Math.sin(incidenceDeg * RAD)];
  return ordinates.map(([x, y]) => [(x * cos + y * sin) * chord, (-x * sin + y * cos) * chord]);
}

/** Creates the planar curve through `points` (z = 0) with the core `interpolate_curve` and registers the airfoil definition. */
function registerAirfoil(
  doc: CadDocument,
  command: string,
  source: AirfoilSource,
  normalize: 'none' | 'chord',
  provenance: AirfoilDef['provenance'],
  points: ReadonlyArray<Vec2>,
  position: readonly [number, number, number] | undefined,
  ctx: Parameters<typeof execute>[3],
): CommandResult {
  const curve = execute(
    doc,
    'interpolate_curve',
    {
      points: withoutDuplicates(points).map(([x, y]) => [x, y, 0]),
      degree: 3,
      parameterization: 'centripetal',
      ...(position === undefined ? {} : { position }),
    },
    ctx,
  );
  if (curve.affected.length === 0) return curve;
  const id = nextId('airfoil');
  const entityId = curve.affected[0] as string;
  const def: AirfoilDef = { id, source, normalize, entityId, provenance };
  return changed(
    withAirfoil(curve.document, def),
    `${command}: created airfoil "${id}" (curve ${entityId}, ${points.length} points, ${provenance.verified ? 'verified' : 'UNVERIFIED'} input).`,
    [id, entityId],
  );
}

/**
 * @affects as "nurbs": creates doc.aero.airfoils[id] and 1 planar nurbs_curve; as "polyline": creates 1 closed polyline (no airfoil id)
 * @invariant the section passes through every generated ordinate (NACA Report 824, cosine spacing by default); closed trailing edge uses a4 = 0.1036; chord 1 and incidence 0 by default
 * @failure unknown designation -> AERO_NACA_DESIGNATION_UNKNOWN; points not odd in 21..801 or chord <= 0 -> AERO_PARAM_INVALID
 */
export const airfoilFromNaca = defineCommand({
  name: 'airfoil_from_naca',
  description:
    'Create a NACA airfoil section as an exact cubic NURBS curve through the section ordinates (NACA Report 824 equations): 4-digit ("0012", ' +
    '"2412") or 230-series 5-digit ("23012"; other 5-digit mean lines are not supported). The section is chord-normalised: chord 1, leading ' +
    'edge at the origin, chord along +x, thickness along +y, drawn from the upper trailing edge round the leading edge to the lower one. ' +
    '`trailingEdge` "open" (default, the original definition, blunt 0.00252 chord for t = 12 %) or "closed" (sharp, a4 = 0.1036). `points` ' +
    'is the total ordinate count, odd, 21..801 (default 161 = 81 cosine stations per surface); `spacing` "cosine" (default) or "uniform". ' +
    'Returns the airfoil id (use it in create_wing / airfoil_properties) and the curve id. Place several airfoils with `position`. `chord` (default 1) scales the section to document units and `incidenceDeg` (default 0) rotates it ' +
    'nose-up about the leading edge. `as` "nurbs" (default) makes the exact curve plus the airfoil id; `as` "polyline" instead draws one plain closed ' +
    '2D polyline (no airfoil id; affected[0] is the polyline) for analyze_airfoil { entityId }, extrude_profile or loft_sections.',
  params: z.object({
    designation: z
      .string()
      .describe('NACA designation: 4 digits ("0012", "2412") or the 230-series 5-digit "23012"; an optional "NACA " prefix is accepted.'),
    trailingEdge: z
      .enum(['open', 'closed'])
      .describe('"open" (default): blunt trailing edge as originally defined; "closed": sharp trailing edge.')
      .optional(),
    points: z.number().describe('Total number of ordinates, an odd integer 21..801. Default 161.').optional(),
    spacing: z
      .enum(['cosine', 'uniform'])
      .describe('Chordwise station spacing: "cosine" (default, dense at the nose) or "uniform".')
      .optional(),
    chord: z.number().describe('Chord length in document units, > 0. Default 1 (chord-normalised).').optional(),
    incidenceDeg: z.number().describe('Nose-up rotation about the leading edge in degrees. Default 0.').optional(),
    as: z
      .enum(['nurbs', 'polyline'])
      .describe('"nurbs" (default): exact NURBS curve + airfoil id; "polyline": one closed 2D polyline, no airfoil id.')
      .optional(),
    position: vec3(
      'Where to place the curve [x, y, z] in document units (the section stays in the local XY plane). Default [0, 0, 0].',
    ).optional(),
  }),
  run: (
    doc,
    { designation, trailingEdge = 'open', points = 161, spacing = 'cosine', chord = 1, incidenceDeg = 0, as = 'nurbs', position },
    ctx,
  ): CommandResult => {
    if (!(chord > 0) || !Number.isFinite(incidenceDeg))
      return refuseAero(doc, 'airfoil_from_naca', 'AERO_PARAM_INVALID', 'chord must be > 0 and incidenceDeg finite', [], ['params.chord']);
    if (!Number.isInteger(points) || points < 21 || points > 801 || points % 2 === 0)
      return refuseAero(
        doc,
        'airfoil_from_naca',
        'AERO_PARAM_INVALID',
        `points must be an odd integer in 21..801 (got ${points})`,
        [],
        ['params.points'],
      );
    const section = parseNaca(designation);
    if (typeof section === 'string')
      return refuseAero(doc, 'airfoil_from_naca', 'AERO_NACA_DESIGNATION_UNKNOWN', section, [], ['params.designation']);
    const pointsPerSide = (points - 1) / 2;
    const closedTrailingEdge = trailingEdge === 'closed';
    const ordinates = placeSection(nacaOrdinates(section, pointsPerSide, closedTrailingEdge, spacing), chord, incidenceDeg);
    if (as === 'polyline') {
      const unique = closedTrailingEdge ? ordinates.slice(0, -1) : ordinates;
      const drawn = execute(doc, 'draw_polyline', { points: unique, closed: true, ...(position ? { position } : {}) }, ctx);
      if (drawn.affected.length === 0) return drawn;
      return changed(
        drawn.document,
        `airfoil_from_naca: drew ${section.designation} (t/c ${section.maxThickness}, chord ${chord}, ${unique.length} points${incidenceDeg !== 0 ? `, incidence ${incidenceDeg}°` : ''}) as polyline ${drawn.affected[0]}.`,
        drawn.affected,
      );
    }
    return registerAirfoil(
      doc,
      'airfoil_from_naca',
      {
        type: designation.replace(/^\s*naca\s*/i, '').trim().length === 5 ? 'naca5' : 'naca4',
        designation: section.designation,
        closedTrailingEdge,
        pointsPerSide,
      },
      'none',
      { verified: true, source: 'NACA Report 824 equations (Abbott, von Doenhoff, Stivers 1945)' },
      ordinates,
      position,
      ctx,
    );
  },
});

/**
 * @affects creates doc.aero.airfoils[id] (raw points + sha256 stored) and 1 planar nurbs_curve
 * @invariant raw coordinates are kept verbatim; normalize "chord" only moves the curve (leading edge to the origin, trailing-edge midpoint to x = 1)
 * @failure bad text -> AERO_AIRFOIL_PARSE; crossing surfaces -> AERO_AIRFOIL_SELF_INTERSECT; trailingEdge "closed" with a gap -> AERO_AIRFOIL_TE_GAP; hash mismatch -> AERO_AIRFOIL_HASH_MISMATCH
 */
export const importAirfoil = defineCommand({
  name: 'import_airfoil',
  description:
    'Import an airfoil from the TEXT of a UIUC-style coordinate file (the CLI reads the file: pass its content as `text`): Selig (upper trailing ' +
    'edge -> leading edge -> lower trailing edge) or Lednicer (counts line, upper LE -> TE, lower LE -> TE); `format` "auto" detects it. The raw ' +
    'points are stored with their sha256 and a cubic NURBS curve is fitted through every point. `normalize` "chord" moves/rotates/scales the ' +
    'section so the leading edge (farthest point from the trailing edge) is at the origin and the trailing edge on +x at 1; "none" (default) ' +
    'keeps the file as is (some files, e.g. naca23012.dat, match their equations only when NOT normalised). `trailingEdge` "keep" (default) or ' +
    '"closed" (refuses a gap above 1e-4 chord). Imported airfoils are UNVERIFIED unless `expectedSha256` of the pinned file matches the text. ' +
    'At most 2000 points.',
  params: z.object({
    text: z
      .string()
      .describe('Content of the airfoil file (name line, then "x y" pairs; Lednicer files have a counts line "n_upper n_lower").'),
    format: z
      .enum(['auto', 'selig', 'lednicer'])
      .describe('File layout. Default "auto" (Lednicer when the first data line holds two counts > 1).')
      .optional(),
    normalize: z
      .enum(['none', 'chord'])
      .describe('"chord": place LE at the origin and TE midpoint at (1, 0); "none" (default): keep the coordinates.')
      .optional(),
    trailingEdge: z.enum(['keep', 'closed']).describe('"closed" requires the trailing-edge gap <= 1e-4 chord; default "keep".').optional(),
    expectedSha256: z
      .string()
      .describe('sha256 (hex) of the pinned source file; when it equals the hash of `text` the airfoil is marked verified.')
      .optional(),
    source: z.string().describe('Where the file comes from (URL, database name); stored as provenance.').optional(),
    position: vec3('Where to place the curve [x, y, z] in document units. Default [0, 0, 0].').optional(),
  }),
  run: (
    doc,
    { text, format = 'auto', normalize = 'none', trailingEdge = 'keep', expectedSha256, source, position },
    ctx,
  ): CommandResult => {
    const refuse = (code: string, message: string, path: string): CommandResult =>
      refuseAero(doc, 'import_airfoil', code, message, [], [path]);
    const parsed = parseAirfoilText(text, format);
    if (typeof parsed === 'string') return refuse('AERO_AIRFOIL_PARSE', parsed, 'params.text');
    if (parsed.points.length > MAX_IMPORT_POINTS)
      return refuse('AERO_AIRFOIL_PARSE', `at most ${MAX_IMPORT_POINTS} points (got ${parsed.points.length})`, 'params.text');
    const hash = sha256Hex(text);
    if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== hash)
      return refuse('AERO_AIRFOIL_HASH_MISMATCH', `sha256 of the text is ${hash}, not ${expectedSha256}`, 'params.expectedSha256');
    const normalised = normalize === 'chord' ? normalizeToChord(parsed.points) : [...parsed.points];
    const shaped = trailingEdge === 'closed' ? [...normalised.slice(0, -1), normalised[0] as Vec2] : normalised;
    const crossing = crossingIndex(normalizeToChord(shaped));
    if (crossing >= 0)
      return refuse('AERO_AIRFOIL_SELF_INTERSECT', `the lower surface crosses the upper surface at point ${crossing}`, `params.text`);
    const gap = trailingEdgeGap(normalizeToChord(parsed.points));
    if (trailingEdge === 'closed' && gap > 1e-4)
      return refuse('AERO_AIRFOIL_TE_GAP', `trailing-edge gap ${sig(gap)} chord exceeds 1e-4`, 'params.trailingEdge');
    const verified = expectedSha256 !== undefined;
    const created = registerAirfoil(
      doc,
      'import_airfoil',
      { type: 'points', format: parsed.format, name: parsed.name, sha256: hash, points: parsed.points },
      normalize,
      {
        verified,
        source: verified ? `${source ?? parsed.name}, pinned sha256 ${hash}` : `unpinned import of "${parsed.name}" (sha256 ${hash})`,
      },
      shaped,
      position,
      ctx,
    );
    return trailingEdge === 'closed' && gap > 0 && created.affected.length > 0
      ? { ...created, summary: `${created.summary} Closed trailing edge: the last point moved ${sig(gap)} chord onto the first.` }
      : created;
  },
});

/**
 * @affects none; data = { airfoilId, tMax, xTMax, camberMax, xCamberMax, leRadius, teThickness, teAngleDeg, area, centroid, chordUnits, pointCount, source, unverified, provenance, unit }
 * @failure unknown airfoil -> AERO_AIRFOIL_NOT_FOUND; a curve that is not a TE -> LE -> TE section -> AERO_PARAM_INVALID
 */
export const airfoilProperties = defineCommand({
  name: 'airfoil_properties',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only section metrics of an airfoil made with airfoil_from_naca / import_airfoil, computed from its exact curve and chord-normalised ' +
    '(unit "chord", areas in chord^2): maximum thickness tMax at xTMax, maximum camber (signed) at xCamberMax, leading-edge radius from the ' +
    'curve curvature, trailing-edge thickness and wedge angle in degrees, section area and centroid. `unverified` is true when the input has ' +
    'no pinned source. NACA 0012 reference: tMax 0.12 at 0.30, LE radius 0.0159, area 0.0822.',
  params: z.object({ airfoilId: z.string().describe('Airfoil id (affected[0] of airfoil_from_naca / import_airfoil).') }),
  run: (doc, { airfoilId }): CommandResult => {
    const def = aeroOf(doc).airfoils[airfoilId];
    if (def === undefined)
      return refuseAero(
        doc,
        'airfoil_properties',
        'AERO_AIRFOIL_NOT_FOUND',
        `no airfoil "${airfoilId}"`,
        [airfoilId],
        ['params.airfoilId'],
      );
    const entity = doc.entities[def.entityId];
    if (entity?.kind !== 'nurbs_curve')
      return refuseAero(
        doc,
        'airfoil_properties',
        'AERO_AIRFOIL_NOT_FOUND',
        `the curve ${def.entityId} of "${airfoilId}" was deleted`,
        [airfoilId],
        ['params.airfoilId'],
      );
    const metrics = airfoilMetrics(entity.curve);
    if (typeof metrics === 'string')
      return refuseAero(doc, 'airfoil_properties', 'AERO_PARAM_INVALID', metrics, [airfoilId], ['params.airfoilId']);
    const data = {
      airfoilId,
      tMax: sig(metrics.tMax),
      xTMax: sig(metrics.xTMax),
      camberMax: sig(metrics.camberMax),
      xCamberMax: sig(metrics.xCamberMax),
      leRadius: sig(metrics.leRadius),
      teThickness: sig(metrics.teThickness),
      teAngleDeg: sig(metrics.teAngleDeg),
      area: sig(metrics.area),
      centroid: [sig(metrics.centroid[0]), sig(metrics.centroid[1])],
      chordInDocumentUnits: sig(metrics.chord),
      pointCount: def.source.type === 'points' ? def.source.points.length : def.source.pointsPerSide * 2 + 1,
      source: def.source.type === 'points' ? `${def.source.name} (${def.source.format})` : def.source.designation,
      unit: 'chord',
      areaUnit: 'chord^2',
      angleUnit: 'deg',
      unverified: !def.provenance.verified,
      provenance: {
        method: 'metrics integrated from the exact NURBS section (Green theorem, bisection on x(u))',
        reference: def.provenance.source,
        inputs: { airfoilId },
      },
    };
    return briefReport(
      doc,
      `airfoil_properties ${airfoilId} (${data.source}): t/c ${data.tMax} at x/c ${data.xTMax}, camber ${data.camberMax} at ${data.xCamberMax}, ` +
        `LE radius ${data.leRadius}, TE thickness ${data.teThickness}, area ${data.area} chord^2${data.unverified ? ' (UNVERIFIED input)' : ''}.`,
      data,
    );
  },
});
