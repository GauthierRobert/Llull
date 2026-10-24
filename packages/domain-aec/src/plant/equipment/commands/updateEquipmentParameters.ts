import type { EquipmentElement } from '@aec/building/types';
import { defineCommand, looseVec2, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { getBuilding, isVec2, toVec2, withElement } from '../../../building/model';
import { nozzleProblem } from '../geometry/nozzleChecks';
import { equipmentPorts, type ConnectionPort } from '../geometry/ports';
import { refuse } from '../model';
import type { VesselDesignData } from '../plantData';
import { angleConventionParam, planRotationDegrees, planRotationRadians, type AngleConvention } from './angles';
import { trayOverflow } from './columnParams';
import { connectedPipeIds, equipmentRefParam, findEquipment } from './equipmentRef';
import { withLegacyFields } from './legacySync';
import {
  buildVesselTemplate,
  designInputSchema,
  headsInputSchema,
  isVesselIssue,
  liquidLevelIssue,
  supportInputSchema,
  vesselInputOf,
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

/**
 * @affects regenerates 1 equipment (same element id, tag, nozzle marks and port ids) with its derived solids and re-derived size / shape / weight
 * @invariant shell nozzle projections stay axis-to-face and head projections tangent-line-to-face, so faces do not move when the diameter changes;
 *   movedPorts lists every port whose position changed; every nozzle is re-validated against the new body
 * @failure unknown equipment -> EQP_NOT_FOUND; legacy block -> EQP_NOT_PARAMETRIC; invalid values / a nozzle that no longer fits -> coded refusal
 *   and the document is unchanged; nothing changes -> no-op
 */
export const updateEquipmentParameters = defineCommand({
  name: 'update_equipment_parameters',
  description:
    'Revise a parametric vessel (from add_vessel / add_process_column) in place: set { name, location, planRotationDeg, insideDiameter, tangentLength, heads, ' +
    'shellThickness, headThickness, corrosionAllowance, support, design, clearance }; omitted fields are kept. The element id, tag, nozzle marks and ' +
    'port ids "<tag>:<mark>" are kept; geometry, size, shape and weight are re-derived. Shell nozzles keep their projection from the axis and head ' +
    'nozzles from the tangent line, so a diameter change does not move the flange faces of nozzles that still fit. Every nozzle is re-validated ' +
    '(EQP_NOZZLE_OFF_BODY / EQP_NOZZLE_PROJECTION_TOO_SHORT refuse the whole edit). Returns changed[], movedPorts[{ id, from, to }], connectedPipes[], ' +
    'angleConvention. Refusals: EQP_NOT_FOUND, EQP_NOT_PARAMETRIC (legacy box equipment), EQP_PARAM_INVALID, EQP_HEAD_INVALID, EQP_SUPPORT_INVALID, ' +
    'EQP_TRAYS_DONT_FIT.',
  params: z.object({ equipment: equipmentRefParam, set: changeSet, angleConvention: angleConventionParam }),
  run: (doc, { equipment, set, angleConvention }): CommandResult => {
    const building = getBuilding(doc);
    const element = findEquipment(building, equipment);
    if (element === undefined)
      return refuse(doc, 'update_equipment_parameters', 'EQP_NOT_FOUND', `no equipment with tag or id '${equipment}'`, [], ['equipment']);
    const plant = element.plant;
    if (plant === undefined || plant.template.kind !== 'vessel')
      return refuse(
        doc,
        'update_equipment_parameters',
        'EQP_NOT_PARAMETRIC',
        `${element.mark} (${element.id}) is a legacy block, not a parametric vessel`,
        [element.id],
        ['equipment'],
      );
    const convention: AngleConvention = angleConvention ?? 'north_cw';
    const old = plant.template;
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
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuse(doc, 'update_equipment_parameters', code, message, [element.id], [path]);
    if (isVesselIssue(built)) return fail(built.code, built.message, `set.${built.path}`);
    if (set.location !== undefined && !isVec2(set.location))
      return fail('EQP_PARAM_INVALID', 'location must be [x, y] with finite numbers', 'set.location');
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
      if (problem !== null)
        return fail(problem.code, `nozzle ${nozzle.mark}: ${problem.message}`, `nozzles.${nozzle.mark}.${problem.path}`);
    }
    const design: VesselDesignData | undefined = set.design === undefined ? plant.design : { ...plant.design, ...set.design };
    const levelIssue = liquidLevelIssue(template, design, 'set.');
    if (levelIssue !== null) return fail(levelIssue.code, levelIssue.message, levelIssue.path);
    const draft: EquipmentElement = {
      ...element,
      ...(set.name === undefined ? {} : { name: set.name.trim() }),
      ...(set.location === undefined ? {} : { location: toVec2(set.location) }),
      ...(set.planRotationDeg === undefined ? {} : { angle: planRotationRadians(set.planRotationDeg, convention) }),
      ...(set.clearance === undefined ? {} : { clearance: set.clearance }),
      plant: { ...plant, template, ...(design === undefined ? {} : { design }) },
    };
    const { element: next, notes } = withLegacyFields(doc, draft);
    const changed = [
      ...(['name', 'location', 'clearance'] as const).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(element[key])),
      ...(next.angle === element.angle ? [] : ['planRotationDeg']),
      ...TEMPLATE_KEYS.filter((key) => JSON.stringify(template[key]) !== JSON.stringify(old[key])),
      ...(JSON.stringify(design) === JSON.stringify(plant.design) ? [] : ['design']),
    ];
    if (changed.length === 0) return noop(doc, `update_equipment_parameters: ${element.mark} already has these values; nothing changed.`);
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
      `update_equipment_parameters: ${next.mark} (${next.id}) changed ${changed.join(', ')}; ${movedPorts.length} port(s) moved, ${next.weight.toFixed(1)} kg operating (angleConvention ${convention}).`,
      {
        elementId: next.id,
        tag: next.mark,
        changed,
        defaulted: built.defaulted,
        movedPorts,
        connectedPipes,
        portIds: plant.nozzles.map((nozzle) => `${next.mark}:${nozzle.mark}`),
        weightKg: next.weight,
        size: next.size,
        notes,
        planRotationDeg: planRotationDegrees(next.angle, convention),
        angleConvention: convention,
      },
    );
  },
});
