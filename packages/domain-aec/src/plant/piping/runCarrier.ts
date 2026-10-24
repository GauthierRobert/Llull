/**
 * A plant run seen as the pipe a support rests on (02 RTE V1 part 2): the run centreline (the legs of `piping_takeoff`, else the stored points of
 * intersection when the run does not derive) and its outside diameter, in the shape of a building `PipeElement` so every support consumer reads
 * both pipe kinds through the one carrier lookup (`industrial/piping/pipeCarrier.ts`). Points are document units (mm in plant documents), z relative
 * to the level `levelId` like the points of a building pipe.
 * @invariant pure; the derivation is memoised per run object and document slices (derivationMemo.ts), so repeated lookups are cheap
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PipeElement } from '@aec/building/types';
import { runPoints, getPiping } from './model';
import { deriveRun } from './routeParts';

export type CarrierDoc = Pick<CadDocument, 'building' | 'plant' | 'units'>;

/**
 * The pipe element of run `runId` in the frame of level `levelId` (elevation 0 when the level is unknown), or undefined for an unknown run.
 * The diameter is the pipe outside diameter of the derivation; a run that does not derive (broken) falls back to its nominal size in mm.
 */
export function runCarrierPipe(doc: CarrierDoc, runId: string, levelId: string): PipeElement | undefined {
  const piping = getPiping(doc);
  const run = piping.runs[runId];
  const line = run === undefined ? undefined : piping.lines[run.lineId];
  if (run === undefined || line === undefined) return undefined;
  const derivation = deriveRun(doc as CadDocument, run);
  const elevation = doc.building?.levels[levelId]?.elevation ?? 0;
  const centreline: Vec3[] = derivation.ok
    ? [(derivation.legs[0] ?? { start: run.start.point }).start, ...derivation.legs.map((leg) => leg.end)]
    : runPoints(run);
  return {
    id: run.id,
    category: 'pipe',
    mark: run.id,
    entityIds: [],
    levelId,
    points: centreline.map((point): Vec3 => [point[0], point[1], point[2] - elevation]),
    diameter: derivation.ok ? derivation.pipe.outsideDiameterMm : (run.dn ?? line.dn),
    service: line.service,
    material: line.spec,
    line: line.lineNumber,
    dn: run.dn ?? line.dn,
  };
}
