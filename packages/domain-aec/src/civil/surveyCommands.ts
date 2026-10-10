/**
 * Survey and terrain commands: import survey points, build / edit existing-ground TIN surfaces.
 * @layer domain-aec/civil
 */

import type { Vec2, Vec3 } from '@core/model/types';
import { DOCUMENT_UNITS } from '@core/model/types';
import type { PointGroupObject, SurfaceObject, SurveyPoint } from '@core/model/civil';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2, vec3 } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { isValidPolygon } from '@lib/polygon';
import {
  civilAffected,
  civilObject,
  civilObjectsOf,
  fromMetres,
  fromUnit,
  getCivil,
  nextCivilId,
  toMetresText,
  withObject,
  MAX_SURFACE_POINTS,
} from './model';
import { commitCivil, regenerateCivil } from './evaluate';
import { gridToLocal } from './crs';
import { parseSurvey, SURVEY_FORMATS } from './surveyParse';
import { surfacePoints, surfaceTin } from './surfaceTin';
import { triangleCount } from './tin';
import { MAX_DRAWN_POINTS } from './surfaceEvaluate';

const MAX_POINTS = 50000;

const pointInput = z.object({
  number: z.string().optional().describe('Point number / name. Default: running index.'),
  x: z.number().describe('Easting.'),
  y: z.number().describe('Northing.'),
  z: z.number().describe('Elevation.'),
  code: z.string().optional().describe('Field code, e.g. "TOPO", "EP", "TREE".'),
});

/**
 * @command import_survey_points
 * @pure
 * @affects creates 1 point group (+ a marker per point when <= 2000 points)
 * @failure no valid point / too many points -> no-op
 */
export const importSurveyPoints = defineCommand({
  name: 'import_survey_points',
  description:
    'Import survey points (topographic survey, total station / GNSS export) as a named point group. ' +
    'Give `text` (CSV / TXT file content, one point per line; header and # comment lines skipped) in ' +
    '`format` PENZD (default: number, easting, northing, elevation, description), PNEZD, PENZ, PNEZ, ' +
    'ENZ or NEZ, and/or `points` [{ x, y, z }]. Coordinates are in `sourceUnit` (default m) and are ' +
    'converted to the document unit. Then build a terrain with create_surface.',
  params: z.object({
    name: z.string().optional().describe('Point group name. Default "Survey <n>".'),
    text: z.string().optional().describe('Survey file content (comma, tab, ; or space separated).'),
    format: z.enum(SURVEY_FORMATS).optional().describe('Column order of `text`. Default PENZD.'),
    points: z.array(pointInput).optional().describe('Points given directly.'),
    sourceUnit: z
      .enum(DOCUMENT_UNITS)
      .optional()
      .describe('Unit of the coordinates in `text` / `points`. Default m.'),
    coordinates: z
      .enum(['local', 'grid'])
      .optional()
      .describe(
        'Coordinate frame of the input. "grid" (projected CRS) is converted to local with the ' +
          'site calibration (set_site_calibration) and is refused without one. Default "local".',
      ),
  }),
  run: (
    doc,
    { name, text, format = 'PENZD', points = [], sourceUnit = 'm', coordinates = 'local' },
  ): CommandResult => {
    const calibration = getCivil(doc).crs?.calibration;
    if (coordinates === 'grid' && !calibration) {
      return noop(
        doc,
        'import_survey_points failed: coordinates "grid" needs a site calibration (set_site_calibration).',
      );
    }
    const parsed =
      text !== undefined ? parseSurvey(text, format) : { points: [], rejectedLines: [] };
    const convert = (value: number): number => fromUnit(doc, value, sourceUnit);
    const gathered: SurveyPoint[] = [
      ...parsed.points.map((point) => ({
        number: point.number,
        position: [
          convert(point.easting),
          convert(point.northing),
          convert(point.elevation),
        ] as Vec3,
        ...(point.code !== undefined ? { code: point.code } : {}),
      })),
      ...points.map((point, index) => ({
        number: point.number ?? String(parsed.points.length + index + 1),
        position: [convert(point.x), convert(point.y), convert(point.z)] as Vec3,
        ...(point.code !== undefined ? { code: point.code } : {}),
      })),
    ];
    const surveyPoints =
      coordinates === 'grid' && calibration
        ? gathered.map((point) => {
            const [x, y] = gridToLocal(calibration, [point.position[0], point.position[1]]);
            return { ...point, position: [x, y, point.position[2]] as Vec3 };
          })
        : gathered;
    if (surveyPoints.length === 0) {
      return noop(
        doc,
        `import_survey_points failed: no valid point found (format ${format}` +
          (parsed.rejectedLines.length > 0
            ? `; unreadable lines ${parsed.rejectedLines.slice(0, 10).join(', ')})`
            : ')'),
      );
    }
    if (surveyPoints.length > MAX_POINTS) {
      return noop(
        doc,
        `import_survey_points failed: ${surveyPoints.length} points exceed the ${MAX_POINTS}-point limit; split the file.`,
      );
    }
    const civil = getCivil(doc);
    const id = nextCivilId(civil, 'pointGroup');
    const group: PointGroupObject = {
      id,
      category: 'pointGroup',
      name: name?.trim() || `Survey ${civilObjectsOf(civil, 'pointGroup').length + 1}`,
      entityIds: [],
      points: surveyPoints,
    };
    const skipped =
      parsed.rejectedLines.length > 0
        ? ` Skipped ${parsed.rejectedLines.length} unreadable line(s): ${parsed.rejectedLines.slice(0, 10).join(', ')}.`
        : '';
    const drawn =
      surveyPoints.length > MAX_DRAWN_POINTS
        ? ` Markers not drawn above ${MAX_DRAWN_POINTS} points (the data is kept).`
        : '';
    return commitCivil(
      doc,
      withObject(civil, group),
      [id],
      `Imported ${surveyPoints.length} survey points as ${group.name} (${id}).${skipped}${drawn}`,
      { pointGroupId: id, count: surveyPoints.length, rejectedLines: parsed.rejectedLines },
    );
  },
});

function surfaceSummary(doc: Parameters<typeof getCivil>[0], surface: SurfaceObject): string {
  const tin = surfaceTin(getCivil(doc), surface);
  return `${tin.points.length} points, ${triangleCount(tin)} triangles`;
}

/**
 * @command create_surface
 * @pure
 * @affects creates 1 surface: TIN mesh, minor / major contours, major contour labels
 * @failure unknown point group / fewer than 3 points / invalid boundary -> no-op
 */
export const createSurface = defineCommand({
  name: 'create_surface',
  description:
    'Build an existing-ground terrain surface (Delaunay TIN) from survey point groups and/or extra ' +
    '[x, y, z] points, with minor and major contours (labelled with elevations in m). Optional plan ' +
    '`boundary` clips the TIN; `maxEdgeLength` drops long hull triangles on concave sites. Defaults: ' +
    'every point group, 1 m contour interval, every 5th contour major.',
  params: z.object({
    name: z.string().optional().describe('Surface name. Default "EG <n>" (existing ground).'),
    pointGroupIds: z
      .array(z.string())
      .optional()
      .describe('Point groups to triangulate. Default: every point group.'),
    points: z.array(vec3('Extra [x, y, z] point.')).optional().describe('Extra points.'),
    boundary: z.array(vec2('Boundary vertex [x, y].')).optional().describe('Outer boundary.'),
    maxEdgeLength: z.number().optional().describe('Drop triangles with a longer plan edge (> 0).'),
    contourInterval: z.number().optional().describe('Minor contour interval (> 0). Default 1 m.'),
    majorEvery: z.number().int().optional().describe('Every n-th contour is major. Default 5.'),
  }),
  run: (doc, params): CommandResult => {
    const civil = getCivil(doc);
    const groupIds =
      params.pointGroupIds ?? civilObjectsOf(civil, 'pointGroup').map((group) => group.id);
    const missing = groupIds.filter((id) => civilObject(civil, id, 'pointGroup') === undefined);
    if (missing.length > 0)
      return noop(doc, `create_surface failed: unknown point group(s) ${missing.join(', ')}.`);
    const checked = checkSurfaceOptions(params);
    if (checked !== null) return noop(doc, `create_surface failed: ${checked}`);
    const id = nextCivilId(civil, 'surface');
    const surface: SurfaceObject = {
      id,
      category: 'surface',
      name: params.name?.trim() || `EG ${civilObjectsOf(civil, 'surface').length + 1}`,
      entityIds: [],
      pointGroupIds: groupIds,
      extraPoints: params.points ?? [],
      ...(params.boundary !== undefined ? { boundary: params.boundary } : {}),
      ...(params.maxEdgeLength !== undefined ? { maxEdgeLength: params.maxEdgeLength } : {}),
      contourInterval: params.contourInterval ?? fromMetres(doc, 1),
      majorEvery: params.majorEvery ?? 5,
    };
    const next = withObject(civil, surface);
    const total = surfacePoints(next, surface).length;
    if (total > MAX_SURFACE_POINTS) {
      return noop(
        doc,
        `create_surface failed: ${total} points exceed the ${MAX_SURFACE_POINTS}-point surface limit; pick fewer point groups.`,
      );
    }
    if (surfaceTin(next, surface).triangles.length === 0) {
      return noop(
        doc,
        'create_surface failed: the points give no triangle (need >= 3 non-collinear points inside the boundary).',
      );
    }
    const document = regenerateCivil(doc, next);
    return {
      document,
      summary:
        `Created surface ${surface.name} (${id}): ${surfaceSummary(document, surface)}; ` +
        `contours every ${toMetresText(doc, surface.contourInterval)} m.`,
      affected: civilAffected(document, [id]),
      data: { surfaceId: id },
    };
  },
});

function checkSurfaceOptions(options: {
  boundary?: ReadonlyArray<Vec2> | undefined;
  maxEdgeLength?: number | undefined;
  contourInterval?: number | undefined;
  majorEvery?: number | undefined;
}): string | null {
  if (options.boundary !== undefined && !isValidPolygon(options.boundary))
    return 'boundary must be a simple polygon of >= 3 [x, y] points.';
  if (options.maxEdgeLength !== undefined && !(options.maxEdgeLength > 0))
    return 'maxEdgeLength must be > 0.';
  if (options.contourInterval !== undefined && !(options.contourInterval > 0))
    return 'contourInterval must be > 0.';
  if (options.majorEvery !== undefined && options.majorEvery < 0) return 'majorEvery must be >= 0.';
  return null;
}

/**
 * @command update_surface
 * @pure
 * @affects regenerates 1 surface (and every object graded against it)
 * @failure unknown surface / invalid option / no change -> no-op
 */
export const updateSurface = defineCommand({
  name: 'update_surface',
  description:
    'Edit a terrain surface: rename, change contour interval / major frequency, boundary, max edge ' +
    'length, or add more [x, y, z] points. Platforms and alignments on it update automatically.',
  params: z.object({
    surfaceId: z.string().describe('Surface id, e.g. "surface-1".'),
    name: z.string().optional().describe('New name.'),
    contourInterval: z.number().optional().describe('Minor contour interval (> 0).'),
    majorEvery: z.number().int().optional().describe('Every n-th contour is major (0 = none).'),
    boundary: z
      .array(vec2('Boundary vertex [x, y].'))
      .optional()
      .describe('New outer boundary ([] removes it).'),
    maxEdgeLength: z.number().optional().describe('Max plan edge length (0 removes the limit).'),
    addPoints: z.array(vec3('Extra [x, y, z] point.')).optional().describe('Points to add.'),
  }),
  run: (doc, params): CommandResult => {
    const civil = getCivil(doc);
    const surface = civilObject(civil, params.surfaceId, 'surface');
    if (!surface) return noop(doc, `update_surface failed: no surface ${params.surfaceId}.`);
    const boundary = params.boundary?.length === 0 ? undefined : params.boundary;
    const maxEdgeLength = params.maxEdgeLength === 0 ? undefined : params.maxEdgeLength;
    const checked = checkSurfaceOptions({ ...params, boundary, maxEdgeLength });
    if (checked !== null) return noop(doc, `update_surface failed: ${checked}`);
    const keepBoundary = params.boundary === undefined ? surface.boundary : boundary;
    const keepEdge = params.maxEdgeLength === undefined ? surface.maxEdgeLength : maxEdgeLength;
    const updated: SurfaceObject = {
      id: surface.id,
      category: 'surface',
      entityIds: surface.entityIds,
      pointGroupIds: surface.pointGroupIds,
      name: params.name?.trim() || surface.name,
      contourInterval: params.contourInterval ?? surface.contourInterval,
      majorEvery: params.majorEvery ?? surface.majorEvery,
      extraPoints: [...surface.extraPoints, ...(params.addPoints ?? [])],
      ...(keepBoundary !== undefined ? { boundary: keepBoundary } : {}),
      ...(keepEdge !== undefined ? { maxEdgeLength: keepEdge } : {}),
    };
    const unchanged =
      updated.name === surface.name &&
      updated.contourInterval === surface.contourInterval &&
      updated.majorEvery === surface.majorEvery &&
      updated.extraPoints.length === surface.extraPoints.length &&
      JSON.stringify(updated.boundary) === JSON.stringify(surface.boundary) &&
      updated.maxEdgeLength === surface.maxEdgeLength;
    if (unchanged) return noop(doc, `update_surface: nothing to change on ${surface.id}.`);
    const next = withObject(civil, updated);
    const total = surfacePoints(next, updated).length;
    if (total > MAX_SURFACE_POINTS) {
      return noop(
        doc,
        `update_surface failed: ${total} points exceed the ${MAX_SURFACE_POINTS}-point surface limit.`,
      );
    }
    if (surfaceTin(next, updated).triangles.length === 0)
      return noop(doc, 'update_surface failed: the surface would have no triangle.');
    const document = regenerateCivil(doc, next);
    return {
      document,
      summary: `Updated surface ${updated.name} (${updated.id}): ${surfaceSummary(document, updated)}.`,
      affected: civilAffected(document, [updated.id]),
    };
  },
});
