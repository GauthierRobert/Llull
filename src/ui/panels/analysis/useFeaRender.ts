// Fetches render_fea_results: through the server when online (artifacts live there), else locally (which refuses with its summary).

import { useEffect, useState } from 'react';
import { useStore } from '@ui/store';
import { postCommand } from '@ui/store/serverCommands';
import { runQuery } from '@ui/services/localQuery';
import { errorMessage } from '@lib/errorMessage';
import { parseRender, type RenderView } from './analysisData';

export type FeaRenderState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: RenderView; readonly summary: string }
  | { readonly status: 'refused'; readonly summary: string };

export function useFeaRender(params: Record<string, unknown>, refreshKey: unknown): FeaRenderState {
  const online = useStore((s) => s.liveStatus === 'connected');
  const [state, setState] = useState<FeaRenderState>({ status: 'loading' });
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    let cancelled = false;
    const settle = (data: unknown, summary: string, isError: boolean): void => {
      if (cancelled) return;
      const view = isError ? null : parseRender(data);
      setState(view === null ? { status: 'refused', summary } : { status: 'ready', view, summary });
    };
    const request = JSON.parse(paramsKey) as Record<string, unknown>;
    if (online) {
      postCommand('render_fea_results', request)
        .then((response) => settle(response.data, response.summary, response.isError))
        .catch((err: unknown) => settle(null, `render_fea_results failed: ${errorMessage(err)}`, true));
    } else {
      const result = runQuery('render_fea_results', request);
      settle(result.data, result.summary, false);
    }
    return () => {
      cancelled = true;
    };
  }, [online, paramsKey, refreshKey]);

  return state;
}
