/**
 * @layer server
 *
 * In-memory UiBridge implementation.
 *
 * Provides the concrete `UiBridge` port (defined in `core/mcp/uiBridge.ts`) for
 * use at server startup.  This is a stub whose state lives in process memory:
 *
 *   POST /ui-bridge/push  → `pushLiveDocument(doc)` — UI pushes its current doc here.
 *   POST /ui-bridge/pull  → `popPendingPublish()`   — UI pops the pending staged doc.
 *
 * The real wiring (live EventSource, WebSocket, etc.) is a future change; the stub
 * is sufficient for the MCP agent workflow:
 *   1. UI pushes → agent calls snapshot_in_from_ui → session has UI doc.
 *   2. Agent mutates → agent calls snapshot_out_to_ui → doc staged.
 *   3. UI polls pull → gets the staged doc → applies load_document.
 *
 * Architecture: no business logic here. State is a simple nullable reference plus
 * a nullable pending-publish reference. Thread safety is not a concern (Node is
 * single-threaded event-loop; async I/O here is trivially resolved).
 */

import type { CadDocument } from '@core/model/types';
import type { UiBridge } from '@core/mcp';

// ---------------------------------------------------------------------------
// State (process-level singleton — intentional; one bridge per server process)
// ---------------------------------------------------------------------------

/** The most recently pushed UI document, or null before the first push. */
let _liveDocument: CadDocument | null = null;

/** A staged document awaiting UI pull, or null when nothing is pending. */
let _pendingPublish: CadDocument | null = null;

// ---------------------------------------------------------------------------
// Public mutation API (called by the HTTP routes in uiBridgeRouter.ts)
// ---------------------------------------------------------------------------

/**
 * Store `doc` as the current live UI document.
 * Called by POST /ui-bridge/push.
 */
export function pushLiveDocument(doc: CadDocument): void {
  _liveDocument = doc;
}

/**
 * Pop and return the pending staged publish document.
 * Returns null when nothing is pending (also clears the reference).
 * Called by POST /ui-bridge/pull.
 */
export function popPendingPublish(): CadDocument | null {
  const doc = _pendingPublish;
  _pendingPublish = null;
  return doc;
}

// ---------------------------------------------------------------------------
// UiBridge implementation
// ---------------------------------------------------------------------------

/**
 * The singleton in-memory bridge instance.
 *
 * Inject this into `buildMcpServer` at server startup so bridge tools always
 * reference the same live/pending state as the HTTP routes.
 */
export const inMemoryBridge: UiBridge = {
  getLiveDocument(): CadDocument | null {
    return _liveDocument;
  },

  async publishDocument(doc: CadDocument): Promise<{ ok: boolean; summary: string }> {
    try {
      // Deep-copy so mutations by the caller after this call don't affect the
      // staged document. JSON round-trip is the safest option here given that
      // CadDocument is always JSON-serialisable.
      _pendingPublish = JSON.parse(JSON.stringify(doc)) as CadDocument;
      return { ok: true, summary: 'Document staged for UI pull.' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'serialisation error';
      return { ok: false, summary: msg };
    }
  },
};

// ---------------------------------------------------------------------------
// Test helpers (internal — not exported in the public types surface)
// ---------------------------------------------------------------------------

/**
 * Reset bridge state.
 * @internal — for tests only.
 */
export function _resetBridge(): void {
  _liveDocument = null;
  _pendingPublish = null;
}
