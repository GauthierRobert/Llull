// Binds the footprint preview of a wrap command to its param form: the typed params (when they parse) go, debounced, to the read-only preview query (through the backend
// when online, locally otherwise) and its answer lands in the footprint store; invalid params, another command or leaving the form clear it. Nothing here mutates the document.

import { useEffect, useMemo, useState } from 'react';
import { useFootprintPreviewStore } from '@ui/store/footprintPreviewStore';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';
import { footprintPreviewCommand, parseFootprint } from './footprintPreview';

export const FOOTPRINT_DEBOUNCE_MS = 250;

/** `params` = the parsed params of the form, or null while they are incomplete or invalid. */
export function useFootprintPreview(commandName: string, params: Record<string, unknown> | null, enabled: boolean): void {
  const preview = footprintPreviewCommand(commandName);
  const draft = enabled && preview !== null ? params : null;
  const [lastSettled, setSettled] = useState(draft);
  const draftKey = draft === null ? null : JSON.stringify(draft);
  const settled = draftKey === null ? null : lastSettled;
  useEffect(() => {
    if (draftKey === null) return undefined;
    const timer = setTimeout(() => setSettled(JSON.parse(draftKey) as Record<string, unknown>), FOOTPRINT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftKey]);
  const query = useHostQuery(preview ?? 'preview_emboss_on_face', settled, null);
  const view = useMemo(
    () => (preview !== null && query.status === 'done' && !query.isError ? parseFootprint(preview, query.data) : null),
    [preview, query],
  );
  const set = useFootprintPreviewStore((s) => s.set);
  const clear = useFootprintPreviewStore((s) => s.clear);
  useEffect(() => {
    if (preview === null || draftKey === null || settled === null) clear();
    else if (query.status === 'loading') set('pending', '', null);
    else if (view === null) set('refused', query.summary, null);
    else set('ready', query.summary, view);
  }, [preview, draftKey, settled, query, view, set, clear]);
  useEffect(() => clear, [clear]);
}
