import type { CadDocument } from '@core/model/types';
import type { BuildingModel, EquipmentElement } from '@aec/building/types';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { getBuilding, withElement } from '../../../building/model';
import { nozzleProblem, type NozzleIssue } from '../geometry/nozzleChecks';
import { refuse } from '../model';
import type { NozzleRecord } from '../plantData';
import { angleConventionParam, type AngleConvention } from './angles';
import { connectedPipeIds, equipmentRefParam, findEquipment } from './equipmentRef';
import {
  isNozzleIssue,
  nozzleFields,
  nozzleLocationSchema,
  PROJECTION_TEXT,
  RATING_TEXT,
  nozzleRecord,
  nozzleReport,
  parseLocation,
  plantOf,
  resolveDn,
} from './nozzleParams';

const refuseIssue = (doc: CadDocument, command: string, issue: NozzleIssue, ids: string[], prefix = ''): CommandResult =>
  refuse(doc, command, issue.code, issue.message, ids, [`${prefix}${issue.path}`]);

interface Found {
  readonly element: EquipmentElement;
  readonly building: BuildingModel;
}
type Target = Found | CommandResult;
const isTarget = (value: Target): value is Found => 'element' in value;

function targetOf(doc: CadDocument, command: string, reference: string): Target {
  const building = getBuilding(doc);
  const element = findEquipment(building, reference);
  return element === undefined
    ? refuse(doc, command, 'EQP_NOT_FOUND', `no equipment with tag or id '${reference}'`, [], ['equipment'])
    : { element, building };
}

/** The element carrying `nozzles` in place of its current list (a legacy block gets its plant record on the first nozzle). */
const withNozzles = (element: EquipmentElement, nozzles: readonly NozzleRecord[]): EquipmentElement => ({
  ...element,
  plant: { ...plantOf(element), nozzles },
});

/**
 * @affects adds 1 nozzle record to the equipment and its derived nozzle revolution (neck + flange) on layer Q-EQPM; the port is `<tag>:<mark>`
 * @invariant shell projection = vessel axis to flange face, head projection = tangent line to flange face; stored angles are north_cw whatever
 *   the call's convention; flange OD / thickness come from the 01 PSC catalogue, else flagged EQP_FLANGE_PLACEHOLDER; legacy blocks take
 *   `{ on: 'free' }` locations
 * @failure unknown equipment, duplicate mark, rating/DN not in the tables, location off the body, face inside the wall -> coded refusal
 */
export const addNozzle = defineCommand({
  name: 'add_nozzle',
  description:
    'Add a flanged nozzle to an equipment (vessel from add_vessel, or any add_equipment block). Identify the equipment by tag or id. `mark` is unique ' +
    'per equipment (N1, M1 ...); the connection port is "<tag>:<mark>", e.g. "V-101:N1". Size by dn or nps, rating CL150 / PN16 ..., facing RF / FF / RTJ. ' +
    'location: { on: "shell", elevation (vertical vessel, above the bottom tangent line) or station (horizontal vessel, from the left tangent line), ' +
    'orientationDeg } | { on: "head", head: top | bottom | left | right, radialOffset, orientationDeg } | { on: "free", position, direction } in the ' +
    'equipment frame (blocks, pumps). projection = distance from the vessel AXIS to the flange face (shell nozzles) or from the TANGENT LINE to the ' +
    'face (head nozzles), document units. Angles use angleConvention (north_cw default: vertical 0 = plant north growing clockwise; horizontal 0 = top). ' +
    'The flange comes from the piping catalogue (placeholder warning when no row). Returns portId, world position and unit direction of the flange ' +
    'face (what route_pipe / routing connect to), flange, warnings, angleConvention. Refusals: EQP_NOT_FOUND, EQP_NOZZLE_MARK_DUPLICATE, ' +
    'EQP_NOZZLE_OFF_BODY, EQP_NOZZLE_PROJECTION_TOO_SHORT, EQP_RATING_UNKNOWN, EQP_PARAM_INVALID.',
  params: z.object({
    equipment: equipmentRefParam,
    mark: z.string().min(1).describe('Nozzle mark, unique on this equipment: N1, M1, S1 ...'),
    angleConvention: angleConventionParam,
    ...nozzleFields,
    rating: z.string().describe(RATING_TEXT),
    location: nozzleLocationSchema,
    projection: z.number().positive().describe(PROJECTION_TEXT),
  }),
  run: (doc, params): CommandResult => {
    const target = targetOf(doc, 'add_nozzle', params.equipment);
    if (!isTarget(target)) return target;
    const { element, building } = target;
    const plant = plantOf(element);
    const mark = params.mark.trim();
    if (mark === '') return refuse(doc, 'add_nozzle', 'EQP_PARAM_INVALID', 'mark must not be empty', [element.id], ['mark']);
    if (plant.nozzles.some((nozzle) => nozzle.mark === mark))
      return refuse(doc, 'add_nozzle', 'EQP_NOZZLE_MARK_DUPLICATE', `${element.mark} already has a nozzle ${mark}`, [element.id], ['mark']);
    const dn = resolveDn(params.dn, params.nps);
    if (typeof dn !== 'number') return refuseIssue(doc, 'add_nozzle', dn, [element.id]);
    const convention: AngleConvention = params.angleConvention ?? 'north_cw';
    const location = parseLocation(params.location, convention);
    if (isNozzleIssue(location)) return refuseIssue(doc, 'add_nozzle', location, [element.id]);
    const defaulted: string[] = [];
    if (params.facing === undefined) defaulted.push('facing');
    if (params.location.on !== 'free' && params.location.orientationDeg === undefined) defaulted.push('location.orientationDeg');
    const record = nozzleRecord(
      doc,
      mark,
      { dn, rating: params.rating, facing: params.facing ?? 'RF', projection: params.projection, location, service: params.service },
      defaulted,
    );
    if (isNozzleIssue(record)) return refuseIssue(doc, 'add_nozzle', record, [element.id]);
    const problem = nozzleProblem(plant.template, record);
    if (problem !== null) return refuseIssue(doc, 'add_nozzle', problem, [element.id]);
    const next = withNozzles(element, [...plant.nozzles, record]);
    const report = nozzleReport(next, building, record, convention);
    return commitBuilding(
      doc,
      withElement(building, next),
      [element.id],
      `add_nozzle: ${report['portId']} DN${dn} ${record.rating} ${record.facing} on ${element.id}, face at [${(report['position'] as number[]).join(', ')}] direction [${(report['direction'] as number[]).join(', ')}] (angleConvention ${convention}).`,
      { ...report, elementId: element.id, defaulted },
    );
  },
});

/**
 * @affects replaces fields of 1 nozzle record; the port id `<tag>:<mark>` is kept; the derived nozzle solid is regenerated
 * @invariant fields omitted are unchanged; hardware is re-resolved when dn / nps / rating / facing change; the full nozzle is re-validated
 * @failure unknown equipment / mark, invalid values, location off the body, face inside the wall -> coded refusal; nothing given -> no-op
 */
export const updateNozzle = defineCommand({
  name: 'update_nozzle',
  description:
    'Change a nozzle of an equipment in place, keeping its mark and port id "<tag>:<mark>": any of service, dn / nps, rating, facing, location ' +
    '(same forms as add_nozzle, replaces the whole location) and projection. Fields you omit are unchanged. The nozzle is re-validated against the ' +
    'body and its flange re-resolved from the piping catalogue. Returns the new world position and direction of the port. Refusals as add_nozzle, ' +
    'plus EQP_NOZZLE_NOT_FOUND.',
  params: z.object({
    equipment: equipmentRefParam,
    mark: z.string().min(1).describe('Mark of the nozzle to change.'),
    angleConvention: angleConventionParam,
    ...nozzleFields,
  }),
  run: (doc, params): CommandResult => {
    const target = targetOf(doc, 'update_nozzle', params.equipment);
    if (!isTarget(target)) return target;
    const { element, building } = target;
    const plant = plantOf(element);
    const current = plant.nozzles.find((nozzle) => nozzle.mark === params.mark);
    if (current === undefined)
      return refuse(doc, 'update_nozzle', 'EQP_NOZZLE_NOT_FOUND', `${element.mark} has no nozzle ${params.mark}`, [element.id], ['mark']);
    const convention: AngleConvention = params.angleConvention ?? 'north_cw';
    const changes = ['service', 'dn', 'nps', 'rating', 'facing', 'location', 'projection'].filter(
      (name) => params[name as keyof typeof params] !== undefined,
    );
    if (changes.length === 0)
      return refuse(doc, 'update_nozzle', 'EQP_PARAM_INVALID', 'give at least one field to change', [element.id], []);
    const dn = params.dn === undefined && params.nps === undefined ? current.dn : resolveDn(params.dn, params.nps);
    if (typeof dn !== 'number') return refuseIssue(doc, 'update_nozzle', dn, [element.id]);
    const location = params.location === undefined ? current.location : parseLocation(params.location, convention);
    if (isNozzleIssue(location)) return refuseIssue(doc, 'update_nozzle', location, [element.id]);
    const defaulted: string[] = [];
    const record = nozzleRecord(
      doc,
      current.mark,
      {
        dn,
        rating: params.rating ?? current.rating,
        facing: params.facing ?? current.facing,
        projection: params.projection ?? current.projection,
        location,
        service: params.service ?? current.service,
      },
      defaulted,
    );
    if (isNozzleIssue(record)) return refuseIssue(doc, 'update_nozzle', record, [element.id]);
    const problem = nozzleProblem(plant.template, record);
    if (problem !== null) return refuseIssue(doc, 'update_nozzle', problem, [element.id]);
    const next = withNozzles(
      element,
      plant.nozzles.map((nozzle) => (nozzle.mark === current.mark ? record : nozzle)),
    );
    const report = nozzleReport(next, building, record, convention);
    return commitBuilding(
      doc,
      withElement(building, next),
      [element.id],
      `update_nozzle: ${report['portId']} changed (${changes.join(', ')}); face at [${(report['position'] as number[]).join(', ')}] (angleConvention ${convention}).`,
      {
        ...report,
        elementId: element.id,
        changed: changes,
        defaulted,
        connectedPipes: connectedPipeIds(building, `${element.mark}:${current.mark}`),
      },
    );
  },
});

/**
 * @affects removes 1 nozzle record and its derived nozzle solid
 * @invariant the other nozzles keep their marks and port ids
 * @failure unknown equipment / mark -> coded refusal; a pipe is attached to the port -> EQP_PORT_CONNECTED unless force
 */
export const deleteNozzle = defineCommand({
  name: 'delete_nozzle',
  description:
    'Delete a nozzle of an equipment by mark. Refused with EQP_PORT_CONNECTED when a pipe is attached to the port "<tag>:<mark>" (re-route the pipe ' +
    'first) unless force is true. The other nozzles keep their marks and port ids.',
  annotations: { destructive: true },
  params: z.object({
    equipment: equipmentRefParam,
    mark: z.string().min(1).describe('Mark of the nozzle to delete.'),
    force: z.boolean().optional().describe('Delete even when a pipe is attached to the port. Default false.'),
  }),
  run: (doc, params): CommandResult => {
    const target = targetOf(doc, 'delete_nozzle', params.equipment);
    if (!isTarget(target)) return target;
    const { element, building } = target;
    const plant = plantOf(element);
    if (!plant.nozzles.some((nozzle) => nozzle.mark === params.mark))
      return refuse(doc, 'delete_nozzle', 'EQP_NOZZLE_NOT_FOUND', `${element.mark} has no nozzle ${params.mark}`, [element.id], ['mark']);
    const portId = `${element.mark}:${params.mark}`;
    const pipes = connectedPipeIds(building, portId);
    if (pipes.length > 0 && params.force !== true)
      return refuse(
        doc,
        'delete_nozzle',
        'EQP_PORT_CONNECTED',
        `${portId} is connected to ${pipes.join(', ')}`,
        [element.id, ...pipes],
        ['mark'],
      );
    const next = withNozzles(
      element,
      plant.nozzles.filter((nozzle) => nozzle.mark !== params.mark),
    );
    return commitBuilding(
      doc,
      withElement(building, next),
      [element.id],
      `delete_nozzle: removed ${portId}${pipes.length > 0 ? ` (forced; was connected to ${pipes.join(', ')})` : ''}.`,
      { elementId: element.id, portId, disconnectedPipes: pipes },
    );
  },
});
