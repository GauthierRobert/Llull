/**
 * Coordinate reference system commands: declare the CRS, calibrate the site (local <-> grid) and
 * transform points between the two.
 * @layer domain-aec/civil
 */

import type { CadDocument } from '@core/model/types';
import type { CivilCrs } from '@core/model/civil';
import type { CommandDefinition, CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { getCivil } from './model';
import { gridToLocal, localToGrid } from './crs';

const withCrs = (doc: CadDocument, crs: CivilCrs): CadDocument => ({
  ...doc,
  civil: { ...getCivil(doc), crs },
});

/**
 * @command set_coordinate_system
 * @pure
 * @affects sets civil.crs (keeps an existing calibration)
 * @failure empty name / invalid epsg -> no-op
 */
export const setCoordinateSystem = defineCommand({
  name: 'set_coordinate_system',
  description:
    'Declare the coordinate reference system of the civil model (projected grid), e.g. name ' +
    '"RGF93 / Lambert-93", epsg 2154, verticalDatum "NGF-IGN69". Written to LandXML ' +
    '(<CoordinateSystem>). Keeps an existing site calibration (set_site_calibration).',
  params: z.object({
    name: z.string().describe('CRS name, e.g. "RGF93 / Lambert-93". Must not be empty.'),
    epsg: z
      .number()
      .optional()
      .describe('EPSG code of the projected CRS (positive integer), e.g. 2154.'),
    verticalDatum: z.string().optional().describe('Vertical datum name, e.g. "NGF-IGN69".'),
  }),
  run: (doc, { name, epsg, verticalDatum }): CommandResult => {
    if (name.trim() === '') return noop(doc, 'set_coordinate_system failed: name is empty.');
    if (epsg !== undefined && !(Number.isInteger(epsg) && epsg > 0))
      return noop(doc, 'set_coordinate_system failed: epsg must be a positive integer.');
    const calibration = getCivil(doc).crs?.calibration;
    const crs: CivilCrs = {
      name: name.trim(),
      ...(epsg !== undefined ? { epsg } : {}),
      ...(verticalDatum !== undefined && verticalDatum.trim() !== ''
        ? { verticalDatum: verticalDatum.trim() }
        : {}),
      ...(calibration !== undefined ? { calibration } : {}),
    };
    return {
      document: withCrs(doc, crs),
      summary:
        `Coordinate system ${crs.name}${epsg !== undefined ? ` (EPSG:${epsg})` : ''}` +
        `${crs.verticalDatum !== undefined ? `, vertical ${crs.verticalDatum}` : ''}.`,
      affected: [],
    };
  },
});

/**
 * @command set_site_calibration
 * @pure
 * @affects sets civil.crs.calibration (creates an "Unnamed" CRS when none is set)
 * @failure scaleFactor <= 0 / non-finite value -> no-op
 */
export const setSiteCalibration = defineCommand({
  name: 'set_site_calibration',
  description:
    'Calibrate the local site coordinates to the projected grid with a 2D similarity (Helmert): ' +
    'grid = gridOrigin + scaleFactor * R(rotationDeg) * (local - localOrigin), R counter-clockwise. ' +
    'Coordinates are in document units; elevations are unchanged. Used by transform_coordinates, ' +
    'import_survey_points (coordinates "grid") and the LandXML / DXF / sheet exports.',
  params: z.object({
    localOrigin: vec2('[x, y] of a control point in local (document) coordinates.'),
    gridOrigin: vec2('[easting, northing] of the same control point in grid coordinates.'),
    rotationDeg: z
      .number()
      .optional()
      .describe('Counter-clockwise rotation of local axes into grid axes, degrees. Default 0.'),
    scaleFactor: z
      .number()
      .optional()
      .describe('Combined scale factor k = grid distance / local distance, > 0. Default 1.'),
  }),
  run: (doc, { localOrigin, gridOrigin, rotationDeg = 0, scaleFactor = 1 }): CommandResult => {
    const values = [...localOrigin, ...gridOrigin, rotationDeg, scaleFactor];
    if (!values.every(Number.isFinite))
      return noop(doc, 'set_site_calibration failed: all values must be finite numbers.');
    if (!(scaleFactor > 0))
      return noop(doc, 'set_site_calibration failed: scaleFactor must be > 0.');
    const previous = getCivil(doc).crs ?? { name: 'Unnamed' };
    const crs: CivilCrs = {
      ...previous,
      calibration: { localOrigin, gridOrigin, rotationDeg, scaleFactor },
    };
    return {
      document: withCrs(doc, crs),
      summary:
        `Site calibration: local [${localOrigin.join(', ')}] = grid [${gridOrigin.join(', ')}], ` +
        `rotation ${rotationDeg} deg, scale ${scaleFactor}.`,
      affected: [],
    };
  },
});

/**
 * @command transform_coordinates
 * @pure read-only
 * @affects none; data = { points, direction }
 * @failure no calibration / no points -> no data
 */
export const transformCoordinates = defineCommand({
  name: 'transform_coordinates',
  description:
    'Convert [x, y] points between local site coordinates and the projected grid using the site ' +
    'calibration (set_site_calibration). Document units. data.points holds the converted points ' +
    'in the same order.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    points: z.array(vec2('[x, y] point to convert.')).describe('Points to convert.'),
    direction: z
      .enum(['localToGrid', 'gridToLocal'])
      .describe('"localToGrid": local -> grid; "gridToLocal": grid -> local.'),
  }),
  run: (doc, { points, direction }): CommandResult => {
    const calibration = getCivil(doc).crs?.calibration;
    if (!calibration)
      return noop(doc, 'transform_coordinates failed: no site calibration (set_site_calibration).');
    if (points.length === 0) return noop(doc, 'transform_coordinates failed: no points.');
    const convert = direction === 'localToGrid' ? localToGrid : gridToLocal;
    return {
      document: doc,
      summary: `Transformed ${points.length} point(s) ${direction}.`,
      affected: [],
      data: { points: points.map((point) => convert(calibration, point)), direction },
    };
  },
});

export const crsCommands = [
  setCoordinateSystem,
  setSiteCalibration,
  transformCoordinates,
] as ReadonlyArray<CommandDefinition<unknown>>;
