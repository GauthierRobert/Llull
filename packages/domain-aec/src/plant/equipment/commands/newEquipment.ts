/** What `add_heat_exchanger`, `add_storage_tank` and `add_pump` share: the tag rule, the placement params and the new equipment element. */

import type { CadDocument } from '@core/model/types';
import type { BuildingModel, EquipmentElement } from '@aec/building/types';
import { looseVec2, z } from '@core/commands/schema';
import { fromMm } from '@core/model/units';
import type { CommandResult } from '@core/commands/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { levelIdParam } from '../../../building/levelParams';
import { elementsOf, getBuilding, isVec2, nextElementId, resolveLevel, toVec2, withElement } from '../../../building/model';
import { refuse } from '../model';
import { PLANT_EQUIPMENT_SCHEMA, type EquipmentTemplate, type NozzleRecord } from '../plantData';
import { equipmentPorts } from '../geometry/ports';
import { angleConventionParam, planRotationRadians, type AngleConvention } from './angles';
import { withLegacyFields } from './legacySync';

/** Placement params of every new equipment command. */
export const placementShape = {
  tag: z
    .string()
    .min(1)
    .describe('Equipment tag, unique in the document, e.g. "E-301". It is the element mark and the first half of the port ids.'),
  name: z.string().optional().describe('Descriptive name, e.g. "Product cooler". Default: the tag.'),
  planRotationDeg: z
    .number()
    .optional()
    .describe('Plan rotation of the equipment frame about +Z in degrees, read with angleConvention. Default 0.'),
  angleConvention: angleConventionParam,
  levelId: levelIdParam,
  clearance: z.number().min(0).optional().describe('Maintenance clearance around the footprint for check_clashes. Default 800 mm.'),
};

/** `location` param of the new equipment commands; the description says what the point is. */
export const locationParam = (what: string): ReturnType<typeof looseVec2> => looseVec2(`Plan position [x, y] of ${what} (document units).`);

export interface Placement {
  readonly tag: string;
  readonly name?: string | undefined;
  readonly location: unknown;
  readonly planRotationDeg?: number | undefined;
  readonly angleConvention?: AngleConvention | undefined;
  readonly clearance?: number | undefined;
}

export interface TagIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly ids: string[];
}

/** The refusal of a tag that is empty, has whitespace / ':' (the port id is `<tag>:<mark>`) or is already used, or null. */
export function tagIssue(building: BuildingModel, tag: string): TagIssue | null {
  if (tag === '' || /[:\s]/.test(tag))
    return {
      code: 'EQP_PARAM_INVALID',
      message: "tag must not be empty nor contain whitespace or ':' (the port id is <tag>:<mark>)",
      path: 'tag',
      ids: [],
    };
  const twin = elementsOf(building, 'equipment').find((element) => element.mark === tag);
  return twin === undefined
    ? null
    : { code: 'EQP_TAG_DUPLICATE', message: `tag '${tag}' is already used by ${twin.id}`, path: 'tag', ids: [twin.id] };
}

export type LevelContext =
  | { readonly ok: true; readonly building: BuildingModel; readonly levelId: string }
  | { readonly ok: false; readonly result: CommandResult };

/** The building and level a new equipment goes on (`levelId` or the default level), or the coded refusal. */
export function levelContext(doc: CadDocument, command: string, levelId: string | undefined): LevelContext {
  const resolution = resolveLevel(doc, getBuilding(doc), levelId);
  return resolution.ok
    ? { ok: true, building: resolution.building, levelId: resolution.level.id }
    : { ok: false, result: refuse(doc, command, 'EQP_PARAM_INVALID', resolution.reason, [], ['levelId']) };
}

export type NewElement =
  | { readonly ok: true; readonly element: EquipmentElement; readonly notes: readonly string[] }
  | { readonly ok: false; readonly result: CommandResult };

/** Tag and location checks, then the element for `template` with its legacy fields derived. */
export function newEquipmentElement(
  doc: CadDocument,
  command: string,
  context: Extract<LevelContext, { ok: true }>,
  placement: Placement,
  template: EquipmentTemplate,
  nozzles: readonly NozzleRecord[],
): NewElement {
  const fail = (code: string, message: string, path: string, ids: string[] = []): NewElement => ({
    ok: false,
    result: refuse(doc, command, code, message, ids, [path]),
  });
  const tag = placement.tag.trim();
  const issue = tagIssue(context.building, tag);
  if (issue !== null) return fail(issue.code, issue.message, issue.path, issue.ids);
  if (!isVec2(placement.location)) return fail('EQP_PARAM_INVALID', 'location must be [x, y] with finite numbers', 'location');
  const element: EquipmentElement = {
    id: nextElementId(context.building, 'equipment'),
    category: 'equipment',
    mark: tag,
    entityIds: [],
    levelId: context.levelId,
    name: placement.name?.trim() || tag,
    location: toVec2(placement.location),
    angle: planRotationRadians(placement.planRotationDeg ?? 0, placement.angleConvention ?? 'north_cw'),
    size: [1, 1, 1],
    clearance: placement.clearance ?? fromMm(doc, 800),
    weight: 0,
    plant: { schema: PLANT_EQUIPMENT_SCHEMA, template, nozzles },
  };
  const derived = withLegacyFields(doc, element);
  return { ok: true, element: derived.element, notes: derived.notes };
}

/** Commits a created equipment element and reports it: ids, weight, size, shape and port ids besides the command's own `data`. */
export function commitNewEquipment(
  doc: CadDocument,
  building: BuildingModel,
  element: EquipmentElement,
  summary: string,
  data: Record<string, unknown>,
  convention: AngleConvention,
): CommandResult {
  const next = withElement(building, element);
  return commitBuilding(doc, next, [element.id], summary, {
    elementId: element.id,
    tag: element.mark,
    ...data,
    weightKg: element.weight,
    size: element.size,
    shape: element.shape ?? 'box',
    ports: equipmentPorts(next, element).map((port) => port.id),
    angleConvention: convention,
  });
}
