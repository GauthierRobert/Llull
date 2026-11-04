/**
 * Pipe centrelines read from the document, shared by the stress model and the pipe markers: a building pipe or a 02 RTE run as absolute-mm points
 * with its section. Read on every call, so routing edits are never out of sync.
 * @invariant pure; consecutive duplicate points removed; a run that does not derive is reported by reason, never thrown
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { getBuilding } from '../../building/model';
import { getPiping } from '../piping/model';
import { isFailure } from '../piping/deriveTypes';
import { deriveRun } from '../piping/routeParts';
import { isReducer, isValve } from '../piping/runSizes';

export interface SourcePipe {
  readonly id: string;
  readonly kind: 'pipe' | 'run';
  /** Centreline through the points of intersection, absolute mm, consecutive duplicates removed. */
  readonly points: readonly Vec3[];
  readonly odMm: number;
  /** Nominal wall from the spec binding / run derivation; null when the pipe carries none. */
  readonly wallMm: number | null;
  /** Nominal size DN, or null. */
  readonly dn: number | null;
  /** Bend radius per vertex index from the 02 RTE derivation (runs); absent = the model's elbow radius factor. */
  readonly bendRadii: Readonly<Record<number, number>>;
  /** Run components the M3 model cannot represent (branches, reducers): analysis refuses with PST_COMPONENT_UNSUPPORTED. */
  readonly unsupported: readonly string[];
  /** Components idealised as plain pipe (valves): listed in the provenance. */
  readonly asPipe: readonly string[];
}

const DUPLICATE_MM = 0.01;

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Remaps the vertex indices of `radii` after removal of duplicate points. */
function dedupe(points: readonly Vec3[], radii: Readonly<Record<number, number>>): { points: Vec3[]; radii: Record<number, number> } {
  const kept: Vec3[] = [];
  const mapped: Record<number, number> = {};
  points.forEach((point, index) => {
    const last = kept[kept.length - 1];
    if (last !== undefined && distance(last, point) < DUPLICATE_MM) return;
    if (Object.hasOwn(radii, index)) mapped[kept.length] = radii[index] as number;
    kept.push(point);
  });
  return { points: kept, radii: mapped };
}

function runPipe(doc: CadDocument, runId: string): SourcePipe | string {
  const piping = getPiping(doc);
  const run = Object.hasOwn(piping.runs, runId) ? piping.runs[runId] : undefined;
  if (run === undefined) return 'no such run';
  const derivation = deriveRun(doc, run);
  if (isFailure(derivation)) return `the run does not derive (${derivation.code}: ${derivation.message})`;
  const centreline: Vec3[] = [(derivation.legs[0] as { start: Vec3 }).start, ...derivation.legs.map((leg) => leg.end)];
  const radii: Record<number, number> = {};
  for (const turn of derivation.turns) radii[turn.index] = turn.radius;
  const cleaned = dedupe(centreline, radii);
  const inline = run.inline ?? [];
  const unsupported = [
    ...(run.branches ?? []).map((branch) => `branch ${branch.id}`),
    ...inline.filter((component) => isReducer(component)).map((component) => `reducer ${component.id}`),
  ];
  return {
    id: runId,
    kind: 'run',
    points: cleaned.points,
    odMm: derivation.pipe.outsideDiameterMm,
    wallMm: derivation.pipe.wallMm,
    dn: run.dn ?? getPiping(doc).lines[run.lineId]?.dn ?? null,
    bendRadii: cleaned.radii,
    unsupported,
    asPipe: inline.filter((component) => isValve(component)).map((component) => `valve ${component.id}`),
  };
}

function buildingPipe(doc: CadDocument, pipeId: string): SourcePipe | string {
  const building = getBuilding(doc);
  const element = Object.hasOwn(building.elements, pipeId) ? building.elements[pipeId] : undefined;
  if (element?.category !== 'pipe') return 'no such pipe';
  const elevation = building.levels[element.levelId]?.elevation ?? 0;
  const absolute = element.points.map((point): Vec3 => [point[0], point[1], point[2] + elevation]);
  return {
    id: pipeId,
    kind: 'pipe',
    points: dedupe(absolute, {}).points,
    odMm: element.spec?.odMm ?? element.diameter,
    wallMm: element.spec?.wallMm ?? null,
    dn: element.dn ?? null,
    bendRadii: {},
    unsupported: [],
    asPipe: [],
  };
}

/** The centreline of a building pipe or a run by id: the pipe, or the reason it is unavailable. */
export const pipeCentreline = (doc: CadDocument, kind: 'pipes' | 'runs', id: string): SourcePipe | string =>
  kind === 'runs' ? runPipe(doc, id) : buildingPipe(doc, id);
