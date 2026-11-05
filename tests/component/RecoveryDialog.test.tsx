import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { useRecoveryStore } from '@ui/store/recoveryStore';
import { RecoveryDialog } from '@ui/components/RecoveryDialog';
import { HostStatusBanner } from '@ui/components/HostStatusBanner';
import type { RecoverySlotInfo } from '@ui/store/serverCommands';
import { answerDispatch } from '../helpers/storeTestHelpers';

const slot = (
  id: string,
  label: string,
  path: string | null,
  active = false,
  kind: RecoverySlotInfo['kind'] = 'document',
): RecoverySlotInfo => ({ id, path, kind, label, changedAt: '2026-11-05T10:00:00.000Z', changeCount: 7, active });

interface Backend {
  readonly posts: { url: string; body: unknown }[];
}

function stubBackend(slots: RecoverySlotInfo[]): Backend {
  const posts: Backend['posts'] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      const route = new URL(url).pathname;
      if (init?.method === 'POST') {
        posts.push({ url: route, body: JSON.parse(init.body ?? '{}') });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (route === '/recovery') return Promise.resolve({ ok: true, json: () => Promise.resolve({ slots }) });
      const id = decodeURIComponent(route.split('/').pop() ?? '');
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ meta: slots.find((s) => s.id === id), json: `{"slot":"${id}"}` }) });
    }),
  );
  return { posts };
}

const connect = (): void => void act(() => useStore.setState({ liveStatus: 'connected', liveSeq: 0 }));

afterEach(() => {
  delete (window as unknown as { llull?: unknown }).llull;
  vi.unstubAllGlobals();
  useStore.setState(useStore.getInitialState(), true); // this suite runs in its own module graph: leave no connection state behind
  useRecoveryStore.setState(useRecoveryStore.getInitialState(), true);
});

describe('RecoveryDialog', () => {
  it('lists every recovery slot of the previous session (not the open document), restores one and discards another', async () => {
    const backend = stubBackend([
      slot('doc-a', 'A.llull', 'C:/w/A.llull'),
      slot('doc-b', 'B.llull', 'C:/w/B.llull'),
      slot('untitled-x', 'Untitled document', null, true),
    ]);
    answerDispatch({ summary: 'loaded', changed: true });
    render(<RecoveryDialog />);
    connect();
    expect(await screen.findByText('A.llull')).toBeTruthy();
    expect(screen.getByText('B.llull')).toBeTruthy();
    expect(screen.queryByText('Untitled document')).toBeNull(); // the open document's own slot
    expect(screen.getAllByText(/7 changes/)).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0] as HTMLElement);
    await waitFor(() => expect(backend.posts.map((p) => p.url)).toContain('/recovery/adopt'));
    expect(backend.posts.map((p) => p.url).slice(0, 2)).toEqual(['/recovery/hold', '/recovery/adopt']); // the load stays out of the open document's slot
    const dispatch = useStore.getState().dispatch as unknown as ReturnType<typeof vi.fn>;
    expect(dispatch).toHaveBeenCalledWith('load_document', { json: '{"slot":"doc-a"}' }, expect.anything());
    expect(backend.posts.find((p) => p.url === '/recovery/adopt')?.body).toEqual({ id: 'doc-a' });
    expect(useSessionStore.getState().dirty).toBe(true);

    await waitFor(() => expect(screen.queryByText('A.llull')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(backend.posts.find((p) => p.url === '/recovery/discard')?.body).toEqual({ id: 'doc-b' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows nothing when there is nothing to recover, and Decide later keeps the slots', async () => {
    stubBackend([]);
    const { container } = render(<RecoveryDialog />);
    connect();
    await act(async () => {
      await Promise.resolve();
    });
    expect(container).toBeEmptyDOMElement();
    stubBackend([slot('doc-a', 'A.llull', 'C:/w/A.llull')]);
    await act(async () => {
      await useRecoveryStore.getState().refresh(true);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Decide later' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useRecoveryStore.getState().slots).toHaveLength(1);
  });

  it('kept offline edits are announced next to the backend state and Review opens the dialog', async () => {
    stubBackend([slot('offline-1', 'Offline edits of A.llull', 'C:/w/A.llull', false, 'offline')]);
    render(
      <>
        <HostStatusBanner />
        <RecoveryDialog />
      </>,
    );
    await act(async () => {
      useRecoveryStore.getState().setOfflineEditsKept(true);
      await useRecoveryStore.getState().refresh(false);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Offline edits of A.llull')).toBeTruthy();
  });
});

describe('RecoveryDialog restore through the desktop host (review 1)', () => {
  const host = (outcome: { ok: boolean; message: string; cancelled: boolean }): ReturnType<typeof vi.fn> => {
    const restoreRecovery = vi.fn(() => Promise.resolve(outcome));
    (window as unknown as { llull: unknown }).llull = { exportThreeMf: () => Promise.resolve({}), restoreRecovery };
    return restoreRecovery;
  };

  it('restores through the desktop session: no renderer load_document, no adopt call, the slot leaves the list', async () => {
    const backend = stubBackend([slot('doc-a', 'A.llull', 'C:/w/A.llull')]);
    answerDispatch({ summary: 'loaded', changed: true });
    const restoreRecovery = host({ ok: true, message: 'Restored', cancelled: false });
    render(<RecoveryDialog />);
    connect();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restoreRecovery).toHaveBeenCalledWith('doc-a'));
    await waitFor(() => expect(screen.queryByText('A.llull')).toBeNull());
    expect(useSessionStore.getState().dirty).toBe(true);
    expect(useStore.getState().dispatch).not.toHaveBeenCalled();
    expect(backend.posts.map((p) => p.url)).not.toContain('/recovery/adopt');
  });

  it('a refused restore keeps the slot and says why; a cancelled one is silent', async () => {
    stubBackend([slot('doc-a', 'A.llull', 'C:/w/A.llull')]);
    const restoreRecovery = host({ ok: false, message: 'the recovery copy cannot be read', cancelled: false });
    render(<RecoveryDialog />);
    connect();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(useStore.getState().lastSummary).toContain('cannot be read'));
    expect(screen.getByText('A.llull')).toBeTruthy();
    useStore.getState().setStatusMessage('');
    restoreRecovery.mockResolvedValueOnce({ ok: false, message: 'Restore cancelled', cancelled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restoreRecovery).toHaveBeenCalledTimes(2));
    expect(useStore.getState().lastSummary ?? '').toBe('');
    expect(screen.getByText('A.llull')).toBeTruthy();
  });

  it('without the desktop host a refused load gives the hold back (release) and keeps the slot', async () => {
    const backend = stubBackend([slot('doc-a', 'A.llull', 'C:/w/A.llull')]);
    answerDispatch({ summary: 'bad', changed: false });
    render(<RecoveryDialog />);
    connect();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(backend.posts.map((p) => p.url)).toContain('/recovery/release'));
    expect(backend.posts.map((p) => p.url)).not.toContain('/recovery/adopt');
    expect(screen.getByText('A.llull')).toBeTruthy();
  });
});
