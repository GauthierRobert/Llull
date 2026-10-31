import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { equipmentClass } from '../authoring/classes';
import { makeNozzle, nozzleOffset, nozzleParam, portOf, sideKey } from '../authoring/nozzles';
import { Draft, checkTag, fail, findSheet, isFail, refuse, mintFree } from '../authoring/refs';
import { attributesParam, toValues } from '../authoring/values';
import type { PidEquipment, PidNozzle } from '../model';
import { getPid, withPid } from '../state';

/**
 * @affects plant.pid (one equipment item and its nozzles)
 * @invariant tag unique in the document; nozzle sub-tags unique per equipment; ports lie on the symbol box (half extents by class) rotated about the centre
 * @failure sheet unknown -> PID_SHEET_NOT_FOUND; class not in the library -> PID_CLASS_UNKNOWN (close names); tag used -> PID_TAG_DUPLICATE; bad tag -> PID_TAG_FORMAT; repeated sub-tag -> PID_TAG_DUPLICATE; document unchanged
 */
export const addPidEquipment = defineCommand({
  name: 'add_pid_equipment',
  description:
    'Place a piece of equipment (tank, vessel, pump, exchanger, ...) on a P&ID sheet with its nozzles. `class` is a DEXPI equipment class (Tank, PressureVessel, ' +
    'ProcessColumn, CentrifugalPump, ReciprocatingPump, RotaryPump, PlateHeatExchanger, TubularHeatExchanger, Compressor, Blower, Fan, Filter, Agitator, Mixer ...). ' +
    '`at` is the symbol centre in sheet millimetres (+y up). Each nozzle is placed on a side (left, right, top = +y, bottom = -y) or at an offset from the centre; ' +
    'its port is the connection point lines attach to. Returns affected = [equipment id, nozzle ids in order]; the equipment id is affected[0]. data = { equipment, nozzles: ' +
    '[{ id, subTag, port }] }. Refusals (document unchanged): PID_SHEET_NOT_FOUND, PID_CLASS_UNKNOWN (close names listed), PID_TAG_DUPLICATE, PID_TAG_FORMAT. ' +
    'Next: add_pid_line from {tag, nozzle}.',
  params: z.object({
    sheet: z.string().min(1).describe('Sheet number (e.g. "PID-001") or sheet id (the alias of create_pid_sheet).'),
    class: z.string().min(1).describe('DEXPI equipment class, e.g. "Tank", "CentrifugalPump".'),
    tag: z.string().min(1).describe('Equipment tag, unique in the document, e.g. "T-101" (1 to 64 characters).'),
    at: vec2('Symbol centre on the sheet, millimetres [x, y].'),
    rotationDeg: z
      .number()
      .optional()
      .describe('Rotation in degrees counter-clockwise about the centre (default 0); nozzle ports rotate with it.'),
    attributes: attributesParam,
    nozzles: z.array(nozzleParam).optional().describe('Nozzles to create with the equipment: { subTag, side, dn?, access? }.'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'add_pid_equipment';
    const pid = getPid(doc);
    const sheet = findSheet(pid, params.sheet);
    if (isFail(sheet)) return refuse(doc, name, sheet);
    const dexpiClass = equipmentClass(params.class, 'class');
    if (isFail(dexpiClass)) return refuse(doc, name, dexpiClass);
    const tag = checkTag(pid, params.tag, 'equipment', 'tag');
    if (isFail(tag)) return refuse(doc, name, tag);
    const specs = params.nozzles ?? [];
    const repeated = specs.find((spec, i) => specs.findIndex((other) => other.subTag === spec.subTag) !== i);
    if (repeated !== undefined)
      return refuse(doc, name, fail('PID_TAG_DUPLICATE', `nozzle sub-tag "${repeated.subTag}" is used twice on ${tag}`, ['nozzles']));
    const equipment: PidEquipment = {
      id: mintFree(pid),
      kind: 'equipment',
      sheetId: sheet.id,
      at: params.at,
      rotationDeg: params.rotationDeg ?? 0,
      dexpiClass,
      tag,
      attributes: toValues(params.attributes),
    };
    const perSide = new Map<string, number>();
    for (const spec of specs) perSide.set(sideKey(spec.side), (perSide.get(sideKey(spec.side)) ?? 0) + 1);
    const seen = new Map<string, number>();
    const nozzles: PidNozzle[] = specs.map((spec) => {
      const key = sideKey(spec.side);
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      return makeNozzle(
        mintFree(pid),
        equipment,
        spec,
        portOf(equipment, nozzleOffset(dexpiClass, spec.side, index, perSide.get(key) ?? 1)),
      );
    });
    const draft = new Draft(pid);
    draft.put(equipment);
    nozzles.forEach((nozzle) => draft.put(nozzle));
    return {
      document: withPid(doc, draft.model()),
      summary: `add_pid_equipment: ${dexpiClass} ${tag} (${equipment.id}) on ${sheet.number} at [${params.at.join(', ')}] with ${nozzles.length} nozzle(s)`,
      affected: [equipment.id, ...nozzles.map((n) => n.id)],
      data: { equipment: equipment.id, nozzles: nozzles.map((n) => ({ id: n.id, subTag: n.subTag, port: n.port })) },
    };
  },
});
