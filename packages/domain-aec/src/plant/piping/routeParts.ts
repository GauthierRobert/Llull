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
import { len3, scale3, sub3 } from '@lib/vec3';
import {
  fail,
  isFailure,
  type DerivationFailure,
  type DerivationWarning,
  type DerivedInline,
  type DerivedLeg,
  type DerivedTurn,
  type RunDerivation,
} from './deriveTypes';
import { centrelineLength, chooseElbow, turnAngleDeg, type ElbowChoice } from './fittings';
import { stackLeg, defaultMinWeldSpacing, type Interval, type StackWarning } from './jointStack';
import { directionLabel, epsilonFor, unitVector } from './legs';
import { runPoints } from './model';
import { derivedBranch, layoutBranches, oletPart, teeSlot } from './routeBranch';
import { flangeParts, mintSet, setupEnd } from './routeEnds';
import { at, makeEnv, partOf, type Env, type Mint, type Slot } from './routeEnv';
import { layoutInline } from './routeInline';
import { dnAfter, endDn, startDn } from './runSizes';
import { isMiss, type SpecLookup } from './specLookup';

const BRANCH_KINDS: ReadonlySet<string> = new Set(['olet', 'stubIn']);

/** Warning record of a stack warning on leg `leg`. */
function warningOf(warning: StackWarning, runId: string, leg: number): DerivationWarning {
  const ids = [warning.from, warning.to].filter((id) => id.startsWith(`${runId}/`));
  const message =
    warning.code === 'RTE_WELD_SPACING'
      ? `leg ${leg}: pipe piece of ${+warning.cutLengthMm.toFixed(4)} mm is shorter than the weld spacing ${warning.minimumMm} mm (named default max(4 t, 50 mm))`
      : `leg ${leg}: ${warning.from} and ${warning.to} touch (zero cut length)`;
  return { code: warning.code, ids, message, detail: { leg, cutLengthMm: warning.cutLengthMm, minimumMm: warning.minimumMm ?? null } };
}

function unverifiedReasons(lookup: SpecLookup, parts: readonly RoutedPart[]): string[] {
  const reasons: string[] = [];
  if (lookup.status() !== 'approved') reasons.push(`spec ${lookup.id} r${lookup.revision} is ${lookup.status()}, not approved`);
  const rows = [...new Set(parts.filter((part) => part.unverified).map((part) => part.catalogueKey))];
  if (rows.length > 0) reasons.push(`catalogue rows not grade A: ${rows.join(', ')}`);
  return reasons;
}

/** Elbow choice at every interior point of intersection (the size at a point is the size at the end of the leg before it). */
function chooseTurns(
  env: Env,
  points: readonly Vec3[],
  dirs: readonly Vec3[],
): { elbows: ElbowChoice[]; turns: DerivedTurn[] } | DerivationFailure {
  const { run, line, lookup, tolerance } = env;
  const elbows: ElbowChoice[] = [];
  const turns: DerivedTurn[] = [];
  for (let i = 1; i < dirs.length; i++) {
    const turnDeg = turnAngleDeg(dirs[i - 1] as Vec3, dirs[i] as Vec3);
    const choice = chooseElbow(lookup, dnAfter(run, line.dn, i - 1, Number.POSITIVE_INFINITY), turnDeg, tolerance.valueDeg);
    if (isMiss(choice)) return fail(choice.miss, choice.detail, [...choice.ids, run.id], [`legs.${i}`], { pi: i - 1 });
    if ('code' in choice) return fail(choice.code, choice.message, [run.id], [`legs.${i}`], { ...choice.detail, pi: i - 1 });
    elbows.push(choice);
    turns.push({
      index: i,
      point: points[i] as Vec3,
      partId: `${run.id}/elbow-${i}`,
      turnDeg,
      nominalDeg: choice.nominalDeg,
      deviationDeg: choice.deviationDeg,
      centreToEnd: choice.centreToEnd,
      radius: choice.radius,
      catalogueKey: choice.row.key,
    });
  }
  return { elbows, turns };
}

/**
 * Derives the parts and joints of `run`.
 * @failure unknown line / spec / port, size, rating, facing, end-type or angle problems, a leg too short for its fittings, an inline component or
 *   branch that does not fit or has no spec row -> DerivationFailure with the RTE_* code, the ids involved and the param path
 */
export function deriveRun(doc: CadDocument, run: PipeRun): RunDerivation | DerivationFailure {
  const env = makeEnv(doc, run);
  if (isFailure(env)) return env;
  const { line, lookup, tolerance, weld: bw } = env;
  const dnStart = startDn(run, line.dn);
  const dnEnd = endDn(run, line.dn);
  const pipe = env.pipeAt(dnStart);
  if (isFailure(pipe)) return pipe;
  const { od, wall } = pipe;
  const start = setupEnd(env, run.start, 'start', dnStart);
  if (isFailure(start)) return start;
  const end = setupEnd(env, run.end, 'end', dnEnd);
  if (isFailure(end)) return end;
  const points = runPoints(run);
  const legCount = points.length - 1;
  if (legCount < 1) return fail('RTE_ZERO_LEG', 'the run has no leg', [run.id], []);
  const eps = epsilonFor(...points);
  const lengths = points.slice(1).map((p, i) => len3(sub3(p, points[i] as Vec3)));
  const zero = lengths.findIndex((length) => !(length > eps));
  if (zero >= 0) return fail('RTE_ZERO_LEG', `leg ${zero} of run ${run.id} has zero length`, [run.id], [`legs.${zero}`], { leg: zero });
  const dirs = points.slice(1).map((p, i) => unitVector(sub3(p, points[i] as Vec3)));
  const chosen = chooseTurns(env, points, dirs);
  if (isFailure(chosen)) return chosen;
  const { elbows, turns } = chosen;

  // Ids: kinds are counted separately, in route order; the start set is minted first, then the inline components, then the end set.
  const counters: Record<string, number> = {};
  const mint: Mint = (kind) => `${run.id}/${kind}-${(counters[kind] = (counters[kind] ?? 0) + 1)}`;
  const startIds = start.set === null ? null : mintSet(mint);
  const inlineSlots = layoutInline(env, lengths, mint);
  if (isFailure(inlineSlots)) return inlineSlots;
  const endIds = end.set === null ? null : mintSet(mint);
  const fits = layoutBranches(env);
  if (isFailure(fits)) return fits;
  const slotsByLeg = new Map<number, Slot[]>();
  for (const slot of [...inlineSlots, ...fits.filter((fit) => fit.kind === 'tee').map((fit) => teeSlot(env, fit))])
    slotsByLeg.set(slot.leg, [...(slotsByLeg.get(slot.leg) ?? []), slot]);

  const parts: RoutedPart[] = [];
  const joints: Joint[] = [];
  const warnings: DerivationWarning[] = [];
  const legs: DerivedLeg[] = [];
  const inline: DerivedInline[] = [];
  const addJoint = (joint: Omit<Joint, 'id'>): void => {
    if (joint.parts.some((id) => id.startsWith('open:'))) return;
    joints.push({ id: `${run.id}/joint-${joints.length + 1}`, ...joint });
  };
  const minWeld = defaultMinWeldSpacing(wall);
  const first = points[0] as Vec3;
  const last = points[legCount] as Vec3;
  const flangedRule = lookup.connection('FL', 'FL');
  if (start.set !== null && start.port !== null && startIds !== null) {
    parts.push(...flangeParts(run.id, startIds, start.set, start.port, first, dirs[0] as Vec3, od, true));
    addJoint({
      kind: flangedRule?.joint ?? 'flanged',
      parts: [startIds.flange, start.portId as string],
      position: first,
      gapMm: start.set.gasketThickness,
      accessories: [startIds.gasket, startIds.bolts],
    });
  }
  const external = (id: string): boolean => id === start.portId || id === end.portId || id.startsWith('open:');
  for (let leg = 0; leg < legCount; leg++) {
    const u = dirs[leg] as Vec3;
    const origin = points[leg] as Vec3;
    const length = lengths[leg] as number;
    const mids = slotsByLeg.get(leg) ?? [];
    const startSide = leg === 0 ? start : null;
    const endSide = leg === legCount - 1 ? end : null;
    const head: Interval =
      startSide !== null
        ? {
            id: startIds?.flange ?? startSide.fittingId ?? startSide.portId ?? 'open:start',
            start: 0,
            end: startSide.length,
            gap: startSide.gap,
            kind: 'fitting',
          }
        : {
            id: `${run.id}/elbow-${leg}`,
            start: 0,
            end: (elbows[leg - 1] as ElbowChoice).centreToEnd,
            gap: bw?.gapMm ?? 0,
            kind: 'fitting',
          };
    const tail: Interval =
      endSide !== null
        ? {
            id: endIds?.flange ?? endSide.portId ?? 'open:end',
            start: length - endSide.length,
            end: length,
            gap: endSide.gap,
            kind: 'fitting',
          }
        : {
            id: `${run.id}/elbow-${leg + 1}`,
            start: length - (elbows[leg] as ElbowChoice).centreToEnd,
            end: length,
            gap: bw?.gapMm ?? 0,
            kind: 'fitting',
          };
    const stack = stackLeg(length, [head, ...mids.map((slot) => slot.interval), tail], minWeld, eps);
    if (!stack.ok)
      return fail(
        stack.code,
        `leg ${leg}: ${stack.message}`,
        [run.id, stack.detail.from, stack.detail.to].filter((id) => !external(id)),
        [`legs.${leg}`],
        { ...stack.detail, leg },
      );
    const slotById = new Map(mids.map((slot) => [slot.interval.id, slot]));
    const cuts: number[] = [];
    const legPieces: Array<{ id: string; start: number; end: number }> = [];
    let dnHere = dnAfter(run, line.dn, leg - 1, Number.POSITIVE_INFINITY);
    const weld = bw?.joint ?? 'buttWeld';
    for (let k = 0; k + 1 < stack.order.length; k++) {
      const [a, b] = [stack.order[k] as Interval, stack.order[k + 1] as Interval];
      dnHere = slotById.get(a.id)?.dnOut ?? dnHere;
      const [after, before] = [slotById.get(a.id)?.after ?? a.id, slotById.get(b.id)?.before ?? b.id];
      const piece = stack.pieces.find((candidate) => candidate.from === a.id && candidate.to === b.id);
      if (piece !== undefined) {
        const info = env.pipeAt(dnHere);
        if (isFailure(info)) return info;
        const pieceId = mint('pipe');
        cuts.push(piece.cut);
        legPieces.push({ id: pieceId, start: piece.start, end: piece.end });
        parts.push(
          partOf(
            run.id,
            pieceId,
            'pipe',
            info.row,
            [
              { position: at(origin, u, piece.start), direction: scale3(u, -1), dn: dnHere, endType: 'BW' },
              { position: at(origin, u, piece.end), direction: u, dn: dnHere, endType: 'BW' },
            ],
            { cutLength: piece.cut, leg, dims: { outsideDiameter: info.od, wall: info.wall } },
          ),
        );
        addJoint({ kind: weld, parts: [after, pieceId], position: at(origin, u, a.end), gapMm: a.gap });
        addJoint({ kind: weld, parts: [pieceId, before], position: at(origin, u, b.start), gapMm: b.gap });
      } else addJoint({ kind: 'fittingToFitting', parts: [after, before], position: at(origin, u, a.end), gapMm: 0 });
      const slot = slotById.get(b.id);
      if (slot !== undefined) {
        const built = slot.build(origin, u);
        parts.push(...built.parts);
        built.joints.forEach(addJoint);
        if (built.inline !== undefined) inline.push(built.inline);
      }
    }
    for (const w of stack.warnings) warnings.push(warningOf(w, run.id, leg));
    for (const fit of fits.filter((candidate) => candidate.point.leg === leg && BRANCH_KINDS.has(candidate.kind))) {
      const x = fit.point.distance;
      const margin = fit.branchOd / 2;
      const host = legPieces.find((piece) => piece.start + margin <= x && x <= piece.end - margin);
      if (host === undefined)
        return fail(
          'RTE_BRANCH_ON_FITTING',
          `branch ${fit.point.id} at ${+x.toFixed(4)} mm on leg ${leg} does not lie on a pipe piece with ${+margin.toFixed(2)} mm to each end (${fit.typeKey} needs a straight piece)`,
          [run.id, fit.point.id],
          ['branches'],
          { leg, distance: x, marginMm: margin },
        );
      const olet = oletPart(env, fit, host.id);
      parts.push(olet.part);
      addJoint(olet.joint);
    }
    legs.push({
      index: leg,
      direction: directionLabel(u),
      lengthMm: length,
      start: origin,
      end: points[leg + 1] as Vec3,
      cutLengthsMm: cuts,
    });
    if (leg < legCount - 1) {
      const index = leg + 1;
      const choice = elbows[leg] as ElbowChoice;
      const turn = turns[leg] as DerivedTurn;
      const next = dirs[index] as Vec3;
      const pi = points[index] as Vec3;
      const c = choice.centreToEnd;
      const dn = dnAfter(run, line.dn, leg, Number.POSITIVE_INFINITY);
      const info = env.pipeAt(dn);
      if (isFailure(info)) return info;
      parts.push(
        partOf(
          run.id,
          turn.partId,
          'elbow',
          choice.row,
          [
            { position: at(pi, u, -c), direction: scale3(u, -1), dn, endType: 'BW' },
            { position: at(pi, next, c), direction: next, dn, endType: 'BW' },
          ],
          { centre: pi, angleDeg: choice.turnDeg, radius: choice.radius, dims: { outsideDiameter: info.od, centreToEnd: c } },
        ),
      );
    }
  }
  if (end.set !== null && end.port !== null && endIds !== null) {
    const endPipe = env.pipeAt(dnEnd);
    if (isFailure(endPipe)) return endPipe;
    const into = scale3(dirs[legCount - 1] as Vec3, -1);
    parts.push(...flangeParts(run.id, endIds, end.set, end.port, last, into, endPipe.od, false));
    addJoint({
      kind: flangedRule?.joint ?? 'flanged',
      parts: [endIds.flange, end.portId as string],
      position: last,
      gapMm: end.set.gasketThickness,
      accessories: [endIds.gasket, endIds.bolts],
    });
  }
  const pieces = parts.filter((part) => part.kind === 'pipe');
  const reasons = unverifiedReasons(lookup, parts);
  return {
    ok: true,
    parts,
    joints,
    legs,
    turns,
    inline,
    branches: fits.map((fit) => derivedBranch(env, fit)),
    warnings,
    centrelineLengthMm: centrelineLength(lengths, elbows),
    totalPipeMm: pieces.reduce((sum, part) => sum + (part.cutLength ?? 0), 0),
    spec: { id: lookup.id, revision: lookup.revision, status: lookup.status() },
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
    angleTolerance: tolerance,
    weldGap: { valueMm: bw?.gapMm ?? 0, defaulted: true },
    weldSpacing: { minimumMm: minWeld, defaulted: true },
    pipe: { outsideDiameterMm: od, wallMm: wall, key: pipe.row.key },
    dn: { start: dnStart, end: dnEnd },
    studs: parts.reduce((sum, part) => sum + (part.studs ?? 0), 0),
    reviewRequired: fits
      .filter((fit) => fit.reviewRequired)
      .map((fit) => `RTE_STUB_IN_REVIEW: ${fit.point.id} (${fit.fittingCode}) needs a reinforcement check (B31.3, 07 pipe stress)`),
  };
}
