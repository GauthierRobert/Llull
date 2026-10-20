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
  it('accepting a finding is a human act: it opens the signing dialog and dispatches only with the signed confirmation', async () => {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      Promise.resolve(
        String(url).endsWith('/signing/keys')
          ? new Response(JSON.stringify({ keys: [{ keyId: 'k-1', userId: 'u-1', name: 'J. Example', trusted: true }] }), { status: 200 })
          : new Response(
              JSON.stringify({
                signature: {
                  alg: 'Ed25519',
                  keyId: 'k-1',
                  publicKey: 'a'.repeat(64),
                  signature: 'b'.repeat(128),
                  seen: JSON.parse(String(init?.body)).kind,
                },
              }),
              { status: 200 },
            ),
      ),
    );
    const dispatch = vi.fn();
    useStore.setState({ dispatch });
    render(<ReviewPanel />);
    fireEvent.change(screen.getByLabelText('Reviewer status for FPR_PAIR_HARD'), { target: { value: 'accepted' } });
    expect(dispatch).not.toHaveBeenCalled();
    await screen.findByText(/J. Example/);
    fireEvent.change(screen.getByTestId('sign-passphrase'), { target: { value: 'a long passphrase' } });
    fireEvent.click(screen.getByTestId('sign-confirm'));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith('set_review_disposition', {
      findingKey: hardOverlap.findingKey,
      status: 'accepted',
      comment: '',
      inputsHash: 'hash-assembly',
      confirmation: expect.objectContaining({ alg: 'Ed25519', keyId: 'k-1' }),
    });
    vi.unstubAllGlobals();
  });

  it('dispatches set_review_disposition with the finding key, status and comment', () => {
    const dispatch = vi.fn();
    useStore.setState({ dispatch });
    render(<ReviewPanel />);
    const status = screen.getByLabelText('Reviewer status for FPR_PAIR_HARD');
    expect(status).toBeEnabled();
    fireEvent.change(status, { target: { value: 'relevant' } });
    expect(dispatch).toHaveBeenCalledWith('set_review_disposition', {
      findingKey: hardOverlap.findingKey,
      status: 'relevant',
      comment: '',
      inputsHash: 'hash-assembly',
    });
    const comment = screen.getByLabelText('Comment for FPR_PAIR_HARD');
    fireEvent.change(comment, { target: { value: 'press fit' } });
    fireEvent.blur(comment);
    expect(dispatch).toHaveBeenLastCalledWith('set_review_disposition', {
      findingKey: hardOverlap.findingKey,
      status: 'not_reviewed',
      comment: 'press fit',
      inputsHash: 'hash-assembly',
    });
  });
});
