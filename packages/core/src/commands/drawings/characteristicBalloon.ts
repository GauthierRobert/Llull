/** Characteristic balloons on sheets (09 PLM FR-PLM-26): the number of an AS9102 characteristic, drawn beside its PMI callout; derived at export, never stored. */

import type { CadDocument } from '../../model/types';
import { documentProjection } from '../../plugins/host';
import { n, svgLine, svgText } from '../../geometry/drawingSvg';

const RADIUS = 3.5;

/**
 * The balloon of PMI item `pmiId` placed left of its callout `box` ([x, y, width, height] paper mm), or an empty list when the item has no active
 * characteristic number (plugin projection `characteristicNumber`, e.g. `plm`).
 * @invariant a retired characteristic draws nothing; the number is the register's, so it survives regeneration
 */
export function characteristicBalloon(doc: CadDocument, pmiId: string, box: readonly [number, number, number, number]): string[] {
  const charNo = documentProjection('characteristicNumber')?.(doc, pmiId);
  if (charNo === undefined) return [];
  const cx = box[0] - RADIUS - 1.5;
  const cy = box[1] + box[3] / 2;
  return [
    `<g id="balloon-${charNo}" data-char-no="${charNo}">`,
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(RADIUS)}" class="thin"/>`,
    svgLine([cx + RADIUS, cy], [box[0], cy], 'thin'),
    svgText(cx, cy + RADIUS * 0.35, RADIUS * 0.9, 'middle', String(charNo)),
    '</g>',
  ];
}
