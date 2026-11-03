// Pure helpers of the model-review panel (issues, comments, section boxes); read the document, build command params, never write.

import { entityBoundsInDoc } from '@core/geometry/bounds';
import { ISSUE_TRANSITIONS, type IssueStatus, type ReviewComment, type ReviewIssue, type ReviewModel } from '@core/model/review';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { StatusTone } from '@ui/panels/PanelParts';

export const STATUS_LABEL: Readonly<Record<IssueStatus, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const STATUS_TONE: Readonly<Record<IssueStatus, StatusTone>> = { open: 'warn', in_progress: 'info', resolved: 'ok', closed: 'ok' };

/** Statuses an issue in `from` may move to (the model's transition table). */
export const nextStatuses = (from: IssueStatus): readonly IssueStatus[] => ISSUE_TRANSITIONS[from];

/** Closing and re-opening a closed issue are human acts: they need a signature (09 VIS §5.5). */
export const isHumanMove = (from: IssueStatus, to: IssueStatus): boolean => to === 'closed' || from === 'closed';

/** The issues in creation order. */
export function orderedIssues(review: ReviewModel | undefined): ReviewIssue[] {
  if (review === undefined) return [];
  return review.issueOrder.flatMap((id) => (review.issues[id] === undefined ? [] : [review.issues[id]]));
}

/** The comments of an issue, oldest first (ids are `cm-<n>` from a counter). */
export function commentsOf(review: ReviewModel | undefined, issueId: string): ReviewComment[] {
  if (review === undefined) return [];
  return Object.values(review.comments)
    .filter((comment) => comment.issueId === issueId)
    .sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
}

/** The last history entry, when a human made it: the issue's signed state. */
export function signedBy(issue: ReviewIssue): string | null {
  const last = issue.history[issue.history.length - 1];
  return last?.by === 'human' ? (last.signer ?? 'a trusted signer') : null;
}

/** `set_section_box` params for a new box around `ids` (else the whole model), grown by `margin` on every side; null for an empty model. */
export function sectionBoxAround(
  doc: CadDocument,
  ids: readonly string[],
  margin: number,
): { name: string; min: Vec3; max: Vec3; activate: true } | null {
  const targets = (ids.length > 0 ? ids : doc.order).flatMap((id) => (doc.entities[id] === undefined ? [] : [doc.entities[id]]));
  if (targets.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const entity of targets) {
    const bounds = entityBoundsInDoc(doc, entity);
    for (const axis of [0, 1, 2] as const) {
      min[axis] = Math.min(min[axis], bounds.min[axis]);
      max[axis] = Math.max(max[axis], bounds.max[axis]);
    }
  }
  if (![...min, ...max].every(Number.isFinite)) return null;
  return {
    name: ids.length > 0 ? 'Section around selection' : 'Section around model',
    min: [min[0] - margin, min[1] - margin, min[2] - margin],
    max: [max[0] + margin, max[1] + margin, max[2] + margin],
    activate: true,
  };
}

/** A base64 string as bytes (BCF export download). */
export function bytesOfBase64(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/** A file's bytes as base64 (BCF import), in chunks so a large archive does not overflow the argument limit. */
export function base64OfBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
