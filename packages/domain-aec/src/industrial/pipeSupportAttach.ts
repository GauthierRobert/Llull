/**
 * Which steel a pipe support bears on, and keeping that true when the model is edited: a deleted
 * member re-attaches its supports to the nearest steel in reach (else they become unattached), a moved
 * pipe or member re-runs the reach test at the new position.
 * @layer domain-aec
 * @pure
 */

import type { BuildingModel, PipeSupportElement } from '@core/model/building';
import type { CadDocument, Vec3 } from '@core/model/types';
import { fromMm } from '../model';
import { collectSteelBars, modelUnits, type SteelBar } from './steelMemberBars';
import { nearestOnRoute, RISER_SLOPE } from './routeSupport';
import { absolutePointMm, pipeRunOf } from './pipeSupportLayout';
import {
  bearingOf,
  findBearingMember,
  findRiserBearingMember,
  riserBearingOf,
  type BearingLimits,
} from './pipeSupportMember';

/** Default vertical reach, mm: pedestal below the pipe / hanger rod above it / riser bracket length. */
export const REACH: Readonly<Record<'below' | 'above', number>> = { below: 500, above: 3000 };
export const PLAN_TOLERANCE = 100;

/** Drops unit-conversion noise (1e-9 of a document unit). */
export const clean = (value: number): number => Math.round(value * 1e9) / 1e9;

/** The steel a support bears on, in mm. */
export interface Bearing {
  readonly memberId: string;
  /** Pedestal height (below) / rod length (hanger), mm; 0 for a riser clamp. */
  readonly gap: number;
  /** Riser clamps only: bracket length and plan direction toward the member. */
  readonly riser: { readonly standoff: number; readonly angle: number } | null;
}

/** True when the pipe segment at `point` (absolute mm) is a riser. */
export function isRiserPoint(points: ReadonlyArray<Vec3>, point: Vec3): boolean {
  const snap = nearestOnRoute(points, point);
  return snap !== null && Math.abs(snap.direction[2]) > RISER_SLOPE;
}

/**
 * Steel for a support of `type` at `point` (absolute mm on the pipe centreline): `explicit` when
 * given (its failure reason is returned), else the nearest member in reach, else null.
 */
export function resolveBearing(
  bars: ReadonlyArray<SteelBar>,
  type: PipeSupportElement['type'],
  point: Vec3,
  diameter: number,
  limits: BearingLimits,
  riser: boolean,
  explicit?: SteelBar,
): Bearing | string | null {
  if (riser) {
    const hit = explicit
      ? riserBearingOf(explicit, point, diameter, limits)
      : findRiserBearingMember(bars, point, diameter, limits);
    if (hit === null || typeof hit === 'string') return hit;
    return { memberId: hit.memberId, gap: 0, riser: { standoff: hit.standoff, angle: hit.angle } };
  }
  const hit = explicit
    ? bearingOf(explicit, type, point, diameter, limits)
    : findBearingMember(bars, type, point, diameter, limits);
  return hit === null || typeof hit === 'string'
    ? hit
    : { memberId: hit.memberId, gap: hit.gap, riser: null };
}

/** The attachment fields of a support element (document units) for `bearing` (null = unattached). */
export function attachmentFields(
  doc: Pick<CadDocument, 'units'>,
  type: PipeSupportElement['type'],
  bearing: Bearing | null,
): Pick<PipeSupportElement, 'memberId' | 'rodLength' | 'pedestalHeight'> &
  Partial<Pick<PipeSupportElement, 'standoff' | 'standoffAngle'>> {
  const gap = bearing ? clean(fromMm(doc, bearing.gap)) : 0;
  return {
    memberId: bearing?.memberId ?? null,
    rodLength: bearing && type === 'hanger' ? gap : 0,
    pedestalHeight: bearing && type !== 'hanger' ? gap : 0,
    ...(bearing?.riser
      ? {
          standoff: clean(fromMm(doc, bearing.riser.standoff)),
          standoffAngle: clean(bearing.riser.angle),
        }
      : {}),
  };
}

interface SupportChange {
  readonly id: string;
  readonly mark: string;
  /** Mark of the member before / after (null = unattached). */
  readonly from: string | null;
  readonly to: string | null;
}

export interface SupportReconciliation {
  readonly building: BuildingModel;
  /** Supports now bearing on another member than before (or on one after being unattached). */
  readonly reattached: SupportChange[];
  /** Supports that lost their member and found no steel in reach. */
  readonly detached: SupportChange[];
  /** Supports re-checked that keep their member. */
  readonly kept: string[];
}

const memberMark = (building: BuildingModel, id: string | null): string | null => {
  const element = id === null ? undefined : building.elements[id];
  return element?.category === 'member' ? element.mark : null;
};

/** Everything the reach test of `support` depends on, as a comparable string. */
function attachmentSignature(building: BuildingModel, support: PipeSupportElement): string {
  const elevation = (levelId: string): number => building.levels[levelId]?.elevation ?? 0;
  const pipe = building.elements[support.pipeId];
  const member = support.memberId === null ? undefined : building.elements[support.memberId];
  return JSON.stringify([
    support.position,
    elevation(support.levelId),
    pipe?.category === 'pipe' ? [pipe.diameter, pipe.points] : null,
    member?.category === 'member'
      ? [member.start, member.end, member.profile, member.role, elevation(member.levelId)]
      : null,
  ]);
}

/**
 * Re-runs the attachment of every support of `next` whose pipe, position or member changed relative
 * to `doc.building` (or whose id is in `alsoIds`), or whose member no longer exists: the current
 * member is kept while it is still in reach, else the nearest member in reach, else the support is
 * unattached. Reach limits are the defaults, widened to the support's current pedestal / rod / bracket.
 * @pure
 */
export function reconcilePipeSupports(
  doc: CadDocument,
  next: BuildingModel,
  alsoIds: ReadonlyArray<string> = [],
): SupportReconciliation {
  const previous = doc.building;
  const unchanged: SupportReconciliation = {
    building: next,
    reattached: [],
    detached: [],
    kept: [],
  };
  if (!previous) return unchanged;
  const candidates = next.elementOrder.flatMap((id) => {
    const support = next.elements[id];
    if (support?.category !== 'pipeSupport') return [];
    const before = previous.elements[id];
    const dangling = support.memberId !== null && memberMark(next, support.memberId) === null;
    const changed =
      before?.category === 'pipeSupport' &&
      attachmentSignature(previous, before) !== attachmentSignature(next, support);
    return dangling || changed || alsoIds.includes(id) ? [support] : [];
  });
  if (candidates.length === 0) return unchanged;
  const nextDoc: CadDocument = { ...doc, building: next };
  const units = modelUnits(nextDoc);
  const bars = collectSteelBars(nextDoc);
  const unit = fromMm(doc, 1);
  let building = next;
  const [reattached, detached, kept]: [SupportChange[], SupportChange[], string[]] = [[], [], []];
  for (const support of candidates) {
    const pipe = next.elements[support.pipeId];
    if (pipe?.category !== 'pipe') continue;
    const run = pipeRunOf(units, pipe);
    const point = absolutePointMm(units, support.levelId, support.position);
    const riser = isRiserPoint(run.points, point);
    const current =
      (riser ? (support.standoff ?? 0) : support.rodLength + support.pedestalHeight) / unit;
    const below = support.type !== 'hanger';
    const limits: BearingLimits = {
      maxReach: Math.max(REACH[below ? 'below' : 'above'], current),
      planTolerance: PLAN_TOLERANCE,
    };
    const member = bars.find((bar) => bar.id === support.memberId);
    const kind = support.type;
    const tryMember = member
      ? resolveBearing(bars, kind, point, run.diameterMm, limits, riser, member)
      : null;
    const found =
      tryMember !== null && typeof tryMember !== 'string'
        ? tryMember
        : resolveBearing(bars, kind, point, run.diameterMm, limits, riser);
    const bearing = found !== null && typeof found !== 'string' ? found : null;
    const fields = attachmentFields(doc, support.type, bearing);
    const updated: PipeSupportElement = { ...support, ...fields };
    if (fields.standoff === undefined) {
      delete updated.standoff;
      delete updated.standoffAngle;
    }
    building = { ...building, elements: { ...building.elements, [support.id]: updated } };
    const change: SupportChange = {
      id: support.id,
      mark: support.mark,
      from:
        support.memberId === null
          ? null
          : (memberMark(next, support.memberId) ??
            memberMark(previous, support.memberId) ??
            support.memberId),
      to: memberMark(building, bearing?.memberId ?? null),
    };
    if (bearing === null) {
      if (support.memberId !== null) detached.push(change);
    } else if (bearing.memberId !== support.memberId) reattached.push(change);
    else kept.push(support.mark);
  }
  return { building, reattached, detached, kept };
}

/** One sentence for a command summary (empty when no support was re-checked). */
export function reconciliationNote(result: SupportReconciliation): string {
  const { reattached, detached, kept } = result;
  if (reattached.length + detached.length + kept.length === 0) return '';
  const parts = [
    ...(kept.length > 0 ? [`${kept.length} kept (${kept.join(', ')})`] : []),
    ...reattached.map(
      (change) =>
        `${change.mark} re-attached ${change.from ?? 'unattached'} -> ${change.to ?? '?'}`,
    ),
    ...detached.map(
      (change) =>
        `${change.mark} DETACHED from ${change.from ?? '?'} (no steel in reach: now unattached, carries nothing)`,
    ),
  ];
  return ` Pipe supports re-checked: ${parts.join('; ')}.`;
}
