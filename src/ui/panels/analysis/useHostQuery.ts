// Runs one read-only command where its data lives: through the server when online (FE artifacts are only there), else locally.

import { useEffect, useState } from 'react';
import { useStore } from '@ui/store';
import { postCommand } from '@ui/store/serverCommands';
import { runQuery } from '@ui/services/localQuery';
import { errorMessage } from '@lib/errorMessage';

export type HostQueryState =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly data: unknown; readonly summary: string; readonly isError: boolean };

/** Re-runs whenever `params` or `refreshKey` (e.g. the document) change; a stale answer is dropped. */
export function useHostQuery(command: string, params: Record<string, unknown> | null, refreshKey: unknown): HostQueryState {
  const online = useStore((s) => s.liveStatus === 'connected');
  const [state, setState] = useState<HostQueryState>({ status: 'loading' });
  const paramsKey = params === null ? null : JSON.stringify(params);

  useEffect(() => {
    if (paramsKey === null) return;
    let cancelled = false;
    const settle = (data: unknown, summary: string, isError: boolean): void => {
      if (!cancelled) setState({ status: 'done', data, summary, isError });
    };
    const request = JSON.parse(paramsKey) as Record<string, unknown>;
    if (online) {
      postCommand(command, request)
        .then((response) => settle(response.data, response.summary, response.isError))
        .catch((err: unknown) => settle(null, `${command} failed: ${errorMessage(err)}`, true));
    } else {
      const result = runQuery(command, request);
      settle(result.data, result.summary, result.rejected === true);
    }
    return () => {
      cancelled = true;
    };
  }, [command, online, paramsKey, refreshKey]);

  return state;
}
