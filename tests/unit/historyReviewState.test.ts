import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

/** Regression: review state (issues, viewpoints, walkthroughs) is written only by metaHistory commands, so replay must carry it, and
 *  clear_document must drop it with the entities it points at. */
describe('review state through replay and clear_document', () => {
  const boxed = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
  const reviewed = execute(boxed, 'create_review_issue', { title: 'gap at the flange' }).document;

  it('replay_history keeps the review issues', () => {
    expect(reviewed.review?.issueOrder).toHaveLength(1);
    const replayed = execute(reviewed, 'replay_history', {});
    expect(replayed.document.review?.issueOrder).toEqual(reviewed.review?.issueOrder);
  });

  it('a recorded clear_document replayed by a history edit keeps issues created after it', () => {
    const cleared = execute(boxed, 'clear_document', {}).document;
    const flagged = execute(cleared, 'create_review_issue', { title: 'after the clear' }).document;
    const replayed = execute(flagged, 'replay_history', {});
    expect(replayed.document.review?.issueOrder).toEqual(flagged.review?.issueOrder);
  });

  it('clear_document removes the review state', () => {
    const cleared = execute(reviewed, 'clear_document', {});
    expect(cleared.document.review).toBeUndefined();
    expect(Object.keys(cleared.document.entities)).toHaveLength(0);
  });
});
