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
 * The level a run belongs to (V1c): the highest building level whose elevation is at or below the lowest point of the run centreline; a run below every
 * level belongs to the lowest one; '' when the building has no level. The one rule for every consumer that needs a run's level (the support layout, the
 * level filter of check_pipe_supports, add_pipe_support). A run is one level as a whole: the level of its lowest point (a riser belongs to the level it rises from).
 * @invariant elevation is in document units, like the level elevations
 */
function levelOfElevation(building: CadDocument['building'], elevation: number): string {
  const levels = Object.values(building?.levels ?? {}).sort((a, b) => a.elevation - b.elevation);
  return (levels.filter((level) => level.elevation <= elevation).at(-1) ?? levels[0])?.id ?? '';
}

/**
 * The pipe element of run `runId` in the frame of level `levelId` (default: the level of the run; elevation 0 when the level is unknown), or undefined for an unknown run.
 * The diameter is the pipe outside diameter of the derivation; a run that does not derive (broken) falls back to its nominal size in mm.
 */
export function runCarrierPipe(doc: CarrierDoc, runId: string, levelId?: string): PipeElement | undefined {
  const piping = getPiping(doc);
  const run = piping.runs[runId];
  const line = run === undefined ? undefined : piping.lines[run.lineId];
  if (run === undefined || line === undefined) return undefined;
  const derivation = deriveRun(doc as CadDocument, run);
  const centreline: Vec3[] = derivation.ok
    ? [(derivation.legs[0] ?? { start: run.start.point }).start, ...derivation.legs.map((leg) => leg.end)]
    : runPoints(run);
  const frame = levelId ?? levelOfElevation(doc.building, Math.min(...centreline.map((point) => point[2])));
  const elevation = doc.building?.levels[frame]?.elevation ?? 0;
  return {
    id: run.id,
    category: 'pipe',
    mark: run.id,
    entityIds: [],
    levelId: frame,
    points: centreline.map((point): Vec3 => [point[0], point[1], point[2] - elevation]),
    diameter: derivation.ok ? derivation.pipe.outsideDiameterMm : (run.dn ?? line.dn),
    service: line.service,
    material: line.spec,
    line: line.lineNumber,
    dn: run.dn ?? line.dn,
  };
}
