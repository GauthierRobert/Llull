/** `check_pid` consistency rules: size and spec of an inline item against its line, flow direction (§5.4, §5.5). */

import type { PidInline, PidSegment } from '../model';
import { sourceClass } from '../lists/counts';
import { directionAt, flagged, inlineKey, type CheckContext } from './context';
import { itemLabel, makeFinding, type Finding } from './finding';

/** Items that change size on purpose; a tee (more than two ports) keeps the run size, so it is checked, a reducer is not. */
const isReducer = (item: PidInline): boolean => /Reducer|Swage|Expander/.test(sourceClass(item));
const isSpecBreak = (item: PidInline): boolean => sourceClass(item).includes('SpecBreak') || flagged(item, 'specBreak');
const isCheckValve = (item: PidInline): boolean => sourceClass(item).includes('Check');

/** Segments on the run of the item: every port, except that a tee (more than two ports) is compared on ports 0 and 1 only, its branch may leave in another size or class. */
function adjacent(ctx: CheckContext, item: PidInline): PidSegment[] {
  const found: PidSegment[] = [];
  const run = item.ports.length > 2 ? 2 : item.ports.length;
  for (let node = 0; node < run; node++)
    for (const segment of ctx.ends.get(inlineKey(item.id, node)) ?? []) if (!found.includes(segment)) found.push(segment);
  return found;
}

export function sizeMismatch(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'inline' || item.dn === undefined || isReducer(item)) continue;
    const bad = adjacent(ctx, item).filter((segment) => segment.dn !== undefined && segment.dn !== item.dn);
    const first = bad[0];
    if (first === undefined) continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_SIZE_MISMATCH',
        ids: [item.id, ...bad.map((s) => s.id)],
        item: itemLabel(item),
        message: `${itemLabel(item)} (${item.dexpiClass}) is DN ${item.dn} but its line is DN ${first.dn}, with no reducer between`,
        values: { itemDn: item.dn, lineDn: first.dn ?? 0 },
      }),
    );
  }
  return out;
}

export function specMismatch(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'inline' || item.pipingClass === undefined || isSpecBreak(item)) continue;
    const bad = adjacent(ctx, item).filter((segment) => segment.pipingClass !== undefined && segment.pipingClass !== item.pipingClass);
    const first = bad[0];
    if (first === undefined) continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_SPEC_MISMATCH',
        ids: [item.id, ...bad.map((s) => s.id)],
        item: itemLabel(item),
        message: `${itemLabel(item)} (${item.dexpiClass}) has piping class ${item.pipingClass} but its line is ${first.pipingClass}, with no spec break`,
        values: { itemClass: item.pipingClass, lineClass: first.pipingClass ?? '' },
      }),
    );
  }
  return out;
}

/** Conflict (a): segments with flow meeting at an inline item all point into it or all out of it. Conflict (b): a check valve against the flow. */
export function flowConflict(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const item of ctx.scope) {
    if (item.kind !== 'inline') continue;
    const directed: Array<{ segment: PidSegment; direction: 'in' | 'out'; node: number }> = [];
    item.ports.forEach((_, node) => {
      for (const segment of ctx.ends.get(inlineKey(item.id, node)) ?? []) {
        const direction = directionAt(segment, inlineKey(item.id, node));
        if (direction !== undefined) directed.push({ segment, direction, node });
      }
    });
    const reasons: string[] = [];
    const ins = directed.filter((d) => d.direction === 'in').length;
    if (directed.length >= 2 && (ins === directed.length || ins === 0))
      reasons.push(`every connected segment flows ${ins === 0 ? 'out of' : 'into'} it`);
    if (isCheckValve(item)) {
      const entry = item.reversed === true ? 1 : 0;
      if (directed.some((d) => (d.direction === 'in') !== (d.node === entry)))
        reasons.push(`the check valve is ${item.reversed === true ? 'reversed' : 'set'} against the flow of its line`);
    }
    if (reasons.length === 0) continue;
    out.push(
      makeFinding({
        pid: ctx.pid,
        code: 'PID_FLOW_DIRECTION_CONFLICT',
        ids: [item.id, ...directed.map((d) => d.segment.id)],
        item: itemLabel(item),
        message: `${itemLabel(item)} (${item.dexpiClass}): ${reasons.join('; ')}`,
        values: { segments: directed.length },
      }),
    );
  }
  return out;
}
