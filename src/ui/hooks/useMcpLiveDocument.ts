/**
 * @layer ui/hooks
 *
 * useMcpLiveDocument — subscribes to the server-side SSE document stream.
 *
 * Opens `GET <SERVER_BASE>/live` as an EventSource (SERVER_BASE from @ui/serverConfig).
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
 *   - onerror → setLiveStatus('disconnected'), close, reconnect with exponential backoff (1s..30s)
 *   - unmount → EventSource.close()
 *
 * Mount once at the App root. Uses narrow store selectors (R3).
 * EventSource is a browser API — belongs in the ui/ layer (architecture L2).
 */

import { useEffect } from 'react';
import { useStore } from '@ui/store';
import type { CadDocument } from '@core/model/types';
import type { DocPatch } from '@core/mcp/docPatch';
import { SERVER_BASE } from '@ui/serverConfig';

const LIVE_URL = `${SERVER_BASE}/live`;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

/**
 * Open the SSE stream and keep the Zustand store hydrated.
 * No return value — side-effects managed via useEffect cleanup.
 */
export function useMcpLiveDocument(): void {
  const hydrateLiveDocument = useStore((s) => s.hydrateLiveDocument);
  const applyLivePatch = useStore((s) => s.applyLivePatch);
  const setLiveStatus = useStore((s) => s.setLiveStatus);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const scheduleReconnect = (): void => {
      if (disposed || retryTimer !== null) return;
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    const connect = (): void => {
      setLiveStatus('connecting');
      const es = new EventSource(LIVE_URL);
      source = es;

      es.onopen = () => {
        attempt = 0;
        setLiveStatus('connected');
      };

      es.addEventListener('snapshot', (e: Event) => {
        try {
          hydrateLiveDocument(JSON.parse((e as MessageEvent<string>).data) as CadDocument);
        } catch {
          // Malformed JSON from server — ignore, stay connected.
        }
      });

      es.addEventListener('patch', (e: Event) => {
        try {
          applyLivePatch(JSON.parse((e as MessageEvent<string>).data) as DocPatch);
        } catch {
          // Malformed JSON from server — ignore, stay connected.
        }
      });

      // Unnamed events: treated as a full snapshot (backward compatibility).
      es.onmessage = (e: MessageEvent<string>) => {
        try {
          hydrateLiveDocument(JSON.parse(e.data) as CadDocument);
        } catch {
          // Malformed JSON — ignore.
        }
      };

      // Close the native auto-retry (fixed ~3s, noisy) and back off exponentially instead.
      es.onerror = () => {
        es.close();
        setLiveStatus('disconnected');
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      source?.close();
    };
  }, [hydrateLiveDocument, applyLivePatch, setLiveStatus]);
}
