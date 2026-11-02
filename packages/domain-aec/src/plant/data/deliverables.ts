/**
 * Deliverable status machine (plant 08 DAT §5.14, TR-DAT-28): the legal transitions of a revision and the supersession of older revisions. Pure data
 * logic; the command (`commands/setDeliverableStatus.ts`) adds the content hash, the check and the human gate.
 */

import { DELIVERABLE_STATUSES, type Deliverable, type DeliverableRevision, type DeliverableStatus, type DeliverableStep } from './model';

/** Issue order of the live statuses; `superseded` is outside it (only set by a newer revision). */
const ISSUE_ORDER = DELIVERABLE_STATUSES.filter((status): status is Exclude<DeliverableStatus, 'superseded'> => status !== 'superseded');

/** The status a revision is in now. */
export const currentStatus = (revision: DeliverableRevision): DeliverableStatus => revision.steps.at(-1)?.status ?? 'in_work';

/** Statuses a revision may move to from `from` (`null` = the revision does not exist yet): one step forward, a new revision may start at in_work or issued_for_review. */
export function allowedTargets(from: DeliverableStatus | null): readonly DeliverableStatus[] {
  if (from === null) return ['in_work', 'issued_for_review'];
  if (from === 'superseded') return [];
  const next = ISSUE_ORDER[ISSUE_ORDER.indexOf(from) + 1];
  return next === undefined ? [] : [next];
}

const isIssued = (status: DeliverableStatus): boolean => status !== 'in_work' && status !== 'superseded';
const issueRank = (status: DeliverableStatus): number => ISSUE_ORDER.indexOf(status as Exclude<DeliverableStatus, 'superseded'>);

/**
 * `deliverable` with `label` moved to `step` (and the labels it superseded); when `step` is an issued status the older revisions that are issued at a status of the same or a lower
 * rank get a `superseded` step (an agent issuing for review never retires a signed approval or an as-built).
 */
export function withStep(
  deliverable: Deliverable | undefined,
  id: string,
  label: string,
  hierarchyId: string | undefined,
  step: DeliverableStep,
): { readonly deliverable: Deliverable; readonly superseded: readonly string[] } {
  const revisions = deliverable?.revisions ?? [];
  const index = revisions.findIndex((revision) => revision.label === label);
  const known = revisions[index];
  const moved: DeliverableRevision = known
    ? { ...known, steps: [...known.steps, step] }
    : { label, ...(hierarchyId === undefined ? {} : { hierarchyId }), steps: [step] };
  const all = known ? revisions.map((revision, at) => (at === index ? moved : revision)) : [...revisions, moved];
  const position = known ? index : all.length - 1;
  const retire = (revision: DeliverableRevision): DeliverableRevision => {
    const status = currentStatus(revision);
    if (!isIssued(step.status) || !isIssued(status) || issueRank(status) > issueRank(step.status)) return revision;
    const last = revision.steps.at(-1);
    return { ...revision, steps: [...revision.steps, { status: 'superseded', contentSha256: last?.contentSha256 ?? step.contentSha256 }] };
  };
  const retired = all.map((revision, at) => (at < position ? retire(revision) : revision));
  return {
    deliverable: { id, revisions: retired },
    superseded: retired.filter((revision, at) => revision !== all[at]).map((revision) => revision.label),
  };
}
