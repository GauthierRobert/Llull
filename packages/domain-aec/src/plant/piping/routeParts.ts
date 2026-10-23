/**
 * Run derivation (02 RTE §2 "stored intent, derived parts"): a stored `PipeRun` + its line's spec -> `RoutedPart[]` and `Joint[]` in route order
 * with deterministic ids (`<runId>/<kind>-<k>`, AF-13), cut lengths (§5.3), the turn table (§5.2) and the centreline length. Every run goes
 * through this one derivation, including runs made by `auto_route_pipe`. Pure: nothing is stored.
 * @invariant ids depend only on route order; the same document and run always give the same parts, joints and numbers
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { Joint, PartPort, PipeLine, PipeRun, PortSpec, RoutedPart, RunEnd } from '@aec/plant/types';
import { add3, len3, scale3, sub3 } from '@lib/vec3';
import { centrelineLength, chooseElbow, turnAngleDeg, type ElbowChoice } from './fittings';
import { resolveFlangeSet, type FlangeSet } from './flangeSet';
import { stackLeg, defaultMinWeldSpacing, type Interval, type StackWarning } from './jointStack';
import { angleBetweenDeg, directionLabel, epsilonFor, unitVector, type Compass } from './legs';
import { getPiping, runPoints } from './model';
import { portIdOf, portOfRef } from './ports';
import { createSpecLookup, isMiss, type CatalogueRow, type SpecLookup } from './specLookup';

export interface DerivationFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

export interface DerivedLeg {
  readonly index: number;
  readonly direction: Compass | Vec3;
  readonly lengthMm: number;
  readonly start: Vec3;
  readonly end: Vec3;
  /** Cut lengths of the pipe pieces on this leg, in order. */
  readonly cutLengthsMm: readonly number[];
}

export interface DerivedTurn {
  /** Index of the point of intersection (1-based: the turn between leg index-1 and leg index). */
  readonly index: number;
  readonly point: Vec3;
  readonly partId: string;
  readonly turnDeg: number;
  readonly nominalDeg: number;
  readonly deviationDeg: number;
  readonly centreToEnd: number;
  readonly radius: number;
  readonly catalogueKey: string;
}

export interface DerivationWarning {
  readonly code: string;
  readonly ids: readonly string[];
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface RunDerivation {
  readonly ok: true;
  readonly parts: readonly RoutedPart[];
  readonly joints: readonly Joint[];
  readonly legs: readonly DerivedLeg[];
  readonly turns: readonly DerivedTurn[];
  readonly warnings: readonly DerivationWarning[];
  readonly centrelineLengthMm: number;
  readonly totalPipeMm: number;
  readonly spec: { readonly id: string; readonly revision: number; readonly status: string };
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly angleTolerance: { readonly valueDeg: number; readonly source: 'run' | 'spec' | 'default' };
  readonly weldGap: { readonly valueMm: number; readonly defaulted: true };
  readonly weldSpacing: { readonly minimumMm: number; readonly defaulted: true };
  readonly pipe: { readonly outsideDiameterMm: number; readonly wallMm: number; readonly key: string };
  readonly studs: number;
}

const fail = (
  code: string,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
  detail?: Readonly<Record<string, unknown>>,
): DerivationFailure => ({ ok: false, code, message, ids, paths, detail });

const at = (origin: Vec3, direction: Vec3, distance: number): Vec3 => add3(origin, scale3(direction, distance));

interface EndSetup {
  /** Interval length occupied next to the port (flange set), mm. */
  readonly length: number;
  readonly gap: number;
  readonly set: FlangeSet | null;
  readonly port: PortSpec | null;
  readonly portId: string | null;
}

const isFailure = (value: object): value is DerivationFailure => 'ok' in value && value.ok === false;

/** What the port at one run end needs next to the pipe: nothing (open end), a butt weld (BW) or a flange set (FL). */
function setupEnd(doc: CadDocument, lookup: SpecLookup, line: PipeLine, end: RunEnd, side: 'start' | 'end'): EndSetup | DerivationFailure {
  const weld = lookup.connection('BW', 'BW');
  if (end.ref === undefined) return { length: 0, gap: 0, set: null, port: null, portId: null };
  const port = portOfRef(doc, end.ref);
  const portId = portIdOf(doc, end.ref);
  if (port === null) return fail('RTE_UNKNOWN_PORT', `the ${side} port ${portId} no longer exists`, [portId], [side]);
  if (port.dn !== line.dn)
    return fail('RTE_SIZE_MISMATCH', `port ${portId} is DN${port.dn}, line ${line.id} is DN${line.dn}`, [portId, line.id], [side]);
  const moved = sub3(port.position, end.point);
  if (len3(moved) > epsilonFor(port.position, end.point))
    return fail(
      'RTE_STRETCH_FAILED',
      `port ${portId} is ${moved.map((v) => +v.toFixed(3)).join(', ')} mm from where the run ${side} was routed (the equipment or tie-in moved)`,
      [portId],
      [side],
      { moved },
    );
  if (end.direction !== undefined && angleBetweenDeg(unitVector(end.direction), unitVector(port.direction)) > 1e-4)
    return fail(
      'RTE_STRETCH_FAILED',
      `port ${portId} now faces ${port.direction.map((v) => +v.toFixed(6)).join(', ')} but the run ${side} was routed along ${end.direction.map((v) => +v.toFixed(6)).join(', ')} (the equipment was turned)`,
      [portId],
      [side],
      { portDirection: port.direction, routedDirection: end.direction },
    );
  if (weld === null) return fail('RTE_NO_CONNECTION_RULE', `spec ${lookup.id} has no BW-BW connection rule`, [lookup.id], [side]);
  if (port.endType === 'BW') return { length: 0, gap: weld.gapMm, set: null, port, portId };
  if (port.endType !== 'FL' || lookup.connection('FL', 'FL') === null)
    return fail(
      'RTE_NO_CONNECTION_RULE',
      `spec ${lookup.id} has no rule joining a butt-weld pipe end to a ${port.endType} port (${portId})`,
      [portId],
      [side],
      { portEndType: port.endType },
    );
  const set = resolveFlangeSet(lookup, port, line.dn);
  if ('code' in set) return fail(set.code, set.message, set.ids, [side], set.detail);
  return { length: set.length, gap: weld.gapMm, set, portId, port };
}

const partOf = (
  runId: string,
  id: string,
  kind: RoutedPart['kind'],
  row: CatalogueRow,
  ports: readonly PartPort[],
  extra: Partial<RoutedPart> = {},
): RoutedPart => ({
  id,
  runId,
  kind,
  catalogueKey: row.key,
  typeKey: `${row.type}${row.radius ?? ''}`,
  dn: row.dn,
  ports,
  dims: row.dims,
  unverified: row.unverified,
  ...extra,
});

/** Gasket, bolt set and flange of the set at `port`, in route order away from the port when `away`, else toward it. */
function flangeParts(
  runId: string,
  ids: { gasket: string; bolts: string; flange: string },
  set: FlangeSet,
  port: PortSpec,
  origin: Vec3,
  into: Vec3,
  pipeOd: number,
  away: boolean,
): RoutedPart[] {
  const g = set.gasketThickness;
  const fl = (position: Vec3, direction: Vec3, end: 'FL' | 'BW'): PartPort => ({
    position,
    direction,
    dn: set.flange.dn,
    endType: end,
    ...(end === 'FL' && port.rating !== undefined ? { rating: port.rating } : {}),
    ...(end === 'FL' && port.facing !== undefined ? { facing: port.facing } : {}),
  });
  const out = scale3(into, -1);
  const order = <T>(towardPipe: readonly T[]): T[] => (away ? [...towardPipe] : [...towardPipe].reverse());
  const gasket = partOf(runId, ids.gasket, 'gasket', set.gasket, order([fl(origin, out, 'FL'), fl(at(origin, into, g), into, 'FL')]), {
    centre: at(origin, into, g / 2),
    dims: { ...set.gasket.dims, pipeOutsideDiameter: pipeOd },
  });
  const bolts = partOf(runId, ids.bolts, 'boltSet', set.bolts, [], { centre: at(origin, into, g / 2), studs: set.studs });
  const flange = partOf(
    runId,
    ids.flange,
    'flange',
    set.flange,
    order([fl(at(origin, into, g), out, 'FL'), fl(at(origin, into, g + set.hub), into, 'BW')]),
    { dims: { ...set.flange.dims, pipeOutsideDiameter: pipeOd } },
  );
  return away ? [gasket, bolts, flange] : [flange, bolts, gasket];
}

/**
 * Derives the parts and joints of `run`.
 * @failure unknown line / spec / port, size, rating, facing, end-type or angle problems, a leg too short for its fittings -> DerivationFailure
 *   with the RTE_* code, the ids involved and the param path
 */
export function deriveRun(doc: CadDocument, run: PipeRun): RunDerivation | DerivationFailure {
  const line = getPiping(doc).lines[run.lineId];
  if (line === undefined) return fail('RTE_UNKNOWN_LINE', `no pipe line "${run.lineId}"`, [run.lineId], ['lineId']);
  const lookup = createSpecLookup(doc, line.spec);
  if (isMiss(lookup)) return fail(lookup.miss, lookup.detail, [...lookup.ids, line.id], ['lineId']);
  const pipe = lookup.pipe(line.dn);
  if (isMiss(pipe)) return fail(pipe.miss, pipe.detail, [...pipe.ids, line.id], ['lineId']);
  const od = pipe.dims['outsideDiameter'];
  const wall = pipe.dims['wall'];
  if (od === undefined || wall === undefined)
    return fail('RTE_SPEC_NO_COMPONENT', `pipe row ${pipe.key} lacks outsideDiameter / wall (${pipe.source})`, [pipe.key], ['lineId']);
  const rule = lookup.elbowAngles();
  const tolerance =
    run.angleToleranceDeg !== undefined
      ? { valueDeg: run.angleToleranceDeg, source: 'run' as const }
      : { valueDeg: rule.toleranceDeg, source: rule.defaulted ? ('default' as const) : ('spec' as const) };
  const start = setupEnd(doc, lookup, line, run.start, 'start');
  if (isFailure(start)) return start;
  const end = setupEnd(doc, lookup, line, run.end, 'end');
  if (isFailure(end)) return end;
  const points = runPoints(run);
  const legCount = points.length - 1;
  if (legCount < 1) return fail('RTE_ZERO_LEG', 'the run has no leg', [run.id], []);
  const eps = epsilonFor(...points);
  const lengths = points.slice(1).map((p, i) => len3(sub3(p, points[i] as Vec3)));
  const zero = lengths.findIndex((length) => !(length > eps));
  if (zero >= 0) return fail('RTE_ZERO_LEG', `leg ${zero} of run ${run.id} has zero length`, [run.id], [`legs.${zero}`], { leg: zero });
  const dirs = points.slice(1).map((p, i) => unitVector(sub3(p, points[i] as Vec3)));

  // Turns: one catalogue elbow per interior point of intersection.
  const elbows: ElbowChoice[] = [];
  const turns: DerivedTurn[] = [];
  for (let i = 1; i < legCount; i++) {
    const turnDeg = turnAngleDeg(dirs[i - 1] as Vec3, dirs[i] as Vec3);
    const choice = chooseElbow(lookup, line.dn, turnDeg, tolerance.valueDeg);
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

  // Ids: kinds are counted separately, in route order; the start set is minted before the end set.
  const counters: Record<string, number> = {};
  const mint = (kind: RoutedPart['kind']): string => `${run.id}/${kind}-${(counters[kind] = (counters[kind] ?? 0) + 1)}`;
  const setIds = (set: FlangeSet | null): { gasket: string; bolts: string; flange: string } | null =>
    set === null ? null : { gasket: mint('gasket'), bolts: mint('boltSet'), flange: mint('flange') };
  const startIds = setIds(start.set);
  const endIds = setIds(end.set);
  const parts: RoutedPart[] = [];
  const joints: Joint[] = [];
  const warnings: DerivationWarning[] = [];
  const legs: DerivedLeg[] = [];
  const jointId = (): string => `${run.id}/joint-${joints.length + 1}`;
  const bw = lookup.connection('BW', 'BW');
  const minWeld = defaultMinWeldSpacing(wall);
  const first = points[0] as Vec3;
  const last = points[legCount] as Vec3;
  if (start.set !== null && start.port !== null && startIds !== null) {
    parts.push(...flangeParts(run.id, startIds, start.set, start.port, first, dirs[0] as Vec3, od, true));
    joints.push({
      id: jointId(),
      kind: lookup.connection('FL', 'FL')?.joint ?? 'flanged',
      parts: [startIds.flange, start.portId as string],
      position: first,
      gapMm: start.set.gasketThickness,
      accessories: [startIds.gasket, startIds.bolts],
    });
  }
  const external = (id: string): boolean => id === start.portId || id === end.portId || id.startsWith('open:');
  const pushJoint = (a: string, b: string, kind: Joint['kind'], position: Vec3, gapMm: number): void => {
    if (a.startsWith('open:') || b.startsWith('open:')) return;
    joints.push({ id: jointId(), kind, parts: [a, b], position, gapMm });
  };
  for (let leg = 0; leg < legCount; leg++) {
    const u = dirs[leg] as Vec3;
    const origin = points[leg] as Vec3;
    const length = lengths[leg] as number;
    const startFlange = leg === 0 ? start : null;
    const endFlange = leg === legCount - 1 ? end : null;
    const intervals: Interval[] = [
      startFlange !== null
        ? {
            id: startIds?.flange ?? startFlange.portId ?? 'open:start',
            start: 0,
            end: startFlange.length,
            gap: startFlange.gap,
            kind: 'fitting',
          }
        : {
            id: `${run.id}/elbow-${leg}`,
            start: 0,
            end: (elbows[leg - 1] as ElbowChoice).centreToEnd,
            gap: bw?.gapMm ?? 0,
            kind: 'fitting',
          },
      endFlange !== null
        ? {
            id: endIds?.flange ?? endFlange.portId ?? 'open:end',
            start: length - endFlange.length,
            end: length,
            gap: endFlange.gap,
            kind: 'fitting',
          }
        : {
            id: `${run.id}/elbow-${leg + 1}`,
            start: length - (elbows[leg] as ElbowChoice).centreToEnd,
            end: length,
            gap: bw?.gapMm ?? 0,
            kind: 'fitting',
          },
    ];
    const stack = stackLeg(length, intervals, minWeld, eps);
    if (!stack.ok)
      return fail(
        stack.code,
        `leg ${leg}: ${stack.message}`,
        [run.id, stack.detail.from, stack.detail.to].filter((id) => !external(id)),
        [`legs.${leg}`],
        { ...stack.detail, leg },
      );
    const cuts: number[] = [];
    const piece = stack.pieces[0];
    let pieceId: string | null = null;
    if (piece !== undefined) {
      pieceId = mint('pipe');
      cuts.push(piece.cut);
      parts.push(
        partOf(
          run.id,
          pieceId,
          'pipe',
          pipe,
          [
            { position: at(origin, u, piece.start), direction: scale3(u, -1), dn: line.dn, endType: 'BW' },
            { position: at(origin, u, piece.end), direction: u, dn: line.dn, endType: 'BW' },
          ],
          { cutLength: piece.cut, leg, dims: { outsideDiameter: od, wall } },
        ),
      );
    }
    const [a, b] = intervals as [Interval, Interval];
    const weld = bw?.joint ?? 'buttWeld';
    if (pieceId !== null && piece !== undefined) {
      pushJoint(a.id, pieceId, weld, at(origin, u, a.end), a.gap);
      pushJoint(pieceId, b.id, weld, at(origin, u, b.start), b.gap);
    } else {
      const together = stack.fittingToFitting[0];
      if (together !== undefined) pushJoint(a.id, b.id, 'fittingToFitting', at(origin, u, together.at), 0);
    }
    for (const w of stack.warnings) warnings.push(warningOf(w, run.id, leg));
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
      parts.push(
        partOf(
          run.id,
          turn.partId,
          'elbow',
          choice.row,
          [
            { position: at(pi, u, -c), direction: scale3(u, -1), dn: line.dn, endType: 'BW' },
            { position: at(pi, next, c), direction: next, dn: line.dn, endType: 'BW' },
          ],
          { centre: pi, angleDeg: choice.turnDeg, radius: choice.radius, dims: { outsideDiameter: od, centreToEnd: c } },
        ),
      );
    }
  }
  if (end.set !== null && end.port !== null && endIds !== null) {
    const into = scale3(dirs[legCount - 1] as Vec3, -1);
    parts.push(...flangeParts(run.id, endIds, end.set, end.port, last, into, od, false));
    joints.push({
      id: jointId(),
      kind: lookup.connection('FL', 'FL')?.joint ?? 'flanged',
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
    warnings,
    centrelineLengthMm: centrelineLength(lengths, elbows),
    totalPipeMm: pieces.reduce((sum, part) => sum + (part.cutLength ?? 0), 0),
    spec: { id: lookup.id, revision: lookup.revision, status: lookup.status() },
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
    angleTolerance: tolerance,
    weldGap: { valueMm: bw?.gapMm ?? 0, defaulted: true },
    weldSpacing: { minimumMm: minWeld, defaulted: true },
    pipe: { outsideDiameterMm: od, wallMm: wall, key: pipe.key },
    studs: parts.reduce((sum, part) => sum + (part.studs ?? 0), 0),
  };
}

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
