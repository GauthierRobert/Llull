import type { EquipmentElement } from '@aec/building/types';
import type { CadDocument } from '@core/model/types';
import { defineCommand, looseVec2, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { getBuilding, isVec2, toVec2, withElement } from '../../../building/model';
import { nozzleProblem } from '../geometry/nozzleChecks';
import { equipmentPorts, type ConnectionPort } from '../geometry/ports';
import { refuse } from '../model';
import type { EquipmentTemplate, PlantEquipmentData, VesselDesignData, VesselTemplate } from '../plantData';
import { angleConventionParam, planRotationDegrees, planRotationRadians, type AngleConvention } from './angles';
import { trayOverflow } from './columnParams';
import { connectedPipeIds, equipmentRefParam, findEquipment } from './equipmentRef';
import { withLegacyFields } from './legacySync';
import {
  exchangerPatchSchema,
  pumpPatchSchema,
  reviseExchanger,
  revisePump,
  reviseTank,
  tankPatchSchema,
  type ExchangerPatch,
  type PumpPatch,
  type Revision,
  type TankPatch,
} from './reviseEquipment';
import {
  buildVesselTemplate,
  designInputSchema,
  headsInputSchema,
  isVesselIssue,
  liquidLevelIssue,
  supportInputSchema,
  vesselInputOf,
  type VesselIssue,
} from './vesselParams';

const MOVED = 1e-6;
const TEMPLATE_KEYS = [
  'insideDiameter',
  'tangentLength',
  'heads',
  'shellThickness',
  'headThickness',
  'corrosionAllowance',
  'support',
] as const;

const changeSet = z
  .object({
    name: z.string().min(1).optional().describe('New descriptive name.'),
    location: looseVec2('New plan position [x, y] of the vessel axis.').optional(),
    planRotationDeg: z.number().optional().describe('New plan rotation about +Z in degrees, read with angleConvention.'),
    insideDiameter: z.number().positive().optional().describe('New inside diameter, document units.'),
    tangentLength: z.number().positive().optional().describe('New tangent-to-tangent length, document units.'),
    heads: headsInputSchema.optional().describe('Heads to replace by name (top / bottom or left / right); the others are kept.'),
    shellThickness: z.number().positive().optional().describe('New nominal shell thickness.'),
    headThickness: z.number().positive().optional().describe('New nominal head thickness.'),
    corrosionAllowance: z.number().min(0).optional().describe('New corrosion allowance.'),
    support: supportInputSchema.optional().describe('New support; replaces the whole support (omitted fields take their defaults).'),
    design: designInputSchema.optional().describe('Design data fields to set; fields you omit are kept.'),
    clearance: z.number().min(0).optional().describe('New maintenance clearance.'),
  })
  .describe('The fields to change; everything omitted stays as it is.');

const portPositions = (ports: readonly ConnectionPort[]): Map<string, ConnectionPort> => new Map(ports.map((port) => [port.id, port]));

const VESSEL_ONLY = [
  'insideDiameter',
  'tangentLength',
  'heads',
  'shellThickness',
  'headThickness',
  'corrosionAllowance',
  'support',
  'design',
] as const;
const COMMAND = 'update_equipment_parameters';

interface Params {
  readonly equipment: string;
  readonly set: z.infer<typeof changeSet>;
  readonly angleConvention?: AngleConvention | undefined;
  readonly exchanger?: ExchangerPatch | undefined;
  readonly tank?: TankPatch | undefined;
  readonly pump?: PumpPatch | undefined;
}

type Fail = (code: string, message: string, path: string) => CommandResult;

interface Draft {
  readonly draft: EquipmentElement;
  readonly templateKeys: readonly string[];
  readonly defaulted: readonly string[];
}

const hasDraft = (value: CommandResult | Draft): value is Draft => 'draft' in value;

/** The placement / naming fields every kind shares. */
const commonFields = (set: Params['set'], convention: AngleConvention): Partial<EquipmentElement> => ({
  ...(set.name === undefined ? {} : { name: set.name.trim() }),
  ...(set.location === undefined ? {} : { location: toVec2(set.location) }),
  ...(set.planRotationDeg === undefined ? {} : { angle: planRotationRadians(set.planRotationDeg, convention) }),
  ...(set.clearance === undefined ? {} : { clearance: set.clearance }),
});

function reviseVessel(
  element: EquipmentElement,
  plant: PlantEquipmentData,
  old: VesselTemplate,
  { set, angleConvention }: Params,
  fail: Fail,
): CommandResult | Draft {
  const input = vesselInputOf(old);
  const built = buildVesselTemplate({
    ...input,
    ...(set.insideDiameter === undefined ? {} : { insideDiameter: set.insideDiameter }),
    ...(set.tangentLength === undefined ? {} : { tangentLength: set.tangentLength }),
    ...(set.shellThickness === undefined ? {} : { shellThickness: set.shellThickness }),
    ...(set.headThickness === undefined ? {} : { headThickness: set.headThickness }),
    ...(set.corrosionAllowance === undefined ? {} : { corrosionAllowance: set.corrosionAllowance }),
    heads: { ...input.heads, ...set.heads },
    support: set.support ?? input.support,
  });
  if (isVesselIssue(built)) return fail(built.code, built.message, `set.${built.path}`);
  const template = {
    ...built.template,
    ...(old.trays === undefined ? {} : { trays: old.trays }),
    ...(old.platformClips === undefined ? {} : { platformClips: old.platformClips }),
  };
  const overflow = old.trays === undefined ? null : trayOverflow(old.trays, template.tangentLength);
  if (overflow !== null)
    return fail(
      'EQP_TRAYS_DONT_FIT',
      `the last tray (${overflow}) is above the new tangent length ${template.tangentLength}`,
      'set.tangentLength',
    );
  const clipAbove = (template.platformClips ?? []).findIndex((clip) => clip.elevation > template.tangentLength);
  if (clipAbove >= 0)
    return fail(
      'EQP_PARAM_INVALID',
      `platform clip ${clipAbove + 1} (elevation ${template.platformClips?.[clipAbove]?.elevation}) is above the new tangent length ${template.tangentLength}`,
      'set.tangentLength',
    );
  for (const nozzle of plant.nozzles) {
    const problem = nozzleProblem(template, nozzle);
    if (problem !== null) return fail(problem.code, `nozzle ${nozzle.mark}: ${problem.message}`, `nozzles.${nozzle.mark}.${problem.path}`);
  }
  const design: VesselDesignData | undefined = set.design === undefined ? plant.design : { ...plant.design, ...set.design };
  const levelIssue = liquidLevelIssue(template, design, 'set.');
  if (levelIssue !== null) return fail(levelIssue.code, levelIssue.message, levelIssue.path);
  const draft: EquipmentElement = {
    ...element,
    ...commonFields(set, angleConvention ?? 'north_cw'),
    plant: { ...plant, template, ...(design === undefined ? {} : { design }) },
  };
  return {
    draft,
    templateKeys: [
      ...TEMPLATE_KEYS.filter((key) => JSON.stringify(template[key]) !== JSON.stringify(old[key])),
      ...(JSON.stringify(design) === JSON.stringify(plant.design) ? [] : ['design']),
    ],
    defaulted: built.defaulted,
  };
}

/** Exchanger, tank or pump: merge the kind's patch, then re-validate every nozzle against the revised body. */
function reviseOther(
  doc: CadDocument,
  element: EquipmentElement,
  plant: PlantEquipmentData,
  params: Params,
  fail: Fail,
): CommandResult | Draft {
  const { exchanger, tank, pump, set, angleConvention } = params;
  const old = plant.template;
  let revision: Revision<EquipmentTemplate> | VesselIssue;
  if (old.kind === 'exchanger') revision = reviseExchanger(doc.units, old, plant.nozzles, exchanger ?? {});
  else if (old.kind === 'tank') revision = reviseTank(doc.units, old, plant.nozzles, tank ?? {});
  else if (old.kind === 'pump') revision = revisePump(doc, old, plant.nozzles, pump ?? {});
  else return fail('EQP_NOT_PARAMETRIC', `${element.mark} is a legacy block`, 'equipment');
  if (isVesselIssue(revision)) return fail(revision.code, revision.message, `${old.kind}.${revision.path}`);
  const { template, nozzles } = revision;
  for (const nozzle of nozzles) {
    const problem = nozzleProblem(template, nozzle);
    if (problem !== null) return fail(problem.code, `nozzle ${nozzle.mark}: ${problem.message}`, `nozzles.${nozzle.mark}.${problem.path}`);
  }
  const oldRecord = old as unknown as Record<string, unknown>;
  const newRecord = template as unknown as Record<string, unknown>;
  const changedKeys = [...new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)])].filter(
    (key) => !['defaulted', 'kind', 'tema'].includes(key) && JSON.stringify(oldRecord[key]) !== JSON.stringify(newRecord[key]),
  );
  const draft: EquipmentElement = {
    ...element,
    ...commonFields(set, angleConvention ?? 'north_cw'),
    plant: { ...plant, template, nozzles },
  };
  return {
    draft,
    templateKeys: [...changedKeys, ...(JSON.stringify(nozzles) === JSON.stringify(plant.nozzles) ? [] : ['nozzles'])],
    defaulted: 'defaulted' in template ? template.defaulted : [],
  };
}

/** The refusal of a patch that does not suit the kind of the equipment, or null. */
function patchMismatch(kind: EquipmentTemplate['kind'], { set, exchanger, tank, pump }: Params): { message: string; path: string } | null {
  const patches = { exchanger, tank, pump };
  const wrong = (['exchanger', 'tank', 'pump'] as const).find((name) => patches[name] !== undefined && name !== kind);
  if (wrong !== undefined) return { message: `'${wrong}' revises an equipment of that kind, this equipment is a ${kind}`, path: wrong };
  if (kind === 'vessel') return null;
  const vesselField = VESSEL_ONLY.find((name) => set[name] !== undefined);
  return vesselField === undefined
    ? null
    : { message: `set.${vesselField} revises a vessel; for a ${kind} give it inside '${kind}'`, path: `set.${vesselField}` };
}

/**
 * @affects regenerates 1 equipment (same element id, tag, nozzle marks and port ids) with its derived solids and re-derived size / shape / weight
 * @invariant shell nozzles keep their projection from the axis (vessels, tanks, exchangers) and head nozzles from the tangent line, so faces do not move when
 *   the diameter changes; pump SUC / DIS nozzles follow the envelope; movedPorts lists every port whose position changed (connected routes are stretched by
 *   the piping reconcile); every nozzle is re-validated against the new body; the creation builder of the kind validates the merged input
 * @failure unknown equipment -> EQP_NOT_FOUND; legacy block -> EQP_NOT_PARAMETRIC; invalid values / a nozzle that no longer fits / a patch of another kind
 *   -> coded refusal and the document is unchanged; nothing changes -> no-op
 */
export const updateEquipmentParameters = defineCommand({
  name: COMMAND,
  description:
    'Revise a parametric vessel, heat exchanger, storage tank or pump (from add_vessel / add_process_column / add_heat_exchanger / add_storage_tank / add_pump) in place. ' +
    'Common fields in set { name, location, planRotationDeg, clearance }; vessel fields in set { insideDiameter, tangentLength, heads, shellThickness, headThickness, ' +
    'corrosionAllowance, support, design }; an exchanger, tank or pump takes its own patch object { exchanger | tank | pump } with the fields of its add_* command (partial: ' +
    'omitted fields are kept, nested objects merge field by field). The element id, tag, nozzle marks and port ids "<tag>:<mark>" are kept; geometry, size, shape and ' +
    'weight are re-derived and the add_* validation applies to the merged input. Shell nozzles keep their projection from the axis and head nozzles from the tangent ' +
    'line, so a diameter change does not move the flange faces of nozzles that still fit; a pump re-places its SUC / DIS nozzles on the new envelope. Every nozzle is ' +
    're-validated (EQP_NOZZLE_OFF_BODY / EQP_NOZZLE_PROJECTION_TOO_SHORT refuse the whole edit). Routes connected to a moved port are stretched like a moved equipment ' +
    '(see the summary). Returns changed[], movedPorts[{ id, from, to }], connectedPipes[], angleConvention. Refusals: EQP_NOT_FOUND, EQP_NOT_PARAMETRIC (legacy box ' +
    'equipment), EQP_PARAM_INVALID (also a patch of another kind), EQP_HEAD_INVALID, EQP_SUPPORT_INVALID, EQP_TEMA_INVALID, EQP_PUMP_SIZE_UNKNOWN, EQP_TRAYS_DONT_FIT.',
  params: z.object({
    equipment: equipmentRefParam,
    set: changeSet.optional(),
    exchanger: exchangerPatchSchema.optional(),
    tank: tankPatchSchema.optional(),
    pump: pumpPatchSchema.optional(),
    angleConvention: angleConventionParam,
  }),
  run: (doc, input): CommandResult => {
    const params: Params = { ...input, set: input.set ?? {} };
    const { equipment, set, angleConvention } = params;
    const building = getBuilding(doc);
    const element = findEquipment(building, equipment);
    if (element === undefined)
      return refuse(doc, COMMAND, 'EQP_NOT_FOUND', `no equipment with tag or id '${equipment}'`, [], ['equipment']);
    const plant = element.plant;
    if (plant === undefined || plant.template.kind === 'block')
      return refuse(
        doc,
        COMMAND,
        'EQP_NOT_PARAMETRIC',
        `${element.mark} (${element.id}) is a legacy block, not a parametric vessel, exchanger, tank or pump: recreate it with add_vessel / add_heat_exchanger / add_storage_tank / add_pump`,
        [element.id],
        ['equipment'],
      );
    const fail: Fail = (code, message, path) => refuse(doc, COMMAND, code, message, [element.id], [path]);
    const mismatch = patchMismatch(plant.template.kind, params);
    if (mismatch !== null) return fail('EQP_PARAM_INVALID', mismatch.message, mismatch.path);
    if (set.location !== undefined && !isVec2(set.location))
      return fail('EQP_PARAM_INVALID', 'location must be [x, y] with finite numbers', 'set.location');
    const convention: AngleConvention = angleConvention ?? 'north_cw';
    const old = plant.template;
    const revised =
      old.kind === 'vessel' ? reviseVessel(element, plant, old, params, fail) : reviseOther(doc, element, plant, params, fail);
    if (!hasDraft(revised)) return revised;
    const { element: next, notes } = withLegacyFields(doc, revised.draft);
    const changed = [
      ...(['name', 'location', 'clearance'] as const).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(element[key])),
      ...(next.angle === element.angle ? [] : ['planRotationDeg']),
      ...revised.templateKeys,
    ];
    if (changed.length === 0) return noop(doc, `${COMMAND}: ${element.mark} already has these values; nothing changed.`);
    const before = portPositions(equipmentPorts(building, element));
    const movedPorts = equipmentPorts(building, next).flatMap((port) => {
      const was = before.get(port.id);
      const distance = was === undefined ? 0 : Math.hypot(...port.position.map((value, index) => value - (was.position[index] as number)));
      return was !== undefined && distance > MOVED ? [{ id: port.id, from: was.position, to: port.position, distance }] : [];
    });
    const connectedPipes = [...new Set(movedPorts.flatMap((port) => connectedPipeIds(building, port.id)))];
    return commitBuilding(
      doc,
      withElement(building, next),
      [next.id],
      `${COMMAND}: ${next.mark} (${next.id}) changed ${changed.join(', ')}; ${movedPorts.length} port(s) moved, ${next.weight.toFixed(1)} kg operating (angleConvention ${convention}).`,
      {
        elementId: next.id,
        tag: next.mark,
        kind: old.kind,
        changed,
        defaulted: revised.defaulted,
        movedPorts,
        connectedPipes,
        portIds: (next.plant?.nozzles ?? []).map((nozzle) => `${next.mark}:${nozzle.mark}`),
        weightKg: next.weight,
        size: next.size,
        notes,
        planRotationDeg: planRotationDegrees(next.angle, convention),
        angleConvention: convention,
      },
    );
  },
});
