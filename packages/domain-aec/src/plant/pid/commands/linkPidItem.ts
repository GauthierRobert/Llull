import { elementsOf, getBuilding } from '@aec/building/model';
import type { BuildingElement } from '@aec/building/types';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { fail, findAny, isFail, refuse } from '../authoring/refs';
import { dropLinks } from '../link3d/links';
import { getPid, withPid } from '../state';

const WANTED = { equipment: 'equipment', line: 'pipe' } as const;

/**
 * @affects plant.pid.links (one pair pid item -> building element id, replaced or cleared)
 * @invariant only an equipment links to building equipment and a line to a pipe run; an element is linked to one P&ID item; the pair wins over tag matching in check_pid_3d; delete_pid_item drops the links of what it removes
 * @failure P&ID item unknown -> PID_ITEM_NOT_FOUND; kind not equipment / line, or element of the wrong category -> PID_ITEM_KIND; element unknown -> PID_ITEM_NOT_FOUND; same pair again or element already linked elsewhere -> PID_LINK_DUPLICATE; clearing an absent link -> PID_LINK_NOT_FOUND; document unchanged
 */
export const linkPidItem = defineCommand({
  name: 'link_pid_item',
  description:
    'Pair a P&ID item with a 3D object explicitly, or clear the pair (element null). check_pid_3d uses these pairs before it matches tags, so use it when the tag or line number differs between the drawing and the 3D model, ' +
    'or to resolve P3D_TAG_AMBIGUOUS. A P&ID equipment links to a building equipment element (add_equipment), a P&ID line to a pipe run (add_pipe_run); other kinds are refused. Linking an item that already has another link replaces it. ' +
    'Returns affected = [P&ID item id]; data = { pidItem, element, previous? }. Refusals (document unchanged): PID_ITEM_NOT_FOUND, PID_ITEM_KIND, PID_LINK_DUPLICATE, PID_LINK_NOT_FOUND. Next: check_pid_3d.',
  params: z.object({
    pidItem: z.string().min(1).describe('P&ID equipment (tag or id) or line (line number or id) to link.'),
    element: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Building element id (e.g. "equipment-1", "pipe-2") or its mark of the matching category: equipment for equipment, pipe for a line. null removes the existing link of the item.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const name = 'link_pid_item';
    const pid = getPid(doc);
    const item = findAny(pid, params.pidItem, 'pidItem');
    if (isFail(item)) return refuse(doc, name, item);
    if (item.kind !== 'equipment' && item.kind !== 'line')
      return refuse(
        doc,
        name,
        fail('PID_ITEM_KIND', `${params.pidItem} is a ${item.kind}; only equipment and lines link to 3D objects`, ['pidItem'], [item.id]),
      );
    const links = pid.links ?? {};
    const previous = Object.hasOwn(links, item.id) ? links[item.id] : undefined;
    const label = item.tag ?? ('lineNumber' in item ? item.lineNumber : undefined) ?? item.id;
    if (params.element === null) {
      if (previous === undefined)
        return refuse(doc, name, fail('PID_LINK_NOT_FOUND', `${label} has no explicit link`, ['element'], [item.id]));
      return {
        document: withPid(doc, dropLinks(pid, [item.id])),
        summary: `link_pid_item: cleared the link of ${label} (was ${previous})`,
        affected: [item.id],
        data: { pidItem: item.id, element: null, previous },
      };
    }
    const building = getBuilding(doc);
    const wanted = WANTED[item.kind];
    const ref = params.element;
    const byId: BuildingElement | undefined = Object.hasOwn(building.elements, ref) ? building.elements[ref] : undefined;
    const element = byId ?? elementsOf(building, wanted).find((e) => e.mark === ref);
    if (element === undefined)
      return refuse(doc, name, fail('PID_ITEM_NOT_FOUND', `no building element with id or mark "${ref}"`, ['element']));
    if (element.category !== wanted)
      return refuse(
        doc,
        name,
        fail('PID_ITEM_KIND', `${element.id} is a ${element.category}; a P&ID ${item.kind} links to a ${wanted}`, ['element'], [item.id]),
      );
    const owner = Object.entries(links).find(([, target]) => target === element.id);
    if (owner !== undefined)
      return refuse(
        doc,
        name,
        fail(
          'PID_LINK_DUPLICATE',
          owner[0] === item.id ? `${label} is already linked to ${element.id}` : `${element.id} is already linked to P&ID item ${owner[0]}`,
          ['element'],
          [item.id, owner[0]],
        ),
      );
    return {
      document: withPid(doc, { ...pid, links: { ...links, [item.id]: element.id } }),
      summary: `link_pid_item: linked ${label} (${item.id}) to ${element.category} ${element.mark} (${element.id})${previous === undefined ? '' : `, replacing ${previous}`}`,
      affected: [item.id],
      data: { pidItem: item.id, element: element.id, ...(previous === undefined ? {} : { previous }) },
    };
  },
});
