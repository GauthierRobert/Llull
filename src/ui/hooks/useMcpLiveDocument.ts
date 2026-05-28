/**
 * @layer ui/hooks
 *
 * useMcpLiveDocument — subscribes to the server-side SSE document stream.
 *
 * Opens `GET http://localhost:3001/live` as an EventSource.
 *
 * Protocol (named SSE events):
 *   - `snapshot` event: full CadDocument JSON. Used on initial connect and after
 *     undo/redo. The store replaces the whole document (hydrateLiveDocument).
 *   - `patch` event: incremental DocPatch JSON. Emitted after every normal mutating
 *     command. The store applies only the changed entities (applyLivePatch), so
 *     cost is O(change) not O(document size). Unchanged entity object refs stay
 *     stable → React does not re-render unaffected meshes.
 *
 * Lifecycle:
 *   - onopen  → setLiveStatus('connected')
 *   - snapshot → JSON.parse → hydrateLiveDocument (full replace)
 *   - patch   → JSON.parse → applyLivePatch (incremental update)
 *   - onerror → setLiveStatus('disconnected') (EventSource retries automatically)
 *   - unmount → EventSource.close()
 *
 * Mount once at the App root. Uses narrow store selectors (R3).
 * EventSource is a browser API — belongs in the ui/ layer (architecture L2).
 */

import { useEffect } from 'react';
import { useStore } from '@ui/store';
import type { CadDocument } from '@core/model/types';
import type { DocPatch } from '@core/mcp/docPatch';

const LIVE_URL = 'http://localhost:3001/live';

/**
 * Open the SSE stream and keep the Zustand store hydrated.
 * No return value — side-effects managed via useEffect cleanup.
 */
export function useMcpLiveDocument(): void {
  const hydrateLiveDocument = useStore((s) => s.hydrateLiveDocument);
  const applyLivePatch = useStore((s) => s.applyLivePatch);
  const setLiveStatus = useStore((s) => s.setLiveStatus);

  useEffect(() => {
    setLiveStatus('connecting');

    const source = new EventSource(LIVE_URL);

    source.onopen = () => {
      setLiveStatus('connected');
    };

    // Named event: `snapshot` — full document replacement.
    // Used on initial connect and after undo/redo.
    source.addEventListener('snapshot', (e: Event) => {
      const me = e as MessageEvent<string>;
      try {
        const doc = JSON.parse(me.data) as CadDocument;
        hydrateLiveDocument(doc);
      } catch {
        // Malformed JSON from server — ignore, stay connected.
      }
    });

    // Named event: `patch` — incremental entity-level delta.
    // Used after every normal mutating command.
    source.addEventListener('patch', (e: Event) => {
      const me = e as MessageEvent<string>;
      try {
        const patch = JSON.parse(me.data) as DocPatch;
        applyLivePatch(patch);
      } catch {
        // Malformed JSON from server — ignore, stay connected.
      }
    });

    // Fallback: unnamed `onmessage` (server emitting without `event:` field).
    // Treats it as a full snapshot for backward compatibility.
    source.onmessage = (e: MessageEvent<string>) => {
      try {
        const doc = JSON.parse(e.data) as CadDocument;
        hydrateLiveDocument(doc);
      } catch {
        // Malformed JSON — ignore.
      }
    };

    source.onerror = () => {
      // EventSource will auto-reconnect; we just reflect the transient state.
      setLiveStatus('disconnected');
    };

    return () => {
      source.close();
    };
  }, [hydrateLiveDocument, applyLivePatch, setLiveStatus]);
}
