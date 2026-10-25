/** Access to `doc.plant.fabrication` and the set of line ids in use (plant 05 ISO). */

import type { CadDocument } from '@core/model/types';
import type { FabricationModel } from './model';
import { getPiping } from '../piping/model';
import { legacyLines } from './legacyNetwork';

export const EMPTY_FABRICATION: FabricationModel = { version: 1, pcfLines: {} };

export const getFabrication = (doc: Pick<CadDocument, 'plant'>): FabricationModel => doc.plant?.fabrication ?? EMPTY_FABRICATION;

export const withFabrication = (doc: CadDocument, fabrication: FabricationModel): CadDocument => ({
  ...doc,
  plant: { ...doc.plant, fabrication },
});

/** Every line id the document knows: routed line ids and line numbers, imported PCF lines, legacy pipe lines. */
export function lineIdsInUse(doc: CadDocument): Set<string> {
  const piping = getPiping(doc);
  return new Set([
    ...Object.values(piping.lines).flatMap((line) => [line.id, line.lineNumber]),
    ...Object.keys(getFabrication(doc).pcfLines),
    ...legacyLines(doc).keys(),
  ]);
}
