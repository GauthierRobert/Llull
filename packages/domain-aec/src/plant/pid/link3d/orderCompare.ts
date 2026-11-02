/** P3D_INLINE_ORDER_MISMATCH for one paired line (plant 04 PID §5.6): the P&ID inline tags along the line against the 02 RTE inline components. */

import type { PidLine, PidModel } from '../model';
import { itemAt, text, type Norm, type Run } from './common';
import { makeFinding3d, type Finding3d, type Skip3d } from './finding';
import { segmentsOf } from './lineCompare';
import { longestCommonSubsequence, MAX_ORDER_CELLS, withinOrderBudget } from './sequence';

interface Tagged {
  readonly key: string;
  readonly tag: string;
}

/** Tagged inline items along the main (primary) segments of a line in segment order; an item that splits one drawn segment counts once. */
function pidSequence(pid: PidModel, line: PidLine, norm: Norm): Tagged[] {
  const out: Tagged[] = [];
  let lastId: string | undefined;
  for (const segment of segmentsOf(pid, line).filter((s) => s.primary))
    for (const end of [segment.from, segment.to]) {
      if (end.type !== 'inline' || end.itemId === lastId) continue;
      lastId = end.itemId;
      const item = itemAt(pid, end.itemId);
      const tag = item?.kind === 'inline' ? text(item.tag) : undefined;
      if (tag !== undefined) out.push({ key: norm(tag), tag });
    }
  return out;
}

export interface OrderComparison {
  readonly findings: Finding3d[];
  readonly skips: Skip3d[];
}

const NONE: OrderComparison = { findings: [], skips: [] };

/**
 * Only tags present on both sides are ordered (a tag missing on one side is already P3D_UNPLACED / P3D_NOT_IN_PID). The 3D sequence follows the
 * route direction, which need not be the flow direction: the reversed 3D sequence is tried too and the longer common subsequence wins (a tie keeps
 * the route direction). Quadratic, so bounded by `MAX_ORDER_CELLS` with a coded skip above it.
 */
export function compareOrder(pid: PidModel, line: PidLine, run: Run, norm: Norm): OrderComparison {
  const label = line.lineNumber ?? line.id;
  const modelAll = run.sequence.map((c) => ({ key: norm(c.label), tag: c.label }));
  const pidAll = pidSequence(pid, line, norm);
  const pidKeys = new Set(pidAll.map((t) => t.key));
  const modelKeys = new Set(modelAll.map((t) => t.key));
  const pidSeq = pidAll.filter((t) => modelKeys.has(t.key));
  const modelSeq = modelAll.filter((t) => pidKeys.has(t.key));
  if (pidSeq.length < 2 || modelSeq.length < 2) return NONE;
  const where = { item: label, pidIds: [line.id], elementIds: run.ids };
  if (!withinOrderBudget(pidSeq.length, modelSeq.length))
    return {
      findings: [],
      skips: [
        {
          code: 'P3D_INLINE_ORDER_MISMATCH',
          reason: 'sequence_too_long',
          ...where,
          detail: `line ${label}: ${pidSeq.length} x ${modelSeq.length} inline tags exceed the ${MAX_ORDER_CELLS} cell budget of the order comparison`,
        },
      ],
    };
  const a = pidSeq.map((t) => t.key);
  const forward = longestCommonSubsequence(
    a,
    modelSeq.map((t) => t.key),
  );
  const reverse = longestCommonSubsequence(a, modelSeq.map((t) => t.key).reverse());
  const reversed = reverse.length > forward.length;
  const common = reversed ? reverse : forward;
  if (common.length === pidSeq.length && common.length === modelSeq.length) return NONE;
  const shown = new Map(pidSeq.map((t) => [t.key, t.tag]));
  let matched = 0;
  const outOfPlace = pidSeq
    .filter((t) => (matched < common.length && t.key === common[matched] ? (matched++, false) : true))
    .map((t) => t.tag);
  const names = (keys: readonly string[]): string => keys.map((k) => shown.get(k) ?? k).join(',');
  const modelOrder = (reversed ? [...modelSeq].reverse() : modelSeq).map((t) => t.tag).join(',');
  return {
    findings: [
      makeFinding3d({
        code: 'P3D_INLINE_ORDER_MISMATCH',
        ...where,
        message: `line ${label}: inline order differs: P&ID ${pidSeq.map((t) => t.tag).join(' > ')} but 3D ${modelOrder.split(',').join(' > ')}; longest common sequence ${names(common) || 'none'}, out of place ${outOfPlace.join(', ')}`,
        values: {
          pidOrder: pidSeq.map((t) => t.tag).join(','),
          modelOrder,
          lcs: names(common),
          lcsLength: common.length,
          outOfPlace: outOfPlace.join(','),
          modelReversed: reversed,
        },
      }),
    ],
    skips: [],
  };
}
