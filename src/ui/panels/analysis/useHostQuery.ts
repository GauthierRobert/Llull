// Runs one read-only command where its data lives: through the server when online (FE artifacts are only there), else locally.

import { useEffect, useState } from 'react';
import { useStore } from '@ui/store';
import { postCommand } from '@ui/store/serverCommands';
import { runQuery } from '@ui/services/localQuery';
import { errorMessage } from '@lib/errorMessage';

/** One-shot answer of a read-only command: through the server when online, else on the local document. */
export async function runHostQuery(
  command: string,
  params: Record<string, unknown>,
): Promise<{ data: unknown; summary: string; isError: boolean }> {
  if (useStore.getState().liveStatus === 'connected') {
    try {
      const response = await postCommand(command, params);
      return { data: response.data, summary: response.summary, isError: response.isError };
    } catch (err) {
      return { data: null, summary: `${command} failed: ${errorMessage(err)}`, isError: true };
    }
  }
  const result = runQuery(command, params);
  return { data: result.data, summary: result.summary, isError: result.rejected === true };
}

export type HostQueryState =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly data: unknown; readonly summary: string; readonly isError: boolean };

/**
 * Re-runs whenever `params` or `refreshKey` (e.g. the document) change; a stale answer is dropped. New `params` read as loading until
 * their own answer arrives (never the previous params' answer); a `refreshKey` change keeps the last answer on screen meanwhile.
 */
export function useHostQuery(command: string, params: Record<string, unknown> | null, refreshKey: unknown): HostQueryState {
  const online = useStore((s) => s.liveStatus === 'connected');
  const paramsKey = params === null ? null : JSON.stringify(params);
  const [answer, setAnswer] = useState<{ key: string | null; state: HostQueryState }>({ key: null, state: { status: 'loading' } });

  useEffect(() => {
    if (paramsKey === null) return;
    let cancelled = false;
    const controller = new AbortController();
    const settle = (data: unknown, summary: string, isError: boolean): void => {
      if (!cancelled) setAnswer({ key: paramsKey, state: { status: 'done', data, summary, isError } });
    };
    const request = JSON.parse(paramsKey) as Record<string, unknown>;
    if (online) {
      postCommand(command, request, undefined, controller.signal)
        .then((response) => settle(response.data, response.summary, response.isError))
        .catch((err: unknown) => settle(null, `${command} failed: ${errorMessage(err)}`, true));
    } else {
      const result = runQuery(command, request);
      settle(result.data, result.summary, result.rejected === true);
    }
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [command, online, paramsKey, refreshKey]);

  return answer.key === paramsKey ? answer.state : LOADING;
}

const LOADING: HostQueryState = { status: 'loading' };
