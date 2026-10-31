/** `check_pid` rules on tags, lines and devices: duplicate / nonstandard tags, missing line numbers, valves without actuators or set pressure, unconnected instruments (§5.5). */

import { sourceClass } from '../lists/counts';
import { buildTagRegistry } from '../tags/registry';
import { parseTag } from '../tags/parseTag';
import type { CheckContext } from './context';
import { itemLabel, makeFinding, type Finding } from './finding';

export function tagDuplicate(ctx: CheckContext, sheetId?: string): Finding[] {
  const out: Finding[] = [];
  for (const items of buildTagRegistry(ctx.pid).values()) {
    const first = items[0];
    if (items.length < 2 || first === undefined) continue;
    if (sheetId !== undefined && !items.some((item) => item.sheetId === sheetId)) continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_TAG_DUPLICATE',
        ids: items.map((item) => item.id),
        item: itemLabel(first),
        message: `the tag ${first.tag ?? ''} is used by ${items.length} items (${items.map((i) => `${i.kind} ${i.id}`).join(', ')})`,
        values: { items: items.length },
      }),
    );
  }
  return out;
}

export function tagNonstandard(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'instrument' || item.tag === undefined) continue;
    const parsed = parseTag(item.tag);
    if (parsed.ok) continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_TAG_NONSTANDARD',
        ids: [item.id],
        item: item.tag,
        message: `instrument tag "${item.tag}" does not parse with ISA 5.1: ${parsed.message}`,
        values: { parseCode: parsed.code },
      }),
    );
  }
  return out;
}

export function lineNumberMissing(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'line' || (item.lineNumber !== undefined && item.lineNumber.trim() !== '')) continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_LINE_NUMBER_MISSING',
        ids: [item.id],
        item: itemLabel(item),
        message: `line ${itemLabel(item)} has no line number`,
      }),
    );
  }
  return out;
}

export function controlValveNoActuator(ctx: CheckContext): Finding[] {
  const actuated = new Set<string>();
  for (const id of ctx.pid.itemOrder) {
    const item = ctx.pid.items[id];
    if (item?.kind === 'actuating') actuated.add(item.valveId);
  }
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind === 'inline' && item.operated === true && !actuated.has(item.id))
      out.push(
        makeFinding({
          pid: ctx.pid,
          code: 'PID_CONTROL_VALVE_NO_ACTUATOR',
          ids: [item.id],
          item: itemLabel(item),
          message: `${itemLabel(item)} (${item.dexpiClass}) is an operated valve with no actuating system`,
        }),
      );
    else if (item.kind === 'actuating' && item.controllerId === undefined)
      out.push(
        makeFinding({
          pid: ctx.pid,
          code: 'PID_CONTROL_VALVE_NO_ACTUATOR',
          ids: [item.id],
          item: itemLabel(item, itemLabel(ctx.pid.items[item.valveId])),
          message: `the actuating system ${item.id} of ${itemLabel(ctx.pid.items[item.valveId], item.valveId)} has no controlling instrument`,
        }),
      );
  }
  return out;
}

const hasSetPressure = (attributes: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(attributes).some((name) => name.toLowerCase() === 'setpressurehigh');

export function safetyValveNoSetPressure(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'inline' || !/Safety|Relief/.test(sourceClass(item)) || hasSetPressure(item.attributes)) continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_SAFETY_VALVE_NO_SET_PRESSURE',
        ids: [item.id],
        item: itemLabel(item),
        message: `${itemLabel(item)} (${item.dexpiClass}) is a pressure-protection device without a set pressure (SetPressureHigh)`,
        reviewRequired: true,
      }),
    );
  }
  return out;
}

export function instrumentUnconnected(ctx: CheckContext): Finding[] {
  const controllers = new Set<string>();
  const loopSize = new Map<string, number>();
  for (const id of ctx.pid.itemOrder) {
    const item = ctx.pid.items[id];
    if (item?.kind === 'actuating' && item.controllerId !== undefined) controllers.add(item.controllerId);
    if (item?.kind === 'instrument' && item.loopId !== undefined) loopSize.set(item.loopId, (loopSize.get(item.loopId) ?? 0) + 1);
  }
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'instrument') continue;
    const linked =
      ctx.signalEnds.has(item.id) || controllers.has(item.id) || (item.loopId !== undefined && (loopSize.get(item.loopId) ?? 0) > 1);
    if (linked) continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_INSTRUMENT_UNCONNECTED',
        ids: [item.id],
        item: itemLabel(item),
        message: `instrument ${itemLabel(item)} has no measuring line, signal line or loop partner`,
      }),
    );
  }
  return out;
}
