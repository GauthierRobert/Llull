/** The revision lifecycle as data (validation/lifecycle_transitions.csv): which state changes exist and why the others are refused. */

import type { LifecycleState } from '@core/model/plm';

export const LIFECYCLE_STATES: readonly LifecycleState[] = ['in_work', 'in_review', 'released', 'superseded', 'obsolete', 'cancelled'];

/** Every allowed `from -> to` (a revision's first state, `null -> in_work`, is set by set_item_identity / revise_item). */
const ALLOWED: ReadonlySet<string> = new Set([
  'in_work>in_review',
  'in_review>in_work',
  'in_review>released',
  'in_work>cancelled',
  'released>superseded',
  'released>obsolete',
  'superseded>obsolete',
]);

export const isLegalTransition = (from: LifecycleState | null, to: LifecycleState): boolean =>
  from === null ? to === 'in_work' : ALLOWED.has(`${from}>${to}`);

/** The refusal text of a transition the table does not allow (names the command that does the job). */
export function transitionRefusal(from: LifecycleState, to: LifecycleState): string {
  if (from === 'obsolete' || from === 'cancelled') return `${from} is a terminal state`;
  if (from === 'in_work' && to === 'released') return 'submit_for_review first';
  if (from === 'in_review' && to === 'cancelled') return 'reject_review first';
  if (from === 'in_review' && to === 'obsolete') return 'reject_review first, or release it before making it obsolete';
  if (from === 'released' && to === 'in_review') return 'a released revision cannot go back; revise_item under an ECO';
  return `${from} cannot change to ${to}`;
}
