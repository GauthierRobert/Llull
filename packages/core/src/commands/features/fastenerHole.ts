/** Hole diameter taken from the fastener catalogue (07 FTR M6, VC-FTR-29): `hole.fastener` -> the installed fastener plugin's projection. */

import type { CadDocument } from '../../model/types';
import type { FastenerRef } from '../../model/features';
import type { FastenerHoleSize } from '../../plugins/plugin';
import { documentProjection } from '../../plugins/host';

/**
 * @failure no fastener plugin / catalogue / family / size / hole diameter / convertible unit -> reason string
 */
export function holeFromFastener(doc: CadDocument, ref: FastenerRef): FastenerHoleSize | string {
  const resolve = documentProjection('fastenerHole');
  return resolve === undefined ? 'the document has no fastener catalogue (install one with the fasteners commands)' : resolve(doc, ref);
}
