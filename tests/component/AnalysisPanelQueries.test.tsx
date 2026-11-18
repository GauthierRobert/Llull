import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { useStore } from '@ui/store';
import { AnalysisPanel } from '@ui/panels/analysis/AnalysisPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

/** A backend that answers every POST /command by running it on the store's document, and counts the calls per command. */
function countingBackend(): { readonly calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name: string; params?: Record<string, unknown> };
      calls.push(body.name);
      const result = execute(useStore.getState().document, body.name, body.params ?? {});
      const answer = {
        summary: result.summary,
        affected: result.affected,
        isError: result.rejected === true,
        changed: false,
        data: result.data,
      };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
    }),
  );
  return { calls };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('AnalysisPanel host queries', () => {
  beforeEach(() => {
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not ask the backend again when only the selection changes, and does when the document changes', async () => {
    const box = localDispatch('add_box', { size: [10, 10, 10] }).affected[0]!;
    localDispatch('create_analysis', { name: 'Bracket', analysisType: 'static' });
    const backend = countingBackend();
    useStore.setState({ liveStatus: 'connected' });
    render(<AnalysisPanel />);
    await settle();
    const afterMount = backend.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    act(() => {
      const state = useStore.getState();
      useStore.setState({ document: { ...state.document, selection: [box] } });
    });
    await settle();
    expect(backend.calls.length).toBe(afterMount);

    act(() => {
      const state = useStore.getState();
      useStore.setState({ document: execute(state.document, 'add_box', { size: [1, 1, 1] }).document });
    });
    await settle();
    expect(backend.calls.length).toBeGreaterThan(afterMount);
  });
});
