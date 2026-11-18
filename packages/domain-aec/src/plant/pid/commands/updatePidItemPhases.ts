import type { Vec2 } from '@core/model/vectors';
import { isValveClass } from '../authoring/classes';
import { splitInstrumentTag, tagRefusal } from '../authoring/instrumentTag';
import { moveEquipment, rerouteEnds } from '../authoring/move';
import { type Draft, type Fail, checkTag, fail, isFail, segmentsOf } from '../authoring/refs';
import type { toValues } from '../authoring/values';
import type { PidItem, PidLine, PidModel } from '../model';

type AttributeParam = Parameters<typeof toValues>[0];

export interface PidSet {
  readonly tag?: string | undefined;
  readonly attributes?: AttributeParam;
  readonly dn?: number | undefined;
  readonly pipingClass?: string | undefined;
  readonly fluidCode?: string | undefined;
  readonly lineNumber?: string | undefined;
  readonly at?: Vec2 | undefined;
  readonly rotationDeg?: number | undefined;
}

/** The item with its new tag (an instrument tag re-split into category, functions, loop number), or the refusal. */
export function withTag(pid: PidModel, item: PidItem, current: PidItem, newTag: string): PidItem | Fail {
  const kind =
    item.kind === 'equipment'
      ? 'equipment'
      : item.kind === 'instrument'
        ? 'instrument'
        : item.kind === 'inline' && isValveClass(item.dexpiClass)
          ? 'valve'
          : undefined;
  const tag = checkTag(pid, newTag, kind, 'set.tag', item.id);
  if (isFail(tag)) return tag;
  let next: PidItem = { ...current, tag };
  if (next.kind === 'instrument') {
    const parts = splitInstrumentTag(tag);
    if (parts === undefined) return fail('PID_TAG_FORMAT', tagRefusal(tag), ['set.tag']);
    next = { ...next, category: parts.category, functions: parts.functions, loopNumber: parts.loopNumber };
  }
  return next;
}

/** The line with its new number, or the refusal when another line already has it. */
export function withLineNumber(pid: PidModel, item: PidItem, current: PidLine, lineNumber: string): PidLine | Fail {
  const taken = pid.itemOrder.some(
    (id) => id !== item.id && pid.items[id]?.kind === 'line' && (pid.items[id] as { lineNumber?: string }).lineNumber === lineNumber,
  );
  if (taken) return fail('PID_LINE_NUMBER_DUPLICATE', `line number "${lineNumber}" is used by another line`, ['set.lineNumber']);
  return { ...current, lineNumber };
}

/** dn / pipingClass / fluidCode: on a line they also propagate to the segments that carried the old value (written to `draft`, ids to `affected`). */
export function withSizing(pid: PidModel, draft: Draft, current: PidItem, set: PidSet, affected: string[]): PidItem {
  let next = current;
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
  return next;
}

/** Writes the item to the draft with its new position / rotation: equipment moves its ports, sub-equipment and attached legs. */
export function placeItem(draft: Draft, current: PidItem, set: PidSet, affected: string[]): void {
  let next = current;
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
}
