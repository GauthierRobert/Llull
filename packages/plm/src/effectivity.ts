/** Effectivity ranges (FR-PLM-11/12, §5.6): inclusive serial / MSN / date ranges, cut-in closing, overlap and resolution. */

import type { Effectivity, EffectivityKind, ManagedItem } from '@plm/types';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a valid unit of `kind`: positive integer (serial, msn), real calendar date `YYYY-MM-DD` (date), non-empty id (lot). */
export function isUnitOfKind(kind: EffectivityKind, value: unknown): value is number | string {
  if (kind === 'serial' || kind === 'msn') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
  if (typeof value !== 'string') return false;
  if (kind === 'lot') return value !== '';
  const match = DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

/** Whether every range has valid, ordered units of its kind. */
export function effectivityProblem(ranges: readonly Effectivity[]): string | null {
  for (const range of ranges) {
    if (!isUnitOfKind(range.kind, range.from))
      return `${range.kind} effectivity 'from' ${JSON.stringify(range.from)} is not a valid ${range.kind}`;
    if (range.to === undefined) continue;
    if (!isUnitOfKind(range.kind, range.to))
      return `${range.kind} effectivity 'to' ${JSON.stringify(range.to)} is not a valid ${range.kind}`;
    if (range.kind !== 'lot' && range.to < range.from)
      return `${range.kind} effectivity ends (${range.to}) before it starts (${range.from})`;
  }
  return null;
}

const dayBefore = (date: string): string => {
  const match = DATE.exec(date);
  const time = Date.UTC(Number(match?.[1]), Number(match?.[2]) - 1, Number(match?.[3])) - 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
};

/** The last unit before `from`: integer - 1, or the previous calendar day. Lots have no order (undefined). */
function unitBefore(kind: EffectivityKind, from: number | string): number | string | undefined {
  if (kind === 'lot') return undefined;
  return typeof from === 'number' ? from - 1 : dayBefore(from);
}

/** Whether `range` contains `unit` (lots match by identity). */
export function containsUnit(range: Effectivity, unit: number | string): boolean {
  if (range.kind === 'lot') return range.from === unit;
  return unit >= range.from && (range.to === undefined || unit <= range.to);
}

/** Whether two ranges of the same kind share a unit. */
function overlaps(a: Effectivity, b: Effectivity): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'lot') return a.from === b.from;
  const aEndsBeforeB = a.to !== undefined && a.to < b.from;
  const bEndsBeforeA = b.to !== undefined && b.to < a.from;
  return !aEndsBeforeB && !bEndsBeforeA;
}

/**
 * Effect of releasing a revision with `incoming` ranges: the earlier revisions' ranges as they become (open ranges of the same kind closed
 * at the cut-in), or the overlap that makes the release illegal.
 * @invariant a range of an earlier released revision that starts at or after the cut-in cannot be closed: that is an overlap
 */
export function closeForCutIn(
  existing: ReadonlyArray<{ readonly label: string; readonly effectivity: readonly Effectivity[] }>,
  incoming: readonly Effectivity[],
): { readonly closed: Record<string, Effectivity[]> } | { readonly overlap: string } {
  const closed: Record<string, Effectivity[]> = {};
  for (const prior of existing) {
    const next: Effectivity[] = [];
    for (const range of prior.effectivity) {
      let current = range;
      for (const cut of incoming) {
        if (!overlaps(current, cut)) continue;
        const end = unitBefore(cut.kind, cut.from);
        const closable = range.to === undefined && end !== undefined && end >= current.from;
        if (!closable) return { overlap: `${prior.label} ${range.kind} ${rangeText(range)} overlaps ${rangeText(cut)}` };
        current = { ...current, to: end };
      }
      next.push(current);
    }
    closed[prior.label] = next;
  }
  return { closed };
}

const rangeText = (range: Effectivity): string => `${String(range.from)}..${range.to === undefined ? 'open' : String(range.to)}`;

/** The first released / superseded revision whose range of `kind` contains `unit`; obsolete and cancelled revisions never resolve. */
export function resolveRevision(item: ManagedItem, kind: EffectivityKind, unit: number | string): string | null {
  for (const label of item.revisionOrder) {
    const revision = item.revisions[label];
    if (revision === undefined || (revision.state !== 'released' && revision.state !== 'superseded')) continue;
    if (revision.effectivity.some((range) => range.kind === kind && containsUnit(range, unit))) return label;
  }
  return null;
}
