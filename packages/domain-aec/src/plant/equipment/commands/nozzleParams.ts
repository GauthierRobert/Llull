/** Parameter schemas and conversions shared by the nozzle commands (`add_nozzle`, `update_nozzle`). */

import type { CadDocument } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { vec3, z } from '@core/commands/schema';
import { npsToDn, parseNps } from '../../catalog/nominal';
import { nozzleHardware, ratingText } from '../geometry/nozzleHardware';
import { nozzleWarnings, type NozzleIssue } from '../geometry/nozzleChecks';
import { equipmentPorts } from '../geometry/ports';
import { PLANT_EQUIPMENT_SCHEMA, type NozzleFacing, type NozzleLocation, type NozzleRecord, type PlantEquipmentData } from '../plantData';
import { fromNorthClockwise, toNorthClockwise, type AngleConvention } from './angles';

export const nozzleLocationSchema = z
  .object({
    on: z
      .enum(['shell', 'head', 'free'])
      .describe(
        'shell: on the cylinder (vertical vessel: elevation; horizontal vessel: station). head: on a formed head (top / bottom or left / right) at ' +
          'radialOffset. free: any equipment, including plain add_equipment blocks and pumps: position + direction in the equipment frame.',
      ),
    elevation: z.number().optional().describe('shell, vertical vessel: height above the bottom tangent line, 0..tangentLength.'),
    station: z.number().optional().describe('shell, horizontal vessel: distance from the left tangent line, 0..tangentLength.'),
    head: z
      .enum(['top', 'bottom', 'left', 'right'])
      .optional()
      .describe('head: top / bottom for a vertical vessel, left / right for a horizontal one.'),
    radialOffset: z
      .number()
      .min(0)
      .optional()
      .describe('head: distance of the nozzle axis from the vessel axis, 0 = on the axis (default), below the inside radius.'),
    orientationDeg: z
      .number()
      .optional()
      .describe('shell / head: angle around the vessel axis in degrees, read with angleConvention. Default 0 (north / top).'),
    position: vec3(
      'free: flange face centre [x, y, z] in the equipment frame (origin = plan location at the level elevation, +Z up).',
    ).optional(),
    direction: vec3('free: outward direction of the nozzle axis [dx, dy, dz] in the equipment frame; normalised.').optional(),
  })
  .describe('Where the nozzle sits. Only the fields of the chosen `on` are read.');

export const RATING_TEXT = 'Flange rating: CL150, CL300, CL600 ... or PN16, PN40 ...';

export type NozzleLocationInput = z.infer<typeof nozzleLocationSchema>;

export const PROJECTION_TEXT =
  'Distance to the flange FACE: shell nozzles from the vessel axis, head nozzles from the tangent line, free nozzles the neck length behind position. Document units.';

export const nozzleFields = {
  service: z.string().optional().describe('Service of the nozzle, e.g. "inlet", "PSV", "manway".'),
  dn: z.number().int().positive().optional().describe('Nominal size DN (15..600 of the EN 10220 series). Give dn OR nps.'),
  nps: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Nominal pipe size in inches, e.g. 6 or "2-1/2"; converted to DN. Give dn OR nps.'),
  rating: z.string().optional().describe(RATING_TEXT),
  facing: z.enum(['RF', 'FF', 'RTJ']).optional().describe('Flange facing. Default RF.'),
  location: nozzleLocationSchema.optional(),
  projection: z.number().positive().optional().describe(PROJECTION_TEXT),
};

const fail = (code: string, message: string, path: string): NozzleIssue => ({ code, message, path });
export const isNozzleIssue = (value: object): value is NozzleIssue => 'code' in value && 'path' in value && 'message' in value;

/** Stored location of `input` (angles converted to north_cw), or the issue. */
export function parseLocation(input: NozzleLocationInput, convention: AngleConvention): NozzleLocation | NozzleIssue {
  const orientationDeg = toNorthClockwise(input.orientationDeg ?? 0, convention);
  if (input.on === 'free') {
    if (input.position === undefined) return fail('EQP_PARAM_INVALID', 'a free location needs position', 'location.position');
    if (input.direction === undefined) return fail('EQP_PARAM_INVALID', 'a free location needs direction', 'location.direction');
    return { on: 'free', position: input.position, direction: input.direction };
  }
  if (input.on === 'head') {
    if (input.head === undefined)
      return fail('EQP_PARAM_INVALID', 'a head location needs head (top, bottom, left or right)', 'location.head');
    return { on: 'head', head: input.head, radialOffset: input.radialOffset ?? 0, orientationDeg };
  }
  if (input.elevation !== undefined && input.station !== undefined)
    return fail('EQP_PARAM_INVALID', 'give elevation (vertical vessel) or station (horizontal vessel), not both', 'location.station');
  if (input.elevation !== undefined) return { on: 'shell', elevation: input.elevation, orientationDeg };
  if (input.station !== undefined) return { on: 'shell', station: input.station, orientationDeg };
  return fail(
    'EQP_PARAM_INVALID',
    'a shell location needs elevation (vertical vessel) or station (horizontal vessel)',
    'location.elevation',
  );
}

/** The orientation of a stored location in the convention of the call, or undefined (free locations carry none). */
export const orientationIn = (location: NozzleLocation, convention: AngleConvention): number | undefined =>
  location.on === 'free' ? undefined : fromNorthClockwise(location.orientationDeg, convention);

/** DN of `dn` / `nps` (exactly one of them), or the issue. */
export function resolveDn(dn: number | undefined, nps: string | number | undefined): number | NozzleIssue {
  if (dn !== undefined && nps !== undefined) return fail('EQP_PARAM_INVALID', 'give dn OR nps, not both', 'nps');
  if (nps !== undefined) {
    const size = parseNps(nps);
    const converted = size === null ? null : npsToDn(size);
    return converted === null ? fail('EQP_PARAM_INVALID', `nps ${String(nps)} has no DN pairing`, 'nps') : converted.value;
  }
  return dn ?? fail('EQP_PARAM_INVALID', 'dn or nps is required', 'dn');
}

export interface NozzleSpec {
  readonly dn: number;
  readonly rating: string;
  readonly facing: NozzleFacing;
  readonly projection: number;
  readonly location: NozzleLocation;
  readonly service?: string | undefined;
}

/** A complete nozzle record (hardware from the 01 PSC catalogue), or the issue; `defaulted` receives the named defaults. */
export function nozzleRecord(doc: CadDocument, mark: string, spec: NozzleSpec, defaulted: string[]): NozzleRecord | NozzleIssue {
  const hardware = nozzleHardware(doc, spec.dn, spec.rating, spec.facing);
  if (hardware === null)
    return fail(
      'EQP_RATING_UNKNOWN',
      `rating '${spec.rating}' is not CLnnn / PNnn, or DN${spec.dn} is not in the nominal-size table (15..600)`,
      'rating',
    );
  defaulted.push(...hardware.defaulted.map((name) => `nozzle.${name}`));
  return {
    mark,
    ...(spec.service === undefined ? {} : { service: spec.service }),
    dn: spec.dn,
    rating: ratingText(spec.rating),
    facing: spec.facing,
    location: spec.location,
    projection: spec.projection,
    neckOutsideDiameter: hardware.neckOutsideDiameter,
    neckWall: hardware.neckWall,
    flange: hardware.flange,
  };
}

/** A plant record for equipment that has none yet: a legacy block that only carries nozzles. */
export const plantOf = (element: EquipmentElement): PlantEquipmentData =>
  element.plant ?? { schema: PLANT_EQUIPMENT_SCHEMA, template: { kind: 'block' }, nozzles: [] };

/** `data` of one nozzle on `element` after the edit: port, flange, warnings (knuckle, overlap, flange placeholder). */
export function nozzleReport(
  element: EquipmentElement,
  building: Parameters<typeof equipmentPorts>[0],
  record: NozzleRecord,
  convention: AngleConvention,
): Record<string, unknown> {
  const portId = `${element.mark}:${record.mark}`;
  const port = equipmentPorts(building, element).find((candidate) => candidate.id === portId);
  const plant = plantOf(element);
  const warnings: NozzleIssue[] = nozzleWarnings(plant.template, record, plant.nozzles);
  if (record.flange.placeholder)
    warnings.push(
      fail(
        'EQP_FLANGE_PLACEHOLDER',
        `no 01 PSC weld-neck flange row for DN${record.dn} ${record.rating} ${record.facing}: placeholder proportions used`,
        'flange',
      ),
    );
  return {
    portId,
    position: port?.position ?? null,
    direction: port?.direction ?? null,
    mark: record.mark,
    dn: record.dn,
    rating: record.rating,
    facing: record.facing,
    orientationDeg: orientationIn(record.location, convention) ?? null,
    angleConvention: convention,
    flange: record.flange,
    neck: { outsideDiameter: record.neckOutsideDiameter, wall: record.neckWall },
    warnings,
  };
}
