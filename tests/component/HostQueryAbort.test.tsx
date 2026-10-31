// useHostQuery online (03 WRP previews): a request is aborted when its params change or the component goes away, and an answer that arrives out of order never replaces the answer of the newest params.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';

interface Pending {
  readonly params: unknown;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (summary: string) => void;
}
const pending: Pending[] = [];

vi.mock('@ui/store/serverCommands', () => ({
  postCommand: (_name: string, params: unknown, _commandId?: string, signal?: AbortSignal) =>
    new Promise((resolve) => {
      pending.push({ params, signal, resolve: (summary) => resolve({ data: { summary }, summary, isError: false }) });
    }),
}));

function Probe({ value }: { value: number }): React.ReactElement {
  const answer = useHostQuery('some_query', { value }, null);
  return <p data-testid="answer">{answer.status === 'done' ? answer.summary : 'loading'}</p>;
}

describe('useHostQuery requests', () => {
  beforeEach(() => {
    pending.length = 0;
    useStore.setState({ liveStatus: 'connected' });
  });
  afterEach(cleanup);

  it('new params abort the previous request, a late answer of the old params is dropped, and unmounting aborts the last request', async () => {
    const { rerender, unmount } = render(<Probe value={1} />);
    expect(pending).toHaveLength(1);
    rerender(<Probe value={2} />);
    expect(pending).toHaveLength(2);
    expect(pending[0]?.signal?.aborted).toBe(true);
    expect(pending[1]?.signal?.aborted).toBe(false);
    // out of order: the newest answers first, the aborted one answers afterwards
    await act(async () => pending[1]?.resolve('answer for 2'));
    expect(screen.getByTestId('answer').textContent).toBe('answer for 2');
    await act(async () => pending[0]?.resolve('answer for 1'));
    expect(screen.getByTestId('answer').textContent).toBe('answer for 2');
    unmount();
    expect(pending[1]?.signal?.aborted).toBe(true);
  });
});
