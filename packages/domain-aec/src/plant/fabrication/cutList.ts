/**
 * Cut list (plant 05 ISO §5.6, TR-ISO-07): for each PIPE piece `cut = L - gap / 2 per welded end + allowance per field-fit (WF) end`, L the centreline length between the
 * joint points. Gap and allowance are explicit (param or rule with its source), never defaulted. Pieces are named `<spool>-P<k>` in flow order within the spool. Pure.
 */

import type { LineAnalysis } from './analysis';
import { isWeldJoint, nodeKey } from './joints';
import type { NetworkComponent } from './model';
import { distance3 } from '@lib/vec3';

export interface Adjustment {
  readonly end: 'start' | 'end';
  readonly kind: 'weld_gap' | 'field_fit_allowance';
  readonly mm: number;
}

export interface CutPiece {
  readonly piece: string;
  readonly spool: string;
  readonly componentId: string;
  readonly boreMm: number;
  readonly itemCode: string | null;
  readonly centrelineLengthMm: number;
  readonly cutLengthMm: number;
  readonly adjustments: readonly Adjustment[];
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

export function cutPieces(analysis: LineAnalysis, gapMm: number, allowanceMm: number): CutPiece[] {
  const components = analysis.read.network.components;
  return analysis.spools.spools.flatMap((spool) => {
    let count = 0;
    return spool.memberIndices.flatMap((index): CutPiece[] => {
      const component = components[index] as NetworkComponent;
      const [start, end] = component.ends;
      if (component.type !== 'PIPE' || start === undefined || end === undefined) return [];
      count += 1;
      const adjustments: Adjustment[] = [];
      (['start', 'end'] as const).forEach((which) => {
        const point = which === 'start' ? start : end;
        const kind = analysis.classes.get(nodeKey(point.xyz));
        if (kind === undefined || !isWeldJoint(kind)) return;
        adjustments.push({ end: which, kind: 'weld_gap', mm: -gapMm / 2 });
        if (kind === 'field_fit') adjustments.push({ end: which, kind: 'field_fit_allowance', mm: allowanceMm });
      });
      const length = distance3(start.xyz, end.xyz);
      return [
        {
          piece: `${spool.name}-P${count}`,
          spool: spool.name,
          componentId: component.id,
          boreMm: start.boreMm,
          itemCode: component.itemCode ?? null,
          centrelineLengthMm: round6(length),
          cutLengthMm: round6(length + adjustments.reduce((sum, adjustment) => sum + adjustment.mm, 0)),
          adjustments,
        },
      ];
    });
  });
}
