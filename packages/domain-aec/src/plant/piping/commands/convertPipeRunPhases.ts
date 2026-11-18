import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { execute } from '@core/commands/registry';
import type { Vec3 } from '@core/model/vectors';
import type { PipeLine, PipeRun } from '@aec/plant/types';
import type { BuildingModel, PipeElement, PipeSupportElement } from '@aec/building/types';
import type { CadDocument } from '@core/model/types';
import { cross3, len3, sub3 } from '@lib/vec3';
import { nextId } from '@lib/id';
import { elementsOf, getBuilding } from '../../../building/model';
import { pipeSizeByOutsideDiameter } from '../../../industrial/piping/pipeSizes';
import { chooseElbow, turnAngleDeg } from '../fittings';
import { buildPath, unitVector, type PathOk } from '../legs';
import { getPiping, refuse, withPiping } from '../model';
import { deriveRun } from '../routeParts';
import type { RunDerivation } from '../deriveTypes';
import { createSpecLookup, isMiss, type SpecLookup } from '../specLookup';
import { followCarrier, supportOffsets, type SupportFollow } from '../supportReconcile';

export interface Refused {
  readonly refused: CommandResult;
}

export const isRefused = (value: object): value is Refused => 'refused' in value;

const NAME = 'convert_pipe_run';

/** `supports` (hosted by a legacy pipe) renamed to carry on run `runId`: the document that has them there, and the renamed elements. */
function retarget(
  doc: CadDocument,
  supports: ReadonlyArray<PipeSupportElement>,
  runId: string,
): { document: CadDocument; supports: PipeSupportElement[] } {
  const renamed = supports.map((support): PipeSupportElement => ({ ...support, pipeId: runId }));
  const building = getBuilding(doc);
  const elements = { ...building.elements, ...Object.fromEntries(renamed.map((support) => [support.id, support])) };
  return { document: { ...doc, building: { ...building, elements } }, supports: renamed };
}

export interface Legacy {
  readonly building: BuildingModel;
  readonly pipe: PipeElement;
  readonly hosted: PipeSupportElement[];
  readonly piping: ReturnType<typeof getPiping>;
  readonly existing: PipeLine | undefined;
  readonly specId: string;
  readonly lookup: SpecLookup;
  readonly dn: number;
}

/** The legacy pipe, its hosted supports, the target line, spec lookup and DN; refused when any of them is unusable. */
export function resolveLegacy(
  doc: CadDocument,
  params: { pipeId: string; spec?: string | undefined; lineId?: string | undefined; replace?: boolean | undefined },
): Legacy | Refused {
  if (doc.units !== 'mm')
    return {
      refused: refuse(
        doc,
        NAME,
        'RTE_UNITS_UNSUPPORTED',
        `plant lengths and catalogue dimensions are mm; this document is in ${doc.units}`,
      ),
    };
  const building = getBuilding(doc);
  const pipe = building.elements[params.pipeId];
  if (pipe === undefined || pipe.category !== 'pipe')
    return { refused: refuse(doc, NAME, 'RTE_UNKNOWN_PIPE', `no legacy pipe "${params.pipeId}" in the building model`, [], ['pipeId']) };
  const hosted = params.replace === true ? elementsOf(building, 'pipeSupport').filter((support) => support.pipeId === pipe.id) : [];
  const piping = getPiping(doc);
  const existing = params.lineId === undefined ? undefined : piping.lines[params.lineId];
  if (params.lineId !== undefined && existing === undefined)
    return { refused: refuse(doc, NAME, 'RTE_UNKNOWN_LINE', `no pipe line "${params.lineId}"`, [], ['lineId']) };
  const specId = existing?.spec ?? params.spec;
  if (specId === undefined)
    return { refused: refuse(doc, NAME, 'RTE_SPEC_UNKNOWN', 'give spec (or lineId of a line that has one)', [], ['spec']) };
  const lookup = createSpecLookup(doc, specId);
  if (isMiss(lookup)) return { refused: refuse(doc, NAME, lookup.miss, lookup.detail, [...lookup.ids], ['spec']) };
  const fromDiameter = pipe.dn === undefined ? pipeSizeByOutsideDiameter(pipe.diameter)?.[0] : undefined;
  const dn = existing?.dn ?? pipe.dn ?? fromDiameter;
  if (dn === undefined)
    return {
      refused: refuse(
        doc,
        NAME,
        'RTE_SIZE_MISMATCH',
        `the legacy pipe has no dn and its diameter ${pipe.diameter} mm matches no DN in the pipe size table`,
        [pipe.id],
        ['pipeId'],
      ),
    };
  if (existing !== undefined && pipe.dn !== undefined && pipe.dn !== existing.dn)
    return {
      refused: refuse(
        doc,
        NAME,
        'RTE_SIZE_MISMATCH',
        `the legacy pipe is DN${pipe.dn}, line ${existing.id} is DN${existing.dn}`,
        [pipe.id, existing.id],
        ['lineId'],
      ),
    };
  return { building, pipe, hosted, piping, existing, specId, lookup, dn };
}

export interface Straightened {
  readonly world: Vec3[];
  readonly kept: Vec3[];
  readonly mergedCount: number;
  readonly straightenedMaxOffsetMm: number;
  readonly tolerance: number;
}

/** The world-space vertices with straight-through vertices merged; refused when a remaining bend has no spec elbow. */
export function straightenBends(doc: CadDocument, legacy: Legacy): Straightened | Refused {
  const { building, pipe, lookup, dn } = legacy;
  const elevation = building.levels[pipe.levelId]?.elevation ?? 0;
  const world = pipe.points.map((point): Vec3 => [point[0], point[1], point[2] + elevation]);
  const tolerance = lookup.elbowAngles().toleranceDeg;
  const pipeRow = lookup.pipe(dn);
  const bendOptions = isMiss(pipeRow) ? undefined : { pipeOd: pipeRow.dims['outsideDiameter'] ?? 0 };
  // Every bend must have a spec elbow: list them all, not only the first.
  const unfit: Array<{ vertex: number; angleDeg: number }> = [];
  // A vertex that deflects by no more than the spec angle tolerance is straight pipe: it merges (counted in data.mergedPoints).
  const kept: Vec3[] = [world[0] as Vec3];
  const merged: Array<{ point: Vec3; after: number }> = [];
  for (let i = 1; i + 1 < world.length; i++) {
    const [before, after] = [
      unitVector(sub3(world[i] as Vec3, kept.at(-1) as Vec3)),
      unitVector(sub3(world[i + 1] as Vec3, world[i] as Vec3)),
    ];
    const turn = turnAngleDeg(before, after);
    if (turn <= tolerance) {
      merged.push({ point: world[i] as Vec3, after: kept.length - 1 });
      continue;
    }
    kept.push(world[i] as Vec3);
    if ('code' in chooseElbow(lookup, dn, turn, tolerance, bendOptions)) unfit.push({ vertex: i, angleDeg: turn });
  }
  kept.push(world.at(-1) as Vec3);
  // How far the straightening moved the pipe: each merged vertex against the leg that now runs past it.
  const straightenedMaxOffsetMm = merged.reduce((max, { point, after }) => {
    const [from, to] = [kept[after] as Vec3, kept[after + 1] as Vec3];
    const leg = sub3(to, from);
    return Math.max(max, len3(cross3(leg, sub3(point, from))) / len3(leg));
  }, 0);
  if (unfit.length > 0)
    return {
      refused: refuse(
        doc,
        NAME,
        'RTE_NO_FITTING_FOR_ANGLE',
        `bend(s) at vertex ${unfit.map((bend) => `${bend.vertex} (${+bend.angleDeg.toFixed(4)} deg)`).join(', ')} have no spec elbow (angles ${lookup.elbowAngles().anglesDeg.join(', ')} deg, tolerance ${tolerance} deg)`,
        [pipe.id],
        unfit.map((bend) => `points.${bend.vertex}`),
        {
          vertices: unfit.map((bend) => bend.vertex),
          anglesDegAtVertices: unfit.map((bend) => bend.angleDeg),
          anglesDeg: lookup.elbowAngles().anglesDeg,
          toleranceDeg: tolerance,
        },
      ),
    };
  return { world, kept, mergedCount: merged.length, straightenedMaxOffsetMm, tolerance };
}

export interface Built {
  readonly path: PathOk;
  readonly line: PipeLine;
  readonly run: PipeRun;
  readonly runId: string;
  readonly stored: CadDocument;
  readonly derived: RunDerivation;
}

/** The run (and new line) stored in the document and its spec derivation; refused when the path, line number or derivation fails. */
export function buildRun(doc: CadDocument, legacy: Legacy, straight: Straightened): Built | Refused {
  const { pipe, piping, existing, specId, dn } = legacy;
  const path = buildPath({ point: straight.world[0] as Vec3 }, undefined, [], straight.kept.slice(1), straight.tolerance);
  if (!path.ok)
    return {
      refused: refuse(
        doc,
        NAME,
        path.code,
        path.message,
        [pipe.id],
        path.paths.map((p) => p.replace('via', 'points')),
        path.detail,
      ),
    };
  const lineNumber = pipe.line ?? `${dn}-${pipe.service}-${pipe.mark}-${specId}`;
  const clash = piping.lineOrder.find((id) => piping.lines[id]?.lineNumber === lineNumber);
  if (existing === undefined && clash !== undefined)
    return {
      refused: refuse(
        doc,
        NAME,
        'RTE_DUPLICATE_LINE_NUMBER',
        `line number ${lineNumber} is used by ${clash}; pass lineId: "${clash}" to put the run on that line`,
        [clash, pipe.id],
        ['lineId'],
      ),
    };
  const line: PipeLine =
    existing ??
    ({
      id: nextId('line'),
      lineNumber,
      service: pipe.service,
      sequence: pipe.line ?? pipe.mark,
      spec: specId,
      dn,
      ...(pipe.from === undefined ? {} : { from: pipe.from }),
      ...(pipe.to === undefined ? {} : { to: pipe.to }),
    } satisfies PipeLine);
  const runId = nextId('run');
  const run: PipeRun = {
    id: runId,
    lineId: line.id,
    start: { point: path.points[0] as Vec3 },
    end: { point: path.points.at(-1) as Vec3 },
    pis: path.points.slice(1, -1),
  };
  const lines = existing === undefined ? { ...piping.lines, [line.id]: line } : piping.lines;
  const lineOrder = existing === undefined ? [...piping.lineOrder, line.id] : piping.lineOrder;
  const stored = withPiping(doc, {
    ...piping,
    lines,
    lineOrder,
    runs: { ...piping.runs, [runId]: run },
    runOrder: [...piping.runOrder, runId],
  });
  const derived = deriveRun(stored, run);
  if (!derived.ok)
    return { refused: refuse(doc, NAME, derived.code, derived.message, [...derived.ids], [...derived.paths], derived.detail) };
  return { path, line, run, runId, stored, derived };
}

export interface Replaced {
  readonly result: CadDocument;
  readonly removed: string[];
  readonly followed: SupportFollow | undefined;
}

/** `replace`: moves the hosted supports onto the new run and deletes the legacy pipe; refused when a support cannot sit on the run. */
export function replaceLegacy(
  doc: CadDocument,
  legacy: Legacy,
  built: Built,
  start: CadDocument,
  ctx: ExecutionContext | undefined,
): Replaced | Refused {
  const { pipe, hosted } = legacy;
  const { runId, derived } = built;
  let result = start;
  let followed: SupportFollow | undefined;
  const onRun = retarget(result, hosted, runId);
  const limit = derived.pipe.outsideDiameterMm;
  const off = supportOffsets(onRun.document, onRun.supports).filter(({ by }) => by > limit);
  if (off.length > 0)
    return {
      refused: refuse(
        doc,
        NAME,
        'RTE_SUPPORT_OFF_RUN',
        `pipe support(s) ${off.map(({ support, by }) => `${support.mark} (${+by.toFixed(1)} mm)`).join(', ')} of ${pipe.id} are farther than one outside diameter (${limit} mm) from the new centreline: they cannot sit on run ${runId}`,
        [pipe.id, ...off.map(({ support }) => support.id)],
        ['replace'],
        { limitMm: limit, offsets: off.map(({ support, by }) => ({ id: support.id, mark: support.mark, offsetMm: by })) },
      ),
    };
  if (onRun.supports.length > 0) {
    followed = followCarrier(onRun.document, onRun.supports);
    result = followed.document;
  }
  const deleted = execute(result, 'delete_building_element', { elementIds: [pipe.id] }, ctx);
  if (deleted.rejected === true || deleted.document === result)
    return {
      refused: refuse(
        doc,
        NAME,
        deleted.error?.code ?? 'RTE_UNKNOWN_PIPE',
        `the legacy pipe ${pipe.id} could not be replaced: ${deleted.summary}`,
        [pipe.id],
        ['replace'],
      ),
    };
  return { result: deleted.document, removed: deleted.affected, followed };
}
