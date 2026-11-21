/**
 * Run derivation (02 RTE §2 "stored intent, derived parts"): a stored `PipeRun` + its line's spec -> `RoutedPart[]` and `Joint[]` in route order
 * with deterministic ids (`<runId>/<kind>-<k>`, AF-13), cut lengths (§5.3), the turn table (§5.2) and the centreline length. Every run goes
 * through this one derivation, including runs made by `auto_route_pipe`, runs with valves and reducers, headers with branches and branch runs.
 * Pure: nothing is stored.
 * @invariant ids depend only on route order; the same document and run always give the same parts, joints and numbers
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { Joint, PipeRun, RoutedPart } from '@aec/plant/types';
import { len3, sub3 } from '@lib/vec3';
import { fail, isFailure, type DerivationFailure, type RunDerivation } from './deriveTypes';
import { DerivationMemo } from './derivationMemo';
import { centrelineLength } from './fittings';
import { defaultMinWeldSpacing } from './jointStack';
import { epsilonFor, unitVector } from './legs';
import { getPiping, runPoints } from './model';
import { legShifts } from './legShifts';
import { derivedBranch, layoutBranches, teeSlot } from './routeBranch';
import { mintSet, setupEnd } from './routeEnds';
import { makeEnv, type EndSetup, type Env, type Mint, type PipeInfo, type Slot } from './routeEnv';
import { layoutInline } from './routeInline';
import { deriveLeg } from './routeLegs';
import { addEndParts, addStartParts } from './routeRunEnds';
import type { RunCtx } from './routeRunCtx';
import { chooseTurns, type Turns } from './routeTurns';
import { endDn, startDn } from './runSizes';
import type { SpecLookup } from './specLookup';

function unverifiedReasons(lookup: SpecLookup, parts: readonly RoutedPart[]): string[] {
  const reasons: string[] = [];
  if (lookup.status() !== 'approved') reasons.push(`spec ${lookup.id} r${lookup.revision} is ${lookup.status()}, not approved`);
  const rows = [...new Set(parts.filter((part) => part.unverified).map((part) => part.catalogueKey))];
  if (rows.length > 0) reasons.push(`catalogue rows not grade A: ${rows.join(', ')}`);
  return reasons;
}

/**
 * Derives the parts and joints of `run`.
 * @failure unknown line / spec / port, size, rating, facing, end-type or angle problems, a leg too short for its fittings, an inline component or
 *   branch that does not fit or has no spec row -> DerivationFailure with the RTE_* code, the ids involved and the param path
 */
export function deriveRun(doc: CadDocument, run: PipeRun): RunDerivation | DerivationFailure {
  return derivedOnce(doc, run, []);
}

type Derived = RunDerivation | DerivationFailure;
/** Frozen derivations per run object and the document slices a derivation reads: a header is derived once however many branches hang on it. */
const derivations = new DerivationMemo<Derived>();

function derivedOnce(doc: CadDocument, run: PipeRun, path: readonly string[]): Derived {
  return derivations.get(doc, run) ?? derivations.set(doc, run, derive(doc, run, path));
}

/** A branch hangs on its header: when the header does not derive (moved port, missing part) the branch is broken with the header's code. */
function headerFailure(doc: CadDocument, run: PipeRun, path: readonly string[]): DerivationFailure | undefined {
  if (run.start.ref?.kind !== 'branch') return undefined;
  const header = getPiping(doc).runs[run.start.ref.runId];
  if (header !== undefined && [...path, run.id].includes(header.id))
    return fail(
      'RTE_UNKNOWN_RUN',
      `branch cycle: run ${run.id} hangs on ${header.id}, which hangs on ${run.id} again`,
      [run.id, header.id],
      ['start'],
    );
  const parent = header === undefined ? null : derivedOnce(doc, header, [...path, run.id]);
  if (parent !== null && isFailure(parent)) return { ...parent, message: `header ${header?.id}: ${parent.message}` };
  return undefined;
}

interface RunGeometry {
  readonly points: readonly Vec3[];
  readonly lengths: readonly number[];
  readonly dirs: readonly Vec3[];
  readonly eps: number;
}

function runGeometry(run: PipeRun): RunGeometry | DerivationFailure {
  const points = runPoints(run);
  if (points.length - 1 < 1) return fail('RTE_ZERO_LEG', 'the run has no leg', [run.id], []);
  const eps = epsilonFor(...points);
  const lengths = points.slice(1).map((p, i) => len3(sub3(p, points[i] as Vec3)));
  const zero = lengths.findIndex((length) => !(length > eps));
  if (zero >= 0) return fail('RTE_ZERO_LEG', `leg ${zero} of run ${run.id} has zero length`, [run.id], [`legs.${zero}`], { leg: zero });
  const dirs = points.slice(1).map((p, i) => unitVector(sub3(p, points[i] as Vec3)));
  return { points, lengths, dirs, eps };
}

interface RunInputs {
  readonly env: Env;
  readonly start: EndSetup;
  readonly end: EndSetup;
  readonly dnStart: number;
  readonly dnEnd: number;
  readonly od: number;
  readonly geometry: RunGeometry;
  readonly chosen: Turns;
}

/** Mints the ids (start set, inline components, end set), lays out inline components and branches, and builds the context the leg walk fills. */
function layoutRun(i: RunInputs): RunCtx | DerivationFailure {
  const { env, start, end } = i;
  const { points, lengths, dirs, eps } = i.geometry;
  const run = env.run;
  const counters: Record<string, number> = {};
  const mint: Mint = (kind) => `${run.id}/${kind}-${(counters[kind] = (counters[kind] ?? 0) + 1)}`;
  const startIds = start.set === null ? null : mintSet(mint);
  const startCapId = start.cap === undefined ? null : mint('cap');
  const startBlindId = start.blind === undefined ? null : mint('flange');
  const inlineSlots = layoutInline(env, lengths, dirs, mint);
  if (isFailure(inlineSlots)) return inlineSlots;
  const endIds = end.set === null ? null : mintSet(mint);
  const endCapId = end.cap === undefined ? null : mint('cap');
  const endBlindId = end.blind === undefined ? null : mint('flange');
  const fits = layoutBranches(env);
  if (isFailure(fits)) return fits;
  const legShift = legShifts(env, inlineSlots, dirs, eps);
  if (isFailure(legShift)) return legShift;
  const shifts = {
    ...legShift,
    start: legShift.start.map((value, leg) => (leg === 0 && start.startAlongMm !== undefined ? value + start.startAlongMm : value)),
  };
  const slotsByLeg = new Map<number, Slot[]>();
  for (const slot of [...inlineSlots, ...fits.filter((fit) => fit.kind === 'tee').map((fit) => teeSlot(env, fit))])
    slotsByLeg.set(slot.leg, [...(slotsByLeg.get(slot.leg) ?? []), slot]);
  const joints: Joint[] = [];
  return {
    env,
    start,
    end,
    dnStart: i.dnStart,
    dnEnd: i.dnEnd,
    od: i.od,
    points,
    dirs,
    lengths,
    eps,
    chosen: i.chosen,
    shifts,
    slotsByLeg,
    fits,
    mint,
    startIds,
    startCapId,
    startBlindId,
    endIds,
    endCapId,
    endBlindId,
    flangedKind: env.lookup.connection('FL', 'FL')?.joint ?? 'flanged',
    parts: [],
    joints,
    legs: [],
    inline: [],
    warnings: [
      ...shifts.warnings,
      ...fits.flatMap((fit) =>
        fit.residualMm === undefined
          ? []
          : [
              {
                code: 'RTE_ECCENTRIC_OFFSET',
                ids: [run.id, fit.point.id],
                message: `branch ${fit.point.id}: the eccentric offset of the header is not exactly along the branch; the ${+fit.residualMm.toFixed(4)} mm sideways residual is dropped (within the angle tolerance)`,
                detail: { branch: fit.point.id, residualMm: fit.residualMm },
              },
            ],
      ),
      ...i.chosen.warnings,
    ],
    addJoint: (joint): void => {
      if (joint.parts.some((id) => id.startsWith('open:'))) return;
      joints.push({ id: `${run.id}/joint-${joints.length + 1}`, ...joint });
    },
  };
}

function assemble(c: RunCtx, pipe: PipeInfo, dnStart: number, dnEnd: number): RunDerivation {
  const { env, parts, fits } = c;
  const { lookup } = env;
  const pieces = parts.filter((part) => part.kind === 'pipe');
  const reasons = unverifiedReasons(lookup, parts);
  const trueLengths = c.lengths.map((length, leg) => length - (c.shifts.start[leg] as number));
  return {
    ok: true,
    parts,
    joints: c.joints,
    legs: c.legs,
    turns: c.chosen.turns,
    inline: c.inline,
    branches: fits.map((fit) => derivedBranch(env, fit)),
    warnings: c.warnings,
    centrelineLengthMm: centrelineLength(trueLengths, c.chosen.elbows),
    totalPipeMm: pieces.reduce((sum, part) => sum + (part.cutLength ?? 0), 0),
    spec: { id: lookup.id, revision: lookup.revision, status: lookup.status() },
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
    angleTolerance: env.tolerance,
    weldGap: { valueMm: env.weld?.gapMm ?? 0, defaulted: true },
    weldSpacing: { minimumMm: defaultMinWeldSpacing(pipe.wall), defaulted: true },
    pipe: { outsideDiameterMm: pipe.od, wallMm: pipe.wall, key: pipe.row.key },
    dn: { start: dnStart, end: dnEnd },
    studs: parts.reduce((sum, part) => sum + (part.studs ?? 0), 0),
    reviewRequired: fits
      .filter((fit) => fit.reviewRequired)
      .map((fit) => `RTE_STUB_IN_REVIEW: ${fit.point.id} (${fit.fittingCode}) needs a reinforcement check (B31.3, 07 pipe stress)`),
  };
}

function derive(doc: CadDocument, run: PipeRun, path: readonly string[]): Derived {
  const env = makeEnv(doc, run);
  if (isFailure(env)) return env;
  const dnStart = startDn(run, env.line.dn);
  const dnEnd = endDn(run, env.line.dn);
  const pipe = env.pipeAt(dnStart);
  if (isFailure(pipe)) return pipe;
  const header = headerFailure(doc, run, path);
  if (header !== undefined) return header;
  const start = setupEnd(env, run.start, 'start', dnStart);
  if (isFailure(start)) return start;
  const end = setupEnd(env, run.end, 'end', dnEnd);
  if (isFailure(end)) return end;
  const geometry = runGeometry(run);
  if (isFailure(geometry)) return geometry;
  const chosen = chooseTurns(env, geometry.points, geometry.dirs);
  if (isFailure(chosen)) return chosen;
  const ctx = layoutRun({ env, start, end, dnStart, dnEnd, od: pipe.od, geometry, chosen });
  if (isFailure(ctx)) return ctx;
  addStartParts(ctx);
  for (let leg = 0; leg < geometry.lengths.length; leg++) {
    const failed = deriveLeg(ctx, leg);
    if (failed !== undefined) return failed;
  }
  const endFailed = addEndParts(ctx);
  if (endFailed !== undefined) return endFailed;
  return assemble(ctx, pipe, dnStart, dnEnd);
}
