import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { isValveClass } from '../authoring/classes';
import { splitInstrumentTag, tagRefusal } from '../authoring/instrumentTag';
import { moveEquipment, rerouteEnds } from '../authoring/move';
import { Draft, checkTag, fail, findAny, isFail, refuse, segmentsOf } from '../authoring/refs';
import { attributesParam, toValues } from '../authoring/values';
import type { PidItem, PidItemKind } from '../model';
import { getPid, withPid } from '../state';

type SetField = 'tag' | 'attributes' | 'dn' | 'pipingClass' | 'fluidCode' | 'lineNumber' | 'at' | 'rotationDeg';

const MOVABLE: readonly PidItemKind[] = ['equipment', 'instrument', 'opc', 'actuating', 'annotation', 'loop'];
const APPLIES: Readonly<Record<SetField, readonly PidItemKind[]>> = {
  tag: ['equipment', 'inline', 'instrument', 'actuating'],
  attributes: ['equipment', 'nozzle', 'line', 'segment', 'inline', 'instrument', 'loop', 'signal', 'actuating', 'opc', 'annotation'],
  dn: ['nozzle', 'line', 'segment', 'inline'],
  pipingClass: ['line', 'segment', 'inline'],
  fluidCode: ['line'],
  lineNumber: ['line'],
  at: MOVABLE,
  rotationDeg: MOVABLE,
};

/**
 * @affects plant.pid (one item; moving equipment moves its nozzle ports and sub-equipment, attached segments / signals re-route their end legs; a line's dn / pipingClass propagate to the segments that carried the old value)
 * @invariant a field only applies to the kinds that have it; tag and line number stay unique; the item keeps its id and kind; an instrument tag is re-split (category, functions, loopNumber)
 * @failure item not found -> PID_ITEM_NOT_FOUND; field not applicable -> PID_ITEM_KIND; tag used -> PID_TAG_DUPLICATE; bad tag -> PID_TAG_FORMAT; line number used -> PID_LINE_NUMBER_DUPLICATE; empty set -> PID_PARAM_INVALID; document unchanged
 */
export const updatePidItem = defineCommand({
  name: 'update_pid_item',
  description:
    'Edit one P&ID item by tag or id: `set` carries the fields to change. tag (equipment, inline component, instrument, actuating system; unique), attributes (any item; merged by name), dn ' +
    '(nozzle, line, segment, inline; DN integer), pipingClass (line, segment, inline), fluidCode and lineNumber (line; the number is unique), at [x, y] sheet mm and rotationDeg ' +
    '(equipment, instrument, off-page connector, actuating system; moving equipment moves its nozzles and sub-equipment, and the lines and signals attached to a moved port re-route their end legs). ' +
    'Changing a line dn / pipingClass also changes the segments that carried the old value. Inline components cannot be moved: delete_pid_item and add_pid_inline. Returns affected = the item and what moved with it; ' +
    'data = { item, changed: [field names] }. Refusals (document unchanged): PID_ITEM_NOT_FOUND, PID_ITEM_KIND (field does not apply), PID_TAG_DUPLICATE, PID_TAG_FORMAT, PID_LINE_NUMBER_DUPLICATE, PID_PARAM_INVALID (empty set).',
  params: z.object({
    item: z.string().min(1).describe('Tag, item id or line number of the item to edit.'),
    set: z
      .object({
        tag: z.string().min(1).optional().describe('New tag, unique in the document.'),
        attributes: attributesParam,
        dn: z.number().int().positive().optional().describe('New nominal size, DN integer.'),
        pipingClass: z.string().trim().min(1).optional().describe('New piping class.'),
        fluidCode: z.string().trim().min(1).optional().describe('New fluid code (lines).'),
        lineNumber: z.string().trim().min(1).optional().describe('New line number, unique among lines (lines).'),
        at: vec2('New position on the sheet, millimetres [x, y].').optional(),
        rotationDeg: z.number().optional().describe('New rotation, degrees counter-clockwise.'),
      })
      .describe('Fields to change; at least one.'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'update_pid_item';
    const pid = getPid(doc);
    const item = findAny(pid, params.item, 'item');
    if (isFail(item)) return refuse(doc, name, item);
    const fields = (Object.keys(params.set) as SetField[]).filter((field) => params.set[field] !== undefined);
    if (fields.length === 0) return refuse(doc, name, fail('PID_PARAM_INVALID', 'set is empty: give at least one field', ['set']));
    const misplaced = fields.find((field) => !APPLIES[field].includes(item.kind));
    if (misplaced !== undefined)
      return refuse(
        doc,
        name,
        fail(
          'PID_ITEM_KIND',
          `${misplaced} does not apply to a ${item.kind} (it applies to ${APPLIES[misplaced].join(', ')})`,
          [`set.${misplaced}`],
          [item.id],
        ),
      );
    const set = params.set;
    const draft = new Draft(pid);
    const affected = [item.id];
    let next: PidItem = item;

    if (set.tag !== undefined) {
      const kind =
        item.kind === 'equipment'
          ? 'equipment'
          : item.kind === 'instrument'
            ? 'instrument'
            : item.kind === 'inline' && isValveClass(item.dexpiClass)
              ? 'valve'
              : undefined;
      const tag = checkTag(pid, set.tag, kind, 'set.tag', item.id);
      if (isFail(tag)) return refuse(doc, name, tag);
      next = { ...next, tag };
      if (next.kind === 'instrument') {
        const parts = splitInstrumentTag(tag);
        if (parts === undefined) return refuse(doc, name, fail('PID_TAG_FORMAT', tagRefusal(tag), ['set.tag']));
        next = { ...next, category: parts.category, functions: parts.functions, loopNumber: parts.loopNumber };
      }
    }
    if (set.lineNumber !== undefined && next.kind === 'line') {
      const taken = pid.itemOrder.some(
        (id) =>
          id !== item.id && pid.items[id]?.kind === 'line' && (pid.items[id] as { lineNumber?: string }).lineNumber === set.lineNumber,
      );
      if (taken)
        return refuse(
          doc,
          name,
          fail('PID_LINE_NUMBER_DUPLICATE', `line number "${set.lineNumber}" is used by another line`, ['set.lineNumber']),
        );
      next = { ...next, lineNumber: set.lineNumber };
    }
    if (next.kind === 'line') {
      const oldLine = next;
      if (set.fluidCode !== undefined) next = { ...next, fluidCode: set.fluidCode };
      if (set.dn !== undefined) next = { ...next, dn: set.dn };
      if (set.pipingClass !== undefined) next = { ...next, pipingClass: set.pipingClass };
      for (const segment of segmentsOf(pid, oldLine)) {
        const dn = set.dn !== undefined && (segment.dn === undefined || segment.dn === oldLine.dn) ? set.dn : segment.dn;
        const pipingClass =
          set.pipingClass !== undefined && (segment.pipingClass === undefined || segment.pipingClass === oldLine.pipingClass)
            ? set.pipingClass
            : segment.pipingClass;
        if (dn !== segment.dn || pipingClass !== segment.pipingClass) {
          draft.put({ ...segment, ...(dn === undefined ? {} : { dn }), ...(pipingClass === undefined ? {} : { pipingClass }) });
          affected.push(segment.id);
        }
      }
    } else {
      if (set.dn !== undefined && (next.kind === 'nozzle' || next.kind === 'segment' || next.kind === 'inline'))
        next = { ...next, dn: set.dn };
      if (set.pipingClass !== undefined && (next.kind === 'segment' || next.kind === 'inline'))
        next = { ...next, pipingClass: set.pipingClass };
    }
    if (set.attributes !== undefined) next = { ...next, attributes: { ...next.attributes, ...toValues(set.attributes) } };

    if ((set.at !== undefined || set.rotationDeg !== undefined) && next.kind === 'equipment') {
      draft.put(next);
      const moved = next;
      affected.push(...moveEquipment(draft, moved, set.at ?? moved.at, set.rotationDeg ?? moved.rotationDeg).slice(1));
    } else {
      if (set.at !== undefined) next = { ...next, at: set.at };
      if (set.rotationDeg !== undefined) next = { ...next, rotationDeg: set.rotationDeg };
      draft.put(next);
      if (set.at !== undefined && (next.kind === 'instrument' || next.kind === 'opc' || next.kind === 'actuating'))
        rerouteEnds(draft, new Map([[next.id, set.at]]));
    }
    return {
      document: withPid(doc, draft.model()),
      summary: `update_pid_item: ${item.kind} ${item.tag ?? item.id} set ${fields.join(', ')}${affected.length > 1 ? ` (${affected.length} items changed)` : ''}`,
      affected,
      data: { item: item.id, changed: fields },
    };
  },
});
