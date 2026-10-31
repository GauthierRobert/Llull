// Binds the footprint / knurl preview of a command to its param form: the typed params (when they parse) go, debounced, to the command's read-only preview query (`annotations.previewQuery`; through the backend
// when online, locally otherwise) and its answer lands in the footprint store; invalid params, a command without a preview query or leaving the form clear it. The query is asked again when the entities of the
// document change. Nothing here mutates the document.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@ui/store';
import { useFootprintPreviewStore } from '@ui/store/footprintPreviewStore';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';
import { parseFootprint } from './footprintPreview';

export const FOOTPRINT_DEBOUNCE_MS = 250;

/** `previewQuery` = the command's `annotations.previewQuery`; `params` = the parsed params of the form, or null while they are incomplete or invalid. */
export function useFootprintPreview(previewQuery: string | undefined, params: Record<string, unknown> | null, enabled: boolean): void {
  const draft = enabled && previewQuery !== undefined ? params : null;
  const [lastSettled, setSettled] = useState(draft);
  const draftKey = draft === null ? null : JSON.stringify(draft);
  const settled = draftKey === null ? null : lastSettled;
  useEffect(() => {
    if (draftKey === null) return undefined;
    const timer = setTimeout(() => setSettled(JSON.parse(draftKey) as Record<string, unknown>), FOOTPRINT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftKey]);
  // the answer depends on the solids and the sketches: any entity edit asks again (a selection change does not)
  const entities = useStore((s) => s.document.entities);
  const query = useHostQuery(previewQuery ?? '', settled, entities);
  const view = useMemo(() => (query.status === 'done' && !query.isError ? parseFootprint(query.data) : null), [query]);
  const set = useFootprintPreviewStore((s) => s.set);
  const clear = useFootprintPreviewStore((s) => s.clear);
  useEffect(() => {
    if (previewQuery === undefined || draftKey === null || settled === null) clear();
    else if (query.status === 'loading') set('pending', '', null);
    else if (view === null) set('refused', query.summary, null);
    else set('ready', query.summary, view);
  }, [previewQuery, draftKey, settled, query, view, set, clear]);
  useEffect(() => clear, [clear]);
}
