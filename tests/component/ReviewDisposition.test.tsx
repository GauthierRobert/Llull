import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReviewPanel } from '@ui/panels/review/ReviewPanel';
import { useReviewStore } from '@ui/panels/review/reviewStore';
import { useStore } from '@ui/store';
import { hardOverlap, reviewFixture } from './reviewFixtures';
import { resetStore } from '../helpers/componentEntities';

// Pretend the review commands are registered: the panel must then dispatch them by name with the gathered params.
vi.mock('@core/commands/registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@core/commands/registry')>();
  return { ...original, getCommand: (name: string) => (name === 'set_review_disposition' ? ({} as never) : original.getCommand(name)) };
});

beforeEach(() => {
  resetStore();
  const { document } = useStore.getState();
  useReviewStore.getState().setResult(reviewFixture, { entities: document.entities, dynamics: document.dynamics });
});

describe('ReviewPanel dispositions', () => {
  it('dispatches set_review_disposition with the finding key, status and comment', () => {
    const dispatch = vi.fn();
    useStore.setState({ dispatch });
    render(<ReviewPanel />);
    const status = screen.getByLabelText('Reviewer status for FPR_PAIR_HARD');
    expect(status).toBeEnabled();
    fireEvent.change(status, { target: { value: 'accepted' } });
    expect(dispatch).toHaveBeenCalledWith(
      'set_review_disposition',
      { findingKey: hardOverlap.findingKey, status: 'accepted', comment: '', inputsHash: 'hash-assembly' },
      expect.anything(),
    );
    const comment = screen.getByLabelText('Comment for FPR_PAIR_HARD');
    fireEvent.change(comment, { target: { value: 'press fit' } });
    fireEvent.blur(comment);
    expect(dispatch).toHaveBeenLastCalledWith(
      'set_review_disposition',
      { findingKey: hardOverlap.findingKey, status: 'not_reviewed', comment: 'press fit', inputsHash: 'hash-assembly' },
      expect.anything(),
    );
  });
});
