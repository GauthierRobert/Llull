/**
 * @layer ui/hooks
 *
 * useMcpLiveDocument — subscribes to the server-side SSE document stream.
 *
 * Opens `GET http://localhost:3001/live` as an EventSource.
 * Protocol:
 *   - Server sends one `data: <json>\n\n` immediately with the full CadDocument.
 *   - Server sends a new snapshot after every MCP mutation.
 *   - EventSource auto-reconnects on disconnect (browser native behaviour).
 *
 * Lifecycle:
 *   - onopen  → setLiveStatus('connected')
 *   - onmessage → JSON.parse(e.data) as CadDocument → hydrateLiveDocument
 *   - onerror → setLiveStatus('disconnected') (EventSource retries automatically)
 *   - unmount → EventSource.close()
 *
 * Mount once at the App root. Uses narrow store selectors (R3).
 * EventSource is a browser API — belongs in the ui/ layer (architecture L2).
 */

import { useEffect } from 'react';
import { useStore } from '@ui/store';
import type { CadDocument } from '@core/model/types';

const LIVE_URL = 'http://localhost:3001/live';

/**
 * Open the SSE stream and keep the Zustand store hydrated.
 * No return value — side-effects managed via useEffect cleanup.
 */
export function useMcpLiveDocument(): void {
  const hydrateLiveDocument = useStore((s) => s.hydrateLiveDocument);
  const setLiveStatus = useStore((s) => s.setLiveStatus);

  useEffect(() => {
    setLiveStatus('connecting');

    const source = new EventSource(LIVE_URL);

    source.onopen = () => {
      setLiveStatus('connected');
    };

    source.onmessage = (e: MessageEvent<string>) => {
      try {
        const doc = JSON.parse(e.data) as CadDocument;
        hydrateLiveDocument(doc);
      } catch {
        // Malformed JSON from server — ignore, stay connected.
      }
    };

    source.onerror = () => {
      // EventSource will auto-reconnect; we just reflect the transient state.
      setLiveStatus('disconnected');
    };

    return () => {
      source.close();
    };
  }, [hydrateLiveDocument, setLiveStatus]);
}
