/**
 * Issue state of an isometric (plant 05 ISO TR-ISO-17): an issue stamp is bound to the content it was signed for (`basisSha256` over the components and weld numbers of
 * the line). Any later edit of the line makes the stamp stale, so the isometric is again NOT FOR CONSTRUCTION with reviewRequired true. Pure.
 */

import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import type { LineAnalysis } from './analysis';
import type { FabricationModel, IssuedIsometric } from './model';

/** SHA-256 of what a human signs for: the components of the line and the numbered weld joints. */
export const basisOf = (analysis: LineAnalysis): string =>
  sha256Hex(
    jcsJson({
      components: analysis.read.network.components,
      welds: analysis.numbering.entries.map((entry) => [entry.record.number, entry.joint.key]),
    }),
  );

/** The most recent issue stamp of `lineId`, and whether it still matches `basis`. */
export function issueState(
  fabrication: FabricationModel,
  lineId: string,
  basis: string,
): { readonly latest: IssuedIsometric | undefined; readonly current: IssuedIsometric | undefined } {
  const latest = Object.values(fabrication.issues ?? {})
    .filter((issue) => issue.lineId === lineId)
    .at(-1);
  return { latest, current: latest !== undefined && latest.basisSha256 === basis ? latest : undefined };
}
