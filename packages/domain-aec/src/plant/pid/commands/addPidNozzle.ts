import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import type { Vec2 } from '@core/model/vectors';
import { distance } from '../authoring/geometry';
import { makeNozzle, nozzleOffset, portOf, sideParam } from '../authoring/nozzles';
import { Draft, fail, findItem, isFail, mintFree, refuse } from '../authoring/refs';
import { getPid, withPid } from '../state';

/**
 * @affects plant.pid (one nozzle on an existing equipment)
 * @invariant sub-tag unique per equipment; a port that would sit on an existing nozzle is shifted along the side in 10 mm steps
 * @failure equipment not found -> PID_ITEM_NOT_FOUND; not an equipment -> PID_ITEM_KIND; sub-tag used -> PID_TAG_DUPLICATE; neither or both of side / at -> PID_PARAM_INVALID; document unchanged
 */
export const addPidNozzle = defineCommand({
  name: 'add_pid_nozzle',
  description:
    'Add one nozzle to an existing equipment (add_pid_equipment can create them with the equipment). Give either `side` (left, right, top = +y, bottom = -y, ' +
    'or an offset [dx, dy] from the centre) or `at` (an absolute point on the sheet, millimetres). A side position already taken by another nozzle is shifted by 10 mm. ' +
    'Returns affected[0] = the nozzle id; data = { nozzle, port }. Refusals (document unchanged): PID_ITEM_NOT_FOUND, PID_ITEM_KIND (not an equipment), ' +
    'PID_TAG_DUPLICATE (sub-tag used on this equipment), PID_PARAM_INVALID. Next: add_pid_line.',
  params: z.object({
    equipment: z.string().min(1).describe('Equipment tag (e.g. "P-101") or item id.'),
    subTag: z.string().trim().min(1).describe('Nozzle sub-tag, unique on the equipment (e.g. "N3").'),
    side: sideParam.optional(),
    at: vec2('Absolute nozzle position on the sheet, millimetres; use instead of `side`.').optional(),
    dn: z.number().int().positive().optional().describe('Nozzle nominal size, DN integer.'),
    access: z.boolean().optional().describe('True for a manhole / access nozzle.'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'add_pid_nozzle';
    const pid = getPid(doc);
    const equipment = findItem(pid, params.equipment, 'equipment');
    if (isFail(equipment)) return refuse(doc, name, equipment);
    if (equipment.kind !== 'equipment')
      return refuse(doc, name, fail('PID_ITEM_KIND', `${params.equipment} is a ${equipment.kind}, not an equipment`, ['equipment']));
    if ((params.side === undefined) === (params.at === undefined))
      return refuse(doc, name, fail('PID_PARAM_INVALID', 'give exactly one of side and at', ['side', 'at']));
    const owned = pid.itemOrder.flatMap((id) => {
      const item = pid.items[id];
      return item?.kind === 'nozzle' && item.equipmentId === equipment.id ? [item] : [];
    });
    if (owned.some((nozzle) => nozzle.subTag === params.subTag))
      return refuse(
        doc,
        name,
        fail('PID_TAG_DUPLICATE', `${equipment.tag ?? equipment.id} already has a nozzle ${params.subTag}`, ['subTag']),
      );
    let port: Vec2 = params.at ?? portOf(equipment, nozzleOffset(equipment.dexpiClass, params.side ?? 'left', 0, 1));
    if (params.at === undefined && typeof params.side === 'string') {
      const vertical = params.side === 'left' || params.side === 'right';
      for (let step = 1; owned.some((n) => distance(n.port, port) < 1) && step <= owned.length; step++)
        port = vertical ? [port[0], port[1] + 10] : [port[0] + 10, port[1]];
    }
    const nozzle = makeNozzle(
      mintFree(pid),
      equipment,
      {
        subTag: params.subTag,
        ...(params.dn === undefined ? {} : { dn: params.dn }),
        ...(params.access === undefined ? {} : { access: params.access }),
      },
      port,
    );
    const draft = new Draft(pid);
    draft.put(nozzle);
    return {
      document: withPid(doc, draft.model()),
      summary: `add_pid_nozzle: nozzle ${equipment.tag ?? equipment.id}/${params.subTag} (${nozzle.id}) at [${port.join(', ')}]`,
      affected: [nozzle.id],
      data: { nozzle: nozzle.id, port },
    };
  },
});
