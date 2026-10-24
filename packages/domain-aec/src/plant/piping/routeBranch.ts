/**
 * Branches (02 RTE §5.5): the branch-table fitting of every branch point of a header run (tee / reducing tee split the header leg, olets and
 * stub-ins sit on a pipe piece), the slot a tee occupies, the olet / stub-in part, and the start of a branch run (the fitting its first pipe welds to).
 * @invariant fitting ids are `<headerRunId>/<tee|olet|stubIn>-<k>`, k counted per kind in route order (leg, distance), so a header and its
 *   branch runs mint the same id
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { BranchPoint, EndType, Joint, PartPort, PipeRun, PortRef, PortSpec, RoutedPart } from '@aec/plant/types';
import { dot3, len3, scale3, sub3 } from '@lib/vec3';
import { fail, isFailure, type DerivationFailure, type DerivedBranch } from './deriveTypes';
import { unitVector } from './legs';
import { getPiping, runPoints } from './model';
import { at, bwPort, makeEnv, partOf, type EndSetup, type Env, type Slot } from './routeEnv';
import { dnAfter, startDn } from './runSizes';
import { isMiss, type CatalogueRow } from './specLookup';

export interface BranchFit {
  readonly point: BranchPoint;
  readonly kind: DerivedBranch['kind'];
  /** Branch-table cell (T, RT, W, S, TH, SI, SIR). */
  readonly fittingCode: string;
  readonly typeKey: string;
  /** The fitting's catalogue row; null for a stub-in. */
  readonly row: CatalogueRow | null;
  readonly partId: string;
  readonly headerDn: number;
  readonly branchDn: number;
  readonly headerOd: number;
  readonly branchOd: number;
  /** Centre of the branch on the header axis, and the unit direction of the branch. */
  readonly position: Vec3;
  readonly direction: Vec3;
  /** Tee M, olet A (centre of the header to the outlet face), stub-in OD / 2: where the branch pipe starts along the branch. */
  readonly branchStart: number;
  /** Where `branchStart` came from (named in results). */
  readonly branchStartSource: string;
  /** Tee: centre-to-end on the run, each side of the branch point. */
  readonly runHalf: number | null;
  readonly outletEnd: EndType;
  readonly reviewRequired: boolean;
}

const OLETS: ReadonlySet<string> = new Set(['W', 'S', 'TH']);

interface Dimension {
  readonly value: number;
  readonly source: string;
}

/** Outlet distance of an olet: `centreToOutlet` (MSS SP-97 dimension A, from the header centreline), else `height` above the header surface. */
function oletOutlet(row: CatalogueRow, headerOd: number): Dimension | string {
  const a = row.dims['centreToOutlet'];
  if (a !== undefined && a > 0) return { value: a, source: `${row.key} centreToOutlet (A)` };
  const height = row.dims['height'];
  if (height !== undefined && height > 0) return { value: headerOd / 2 + height, source: `${row.key} height + header OD / 2` };
  return `olet row ${row.key} has neither centreToOutlet (A) nor height (${row.source})`;
}

function teeDimensions(row: CatalogueRow): { run: number; branch: Dimension } | string {
  const run = row.dims['centreToEndRun'];
  if (run === undefined || !(run > 0)) return `tee row ${row.key} has no centreToEndRun (C) (${row.source})`;
  const m = row.dims['centreToEndBranch'];
  if (m !== undefined && m > 0) return { run, branch: { value: m, source: `${row.key} centreToEndBranch (M)` } };
  if (row.type === 'tee') return { run, branch: { value: run, source: `${row.key} centreToEndRun (equal tee: M = C, ASME B16.9)` } };
  return `reducing tee row ${row.key} has no centreToEndBranch (M) (${row.source})`;
}

/**
 * The fitting of every branch point of the run in `env`, in route order.
 * @failure missing branch run / geometry, no branch-table cell (RTE_BRANCH_NO_TABLE_ROW), missing spec row or dimension (RTE_SPEC_NO_COMPONENT),
 *   an outlet the spec cannot weld to (RTE_NO_CONNECTION_RULE)
 */
export function layoutBranches(env: Env): BranchFit[] | DerivationFailure {
  const { doc, run, line, lookup } = env;
  const piping = getPiping(doc);
  const points = runPoints(run);
  const counters: Record<string, number> = {};
  const fits: BranchFit[] = [];
  const sorted = [...(run.branches ?? [])].sort((a, b) => a.leg - b.leg || a.distance - b.distance);
  for (const point of sorted) {
    const branchRun = piping.runs[point.branchRunId];
    const branchLine = branchRun === undefined ? undefined : piping.lines[branchRun.lineId];
    if (branchRun === undefined || branchLine === undefined)
      return fail(
        'RTE_UNKNOWN_RUN',
        `branch ${point.id} of ${run.id} names run ${point.branchRunId}, which does not exist`,
        [point.id, point.branchRunId],
        ['branches'],
      );
    const [from, to] = [points[point.leg], points[point.leg + 1]];
    if (from === undefined || to === undefined || !(point.distance > 0) || !(point.distance < len3(sub3(to, from))))
      return fail(
        'RTE_BRANCH_ON_FITTING',
        `branch ${point.id} is not on leg ${point.leg} of run ${run.id}`,
        [run.id, point.id],
        ['branches'],
        { leg: point.leg, distance: point.distance },
      );
    const direction = unitVector(branchRun.start.direction ?? [0, 0, 0]);
    if (!(len3(direction) > 0))
      return fail('RTE_INVALID_PORT', `branch run ${branchRun.id} has no start direction`, [branchRun.id], ['branches']);
    const headerDn = dnAfter(run, line.dn, point.leg, point.distance);
    const branchDn = startDn(branchRun, branchLine.dn);
    const choice = lookup.branch(headerDn, branchDn);
    if (isMiss(choice)) return fail(choice.miss, choice.detail, [...choice.ids, point.id], ['branches'], { headerDn, branchDn });
    const [headerPipe, branchPipe] = [env.pipeAt(headerDn), env.pipeAt(branchDn)];
    if (isFailure(headerPipe)) return headerPipe;
    if (isFailure(branchPipe)) return branchPipe;
    const kind: BranchFit['kind'] = choice.row === null ? 'stubIn' : OLETS.has(choice.fitting) ? 'olet' : 'tee';
    const base = {
      point,
      kind,
      fittingCode: choice.fitting,
      row: choice.row,
      headerDn,
      branchDn,
      headerOd: headerPipe.od,
      branchOd: branchPipe.od,
      position: at(from, unitVector(sub3(to, from)), point.distance),
      direction,
      reviewRequired: kind === 'stubIn',
    };
    const partId = `${run.id}/${kind}-${(counters[kind] = (counters[kind] ?? 0) + 1)}`;
    const typeKey = choice.row === null ? 'stubIn' : `${choice.row.type}${choice.row.radius ?? ''}`;
    const outlet = (end: EndType): DerivationFailure | null =>
      lookup.connection(end, 'BW') === null
        ? fail(
            'RTE_NO_CONNECTION_RULE',
            `spec ${lookup.id} has no rule joining the ${end} outlet of ${typeKey} (${point.id}) to a butt-weld branch pipe`,
            [point.id],
            ['branches'],
            { outletEnd: end },
          )
        : null;
    if (choice.row === null) {
      fits.push({
        ...base,
        typeKey,
        partId,
        branchStart: headerPipe.od / 2,
        branchStartSource: 'header outside radius (stub-in)',
        runHalf: null,
        outletEnd: 'BW',
      });
      continue;
    }
    const outletEnd = choice.row.ends[0] ?? 'BW';
    const refused = outlet(outletEnd);
    if (refused !== null) return refused;
    const sizes = kind === 'tee' ? teeDimensions(choice.row) : oletOutlet(choice.row, headerPipe.od);
    if (typeof sizes === 'string') return fail('RTE_SPEC_NO_COMPONENT', sizes, [choice.row.key, point.id], ['branches']);
    const [runHalf, start]: [number | null, Dimension] = 'run' in sizes ? [sizes.run, sizes.branch] : [null, sizes];
    fits.push({ ...base, typeKey, partId, branchStart: start.value, branchStartSource: start.source, runHalf, outletEnd });
  }
  return overlap(run.id, fits) ?? fits;
}

/** Footprint radius of an olet or stub-in on the header surface: half its base diameter if the row has one, else the branch pipe radius. */
const footprint = (fit: BranchFit): number => (fit.row?.dims['baseDiameter'] ?? fit.branchOd) / 2;

/**
 * Two olets / stub-ins whose footprints touch on the header surface collide (§5.5: a branch point inside another fitting's interval). The footprints are
 * discs of radius r1, r2; their centres are |dx| apart along the header and R x angle apart round it (R = header outside radius, angle = the angle between
 * the two branch directions), so branches in different directions are allowed when sqrt(dx^2 + (R angle)^2) >= r1 + r2.
 */
function overlap(runId: string, fits: readonly BranchFit[]): DerivationFailure | null {
  const sits = fits.filter((fit) => fit.kind !== 'tee');
  for (let i = 0; i < sits.length; i++)
    for (let j = i + 1; j < sits.length; j++) {
      const [a, b] = [sits[i] as BranchFit, sits[j] as BranchFit];
      if (a.point.leg !== b.point.leg) continue;
      const dx = Math.abs(a.point.distance - b.point.distance);
      const angle = Math.acos(Math.max(-1, Math.min(1, dot3(a.direction, b.direction))));
      const apart = Math.hypot(dx, (a.headerOd / 2) * angle);
      const needed = footprint(a) + footprint(b);
      if (apart < needed)
        return fail(
          'RTE_BRANCH_ON_FITTING',
          `branches ${a.point.id} and ${b.point.id} of run ${runId} overlap on the header: their centres are ${+apart.toFixed(2)} mm apart on the surface, the footprints need ${+needed.toFixed(2)} mm`,
          [runId, a.point.id, b.point.id],
          ['branches'],
          { distanceMm: apart, requiredMm: needed },
        );
    }
  return null;
}

/** The slot a tee occupies on its header leg: centre-to-end C each side of the branch point. */
export function teeSlot(env: Env, fit: BranchFit): Slot {
  const half = fit.runHalf as number;
  return {
    interval: {
      id: fit.point.id,
      start: fit.point.distance - half,
      end: fit.point.distance + half,
      gap: env.weld?.gapMm ?? 0,
      kind: 'branch',
    },
    leg: fit.point.leg,
    before: fit.partId,
    after: fit.partId,
    dnOut: fit.headerDn,
    build: (origin, u) => {
      const centre = at(origin, u, fit.point.distance);
      const branchPort: PartPort = {
        position: at(centre, fit.direction, fit.branchStart),
        direction: fit.direction,
        dn: fit.branchDn,
        endType: 'BW',
      };
      const ports = [bwPort(at(centre, u, -half), scale3(u, -1), fit.headerDn), bwPort(at(centre, u, half), u, fit.headerDn), branchPort];
      const part = partOf(env.run.id, fit.partId, 'tee', fit.row as CatalogueRow, ports, {
        centre,
        componentId: fit.point.id,
        dn: fit.headerDn,
        dn2: fit.branchDn,
        dims: { ...(fit.row as CatalogueRow).dims, outsideDiameter: fit.headerOd, branchOutsideDiameter: fit.branchOd },
      });
      return { parts: [part], joints: [] };
    },
  };
}

/**
 * The olet / stub-in part welded to header pipe piece `onPart`, and the weld joint.
 * @invariant ports: the header-surface face (facing the header) and the outlet face (centre + branchStart along the branch)
 */
export function oletPart(env: Env, fit: BranchFit, onPart: string): { part: RoutedPart; joint: Omit<Joint, 'id'> } {
  const base = at(fit.position, fit.direction, fit.headerOd / 2);
  const outlet = at(fit.position, fit.direction, fit.branchStart);
  const ports: PartPort[] = [
    { position: base, direction: [-fit.direction[0], -fit.direction[1], -fit.direction[2]], dn: fit.headerDn, endType: 'BW' },
    { position: outlet, direction: fit.direction, dn: fit.branchDn, endType: fit.outletEnd },
  ];
  const extra = {
    centre: fit.position,
    componentId: fit.point.id,
    onPart,
    dn: fit.headerDn,
    dn2: fit.branchDn,
    dims: { ...(fit.row?.dims ?? {}), outsideDiameter: fit.headerOd, branchOutsideDiameter: fit.branchOd },
  };
  const part: RoutedPart =
    fit.row === null
      ? {
          id: fit.partId,
          runId: env.run.id,
          kind: 'stubIn',
          catalogueKey: `${env.lookup.id}/stubIn/${fit.headerDn}x${fit.branchDn}`,
          typeKey: 'stubIn',
          ports,
          unverified: true,
          ...extra,
        }
      : partOf(env.run.id, fit.partId, 'olet', fit.row, ports, extra);
  return { part, joint: { kind: 'branchWeld', parts: [fit.partId, onPart], position: base, gapMm: 0 } };
}

const layouts = new WeakMap<CadDocument, Map<PipeRun, BranchFit[] | DerivationFailure>>();

/** The branch fittings of a header run, computed once per document and run however many branch runs ask (a header with k branches is laid out once, not k times). */
function headerLayout(doc: CadDocument, header: PipeRun): BranchFit[] | DerivationFailure {
  const known = layouts.get(doc)?.get(header);
  if (known !== undefined) return known;
  const env = makeEnv(doc, header);
  const result = isFailure(env) ? env : layoutBranches(env);
  const memo = layouts.get(doc) ?? new Map<PipeRun, BranchFit[] | DerivationFailure>();
  memo.set(header, result);
  layouts.set(doc, memo);
  return result;
}

/** The `DerivedBranch` record of a fit. */
export const derivedBranch = (env: Env, fit: BranchFit): DerivedBranch => ({
  id: fit.point.id,
  headerRunId: env.run.id,
  branchRunId: fit.point.branchRunId,
  leg: fit.point.leg,
  distance: fit.point.distance,
  kind: fit.kind,
  fittingCode: fit.fittingCode,
  typeKey: fit.typeKey,
  partId: fit.partId,
  position: fit.position,
  direction: fit.direction,
  headerDn: fit.headerDn,
  branchDn: fit.branchDn,
  branchStartMm: fit.branchStart,
  branchStartSource: fit.branchStartSource,
  runCentreToEndMm: fit.runHalf,
  reviewRequired: fit.reviewRequired,
});

/**
 * The setup of a branch run's start: the first pipe piece welds to the header fitting, `branchStart` away from the header centreline.
 * @invariant called with a branch port that resolved (`portOfRef`): the header, its branch point and the branch run exist
 * @failure the header (its spec, another of its branches) no longer derives -> that failure, prefixed with the header id
 */
export function branchStartSetup(
  env: Env,
  ref: Extract<PortRef, { kind: 'branch' }>,
  port: PortSpec,
  portId: string,
): EndSetup | DerivationFailure {
  const header = getPiping(env.doc).runs[ref.runId] as PipeRun;
  const fits = headerLayout(env.doc, header);
  if (isFailure(fits)) return { ...fits, message: `header ${header.id}: ${fits.message}` };
  const fit = fits.find((candidate) => candidate.point.id === ref.branchId) as BranchFit;
  return {
    length: fit.branchStart,
    gap: fit.kind === 'stubIn' ? 0 : (env.weld?.gapMm ?? 0),
    set: null,
    port,
    portId,
    fittingId: fit.partId,
    ...(fit.kind === 'stubIn' ? { weldless: true } : {}),
  };
}
