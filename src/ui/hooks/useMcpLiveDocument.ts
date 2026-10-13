/**
 * Subscribes to the server SSE command log (`GET <SERVER_BASE>/live`, token via liveStreamUrl). Events (`@mcp/liveSync`,
 * seq per server `epoch`): `snapshot` (connect, undo/redo) → hydrateLiveDocument; `command` → applyLiveCommand, and on a
 * seq gap / hash mismatch a `GET /live/snapshot` resync. onerror → 'disconnected', reconnect with 1s..30s backoff.
 */

import { useEffect } from 'react';
import { useStore } from '@ui/store';
import type { LiveCommandEvent, LiveSnapshotEvent } from '@mcp/liveSync';
import { liveStreamUrl } from '@ui/serverConfig';
import { fetchLiveSnapshot } from '@ui/store/serverCommands';
import { isOwnCommandId, markLiveOrigin } from '@ui/store/liveOrigin';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

export function useMcpLiveDocument(): void {
  const hydrateLiveDocument = useStore((s) => s.hydrateLiveDocument);
  const applyLiveCommand = useStore((s) => s.applyLiveCommand);
  const setLiveStatus = useStore((s) => s.setLiveStatus);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;
    let resyncInFlight = false;
    let resyncQueued = false;

    // One snapshot fetch at a time; failures arriving meanwhile coalesce into one follow-up.
    const resync = (): void => {
      if (resyncInFlight) {
        resyncQueued = true;
        return;
      }
      resyncInFlight = true;
      void fetchLiveSnapshot()
        .then(hydrateLiveDocument)
        .catch(() => undefined) // next event or reconnect resyncs
        .finally(() => {
          resyncInFlight = false;
          if (resyncQueued && !disposed) {
            resyncQueued = false;
            resync();
          }
        });
    };

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
      const es = new EventSource(liveStreamUrl());
      source = es;

      es.onopen = () => {
        attempt = 0;
        setLiveStatus('connected');
      };

      es.addEventListener('snapshot', (e: Event) => {
        try {
          const snapshot = JSON.parse((e as MessageEvent<string>).data) as LiveSnapshotEvent;
          markLiveOrigin({ kind: 'snapshot' });
          hydrateLiveDocument(snapshot);
        } catch {
          // Malformed JSON from server — ignore, stay connected.
        } finally {
          markLiveOrigin(null);
        }
      });

      es.addEventListener('command', (e: Event) => {
        let event: LiveCommandEvent;
        try {
          event = JSON.parse((e as MessageEvent<string>).data) as LiveCommandEvent;
        } catch {
          return; // Malformed JSON from server — ignore, stay connected.
        }
        markLiveOrigin(
          isOwnCommandId(event.commandId)
            ? null
            : {
                kind: 'remote',
                name: event.name,
                source: event.source ?? 'rest',
                ...(event.userName !== undefined ? { userName: event.userName } : {}),
              },
        );
        const applied = applyLiveCommand(event);
        markLiveOrigin(null);
        if (applied) return;
        resync();
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
