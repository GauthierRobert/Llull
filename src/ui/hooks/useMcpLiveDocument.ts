/**
 * @layer ui/hooks
 *
 * useMcpLiveDocument — subscribes to the server-side SSE command log (MG5.1).
 *
 * Opens `GET <SERVER_BASE>/live` as an EventSource (SERVER_BASE from @ui/serverConfig).
 *
 * Protocol (named SSE events, types in `@core/mcp/liveSync`):
 *   - `snapshot` `{ seq, stateHash, document }`: on connect and after undo/redo → hydrateLiveDocument.
 *   - `command` `{ seq, name, params, stateHash }`: after every mutating command. The store re-runs
 *     it through `execute` (applyLiveCommand); on a seq gap or hash mismatch this hook fetches
 *     `GET /live/snapshot` and hydrates from it.
 *
 * Lifecycle: onopen → 'connected'; onerror → 'disconnected', close, reconnect with exponential
 * backoff (1s..30s); unmount → close. EventSource is a browser API — ui/ layer only (L2).
 */

import { useEffect } from 'react';
import { useStore } from '@ui/store';
import type { LiveCommandEvent, LiveSnapshotEvent } from '@mcp/liveSync';
import { SERVER_BASE } from '@ui/serverConfig';
import { fetchLiveSnapshot } from '@ui/store/serverCommands';

const LIVE_URL = `${SERVER_BASE}/live`;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

/**
 * Open the SSE stream and keep the Zustand store hydrated.
 * No return value — side-effects managed via useEffect cleanup.
 */
export function useMcpLiveDocument(): void {
  const hydrateLiveDocument = useStore((s) => s.hydrateLiveDocument);
  const applyLiveCommand = useStore((s) => s.applyLiveCommand);
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
          hydrateLiveDocument(JSON.parse((e as MessageEvent<string>).data) as LiveSnapshotEvent);
        } catch {
          // Malformed JSON from server — ignore, stay connected.
        }
      });

      es.addEventListener('command', (e: Event) => {
        let event: LiveCommandEvent;
        try {
          event = JSON.parse((e as MessageEvent<string>).data) as LiveCommandEvent;
        } catch {
          return; // Malformed JSON from server — ignore, stay connected.
        }
        if (applyLiveCommand(event)) return;
        void fetchLiveSnapshot()
          .then(hydrateLiveDocument)
          .catch(() => undefined); // next event or reconnect resyncs
      });

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
  }, [hydrateLiveDocument, applyLiveCommand, setLiveStatus]);
}
