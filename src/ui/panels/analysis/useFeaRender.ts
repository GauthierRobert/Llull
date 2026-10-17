// Fetches render_fea_results: through the server when online (artifacts live there), else locally (which refuses with its summary).

import { parseRender, type RenderView } from './analysisData';
import { useHostQuery } from './useHostQuery';

export type FeaRenderState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: RenderView; readonly summary: string }
  | { readonly status: 'refused'; readonly summary: string };

export function useFeaRender(params: Record<string, unknown>, refreshKey: unknown): FeaRenderState {
  const query = useHostQuery('render_fea_results', params, refreshKey);
  if (query.status === 'loading') return query;
  const view = query.isError ? null : parseRender(query.data);
  return view === null ? { status: 'refused', summary: query.summary } : { status: 'ready', view, summary: query.summary };
}
