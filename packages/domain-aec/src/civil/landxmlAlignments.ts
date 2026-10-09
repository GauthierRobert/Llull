/**
 * LandXML `<Alignments>` block of the civil model. Alignments (horizontal geometry, profiles and
 * cross sections) are written by the roads module; this returns '' while it contributes none.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';

/** `<Alignments>…</Alignments>` XML (indented one level, newline-terminated), or ''. */
export function alignmentsXml(_doc: Pick<CadDocument, 'civil' | 'units'>): string {
  return '';
}
