import type { CadDocument } from '@core/model/types';
import type { BuildingModel, EquipmentElement } from '@aec/building/types';
import { defineCommand, looseVec2, z } from '@core/commands/schema';
import { fromMm } from '@core/model/units';
import type { CommandResult } from '@core/commands/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { levelIdParam } from '../../../building/levelParams';
import { elementsOf, getBuilding, isVec2, nextElementId, resolveLevel, toVec2, withElement } from '../../../building/model';
import { refuse } from '../model';
import { PLANT_EQUIPMENT_SCHEMA, type PlantEquipmentData, type VesselTemplate } from '../plantData';
import { equipmentPorts } from '../geometry/ports';
import { vesselDatum } from '../geometry/vesselFrame';
import { angleConventionParam, planRotationRadians } from './angles';
import { withLegacyFields } from './legacySync';
import { buildVesselTemplate, designInputSchema, designOf, headsInputSchema, isVesselIssue, supportInputSchema } from './vesselParams';

/** Params shared by `add_vessel` and `add_process_column` (a column is a vertical vessel with trays). */
export const vesselShape = {
  tag: z
    .string()
    .min(1)
    .describe('Equipment tag, unique in the document, e.g. "V-101". It is the element mark and the first half of the port ids.'),
  name: z.string().optional().describe('Descriptive name, e.g. "HP separator". Default: the tag.'),
  location: looseVec2('Plan position [x, y] of the vessel axis (document units).'),
  planRotationDeg: z
    .number()
    .optional()
    .describe('Plan rotation of the equipment frame about +Z in degrees, read with angleConvention. Default 0.'),
  angleConvention: angleConventionParam,
  levelId: levelIdParam,
  insideDiameter: z.number().positive().describe('Inside diameter of the shell, document units.'),
  tangentLength: z.number().positive().describe('Tangent-to-tangent length of the cylindrical shell, document units (heads excluded).'),
  heads: headsInputSchema,
  shellThickness: z.number().positive().describe('Nominal shell wall thickness (corrosion allowance included), document units.'),
  headThickness: z.number().positive().optional().describe('Nominal head thickness. Default: the shell thickness (reported in defaulted).'),
  corrosionAllowance: z.number().min(0).optional().describe('Corrosion allowance, document units. Default 0 (reported in defaulted).'),
  support: supportInputSchema,
  design: designInputSchema.optional(),
  clearance: z.number().min(0).optional().describe('Maintenance clearance around the footprint for check_clashes. Default 800 mm.'),
};

const vesselParams = z.object({
  ...vesselShape,
  orientation: z
    .enum(['vertical', 'horizontal'])
    .describe('vertical: axis along +Z, heads bottom / top. horizontal: axis along the local X, heads left / right.'),
});
export type VesselParams = z.infer<typeof vesselParams>;

export type CreatedVessel =
  | {
      readonly ok: true;
      readonly element: EquipmentElement;
      readonly template: VesselTemplate;
      readonly defaulted: string[];
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly result: CommandResult };

/** The validated element of a vessel command (not yet in the building), or the coded refusal. */
export function createVessel(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  params: VesselParams,
  command: string,
): CreatedVessel {
  const fail = (code: string, message: string, path: string, ids: string[] = []): CreatedVessel => ({
    ok: false,
    result: refuse(doc, command, code, message, ids, [path]),
  });
  const tag = params.tag.trim();
  if (tag === '') return fail('EQP_PARAM_INVALID', 'tag must not be empty', 'tag');
  const twin = elementsOf(building, 'equipment').find((element) => element.mark === tag);
  if (twin !== undefined) return fail('EQP_TAG_DUPLICATE', `tag '${tag}' is already used by ${twin.id}`, 'tag', [twin.id]);
  if (!isVec2(params.location)) return fail('EQP_PARAM_INVALID', 'location must be [x, y] with finite numbers', 'location');
  const built = buildVesselTemplate(params);
  if (isVesselIssue(built)) return fail(built.code, built.message, built.path);
  const design = designOf(params.design);
  const plant: PlantEquipmentData = {
    schema: PLANT_EQUIPMENT_SCHEMA,
    template: built.template,
    ...(design === undefined ? {} : { design }),
    nozzles: [],
  };
  const element: EquipmentElement = {
    id: nextElementId(building, 'equipment'),
    category: 'equipment',
    mark: tag,
    entityIds: [],
    levelId,
    name: params.name?.trim() || tag,
    location: toVec2(params.location),
    angle: planRotationRadians(params.planRotationDeg ?? 0, params.angleConvention ?? 'north_cw'),
    size: [1, 1, 1],
    clearance: params.clearance ?? fromMm(doc, 800),
    weight: 0,
    plant,
  };
  const derived = withLegacyFields(doc, element);
  return { ok: true, element: derived.element, template: built.template, defaulted: built.defaulted, notes: derived.notes };
}

/** `data` of a created vessel: ids, tangent elevations, defaults, weight, size and port ids. */
export function vesselData(
  building: BuildingModel,
  created: Extract<CreatedVessel, { ok: true }>,
  convention: string,
): Record<string, unknown> {
  const { element, template } = created;
  const datum = vesselDatum(template);
  const tangents =
    template.orientation === 'vertical'
      ? { bottomTangentLine: datum, topTangentLine: datum + template.tangentLength }
      : { axisElevation: datum };
  return {
    elementId: element.id,
    tag: element.mark,
    orientation: template.orientation,
    ...tangents,
    defaulted: created.defaulted,
    notes: created.notes,
    weightKg: element.weight,
    size: element.size,
    shape: element.shape ?? 'box',
    ports: equipmentPorts(building, element).map((port) => port.id),
    angleConvention: convention,
  };
}

/**
 * @affects creates 1 equipment element (plant template 'vessel') plus derived revolutions / boxes on layer Q-EQPM tagged element:<id>
 * @invariant size / shape / weight of the element are re-derived from `plant` in the same command; ids are step-scoped (L8); the level is the
 *   support datum (bottom tangent line / axis elevations are measured from the level elevation)
 * @failure duplicate tag, thickness <= allowance, missing / invalid head, support not suiting the orientation -> coded refusal with the param path
 */
export const addVessel = defineCommand({
  name: 'add_vessel',
  description:
    'Create a parametric pressure vessel (equipment element with a tag): cylindrical shell with two formed heads (ellipsoidal 2:1, torispherical by ' +
    'standard or radii, hemispherical, flat, conical), a support (skirt, legs, saddles or none) and optional design data. Dimensions are INSIDE ' +
    'diameter and tangent-to-tangent length in document units; thicknesses are nominal and include the corrosion allowance. Vertical vessels: ' +
    'heads {top, bottom}, support skirt / legs (height = floor to the bottom tangent line). Horizontal vessels: heads {left, right}, support ' +
    'saddles { stations from the left tangent line, width, axisElevation } or none. The geometry is derived (exact revolutions) and the legacy ' +
    'size / shape / weight fields are re-derived so clash checks, floor loads and schedules keep working. The tag must be unique. Next: add_nozzle ' +
    'for connections (their ports are "<tag>:<mark>"), vessel_volume for volumes, update_equipment_parameters to revise. Returns elementId, tag, ' +
    'bottom / top tangent elevations (vertical) or axisElevation (horizontal), defaulted[] (named defaults used), weightKg, angleConvention.',
  params: vesselParams,
  run: (doc, params): CommandResult => {
    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok) return refuse(doc, 'add_vessel', 'EQP_PARAM_INVALID', resolution.reason, [], ['levelId']);
    const created = createVessel(doc, resolution.building, resolution.level.id, params, 'add_vessel');
    if (!created.ok) return created.result;
    const { element, template, defaulted } = created;
    return commitBuilding(
      doc,
      withElement(resolution.building, element),
      [element.id],
      `add_vessel: ${element.mark} "${element.name}" (${element.id}) ${template.orientation} vessel ID ${template.insideDiameter} x ${template.tangentLength} T/T, ` +
        `${template.support.type} support, ${element.weight.toFixed(1)} kg operating${defaulted.length > 0 ? `; defaults: ${defaulted.join(', ')}` : ''}.`,
      vesselData(resolution.building, created, params.angleConvention ?? 'north_cw'),
    );
  },
});
