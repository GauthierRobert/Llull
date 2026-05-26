/**
 * @layer server
 *
 * Shared live document — single source of truth for all MCP sessions.
 *
 * All MCP sessions read and write the SAME `CadDocument` held here.
 * Mutations (via `setLiveDoc`) are immediately broadcast to all SSE subscribers
 * so the browser UI sees every MCP tool call in real time.
 *
 * Architecture notes (L6):
 * - This module is TRANSPORT / STATE GLUE only. No command or geometry logic.
 * - `setLiveDoc` stores the document produced by `execute` and fires the SSE fan-out.
 *   It never creates or validates entities.
 * - Sync is now implemented: single shared doc, broadcast over GET /live.
 *   (Replaces the former TODO(KI1-followup) per-session isolation approach.)
 */

import fs from 'fs';
import path from 'path';
import type { Response } from 'express';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence';

// ---------------------------------------------------------------------------
// Disk persistence (autosave between server restarts)
// ---------------------------------------------------------------------------

/**
 * Autosave path. Override via `LLULL_AUTOSAVE_PATH`; default lives next to the
 * server bundle. Autosave is disabled inside tests (vitest sets `VITEST`, our
 * own harness sets `TEST`) to avoid clobbering a user's saved project.
 */
const AUTOSAVE_PATH = process.env['LLULL_AUTOSAVE_PATH']
  ?? path.resolve(__dirname, '..', '.autosave.json');

const AUTOSAVE_ENABLED =
  process.env['VITEST'] === undefined &&
  process.env['TEST'] !== 'true' &&
  process.env['LLULL_AUTOSAVE_DISABLED'] !== 'true';

function loadAutosave(): CadDocument {
  if (!AUTOSAVE_ENABLED) return createEmptyDocument();
  try {
    if (!fs.existsSync(AUTOSAVE_PATH)) return createEmptyDocument();
    const json = fs.readFileSync(AUTOSAVE_PATH, 'utf8');
    return deserializeDocument(json);
  } catch (err) {
    console.warn(`[liveDocument] autosave load failed (${(err as Error).message}); starting empty.`);
    return createEmptyDocument();
  }
}

function writeAutosave(doc: CadDocument): void {
  if (!AUTOSAVE_ENABLED) return;
  try {
    fs.mkdirSync(path.dirname(AUTOSAVE_PATH), { recursive: true });
    fs.writeFileSync(AUTOSAVE_PATH, serializeDocument(doc), 'utf8');
  } catch (err) {
    console.warn(`[liveDocument] autosave write failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Shared document
// ---------------------------------------------------------------------------

/** The single live document shared across all MCP sessions and the browser UI. */
let _liveDoc: CadDocument = loadAutosave();

/** Return the current shared document. */
export function getLiveDoc(): CadDocument {
  return _liveDoc;
}

// ---------------------------------------------------------------------------
// SSE subscriber registry
// ---------------------------------------------------------------------------

/**
 * Active SSE subscribers — each entry is an Express `Response` whose connection
 * is kept open for the SSE stream.  Entries are added by `subscribeLive` and
 * removed when the client disconnects.
 */
const _subscribers = new Set<Response>();

/**
 * Serialise and write a single SSE data event carrying the full document.
 * The `data:` line must be a single JSON line terminated by two newlines.
 */
function broadcastDoc(doc: CadDocument): void {
  const payload = `data: ${JSON.stringify(doc)}\n\n`;
  for (const res of _subscribers) {
    try {
      res.write(payload);
    } catch {
      // Write failed (connection already closed) — remove the stale subscriber.
      _subscribers.delete(res);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replace the shared document and broadcast the new state to all SSE subscribers.
 *
 * Called by the MCP router after every mutating `tools/call`.
 * Also callable directly (e.g. from tests or future REST endpoints).
 *
 * @sideeffect replaces module-level `_liveDoc` and broadcasts to all subscribers.
 */
export function setLiveDoc(next: CadDocument): void {
  _liveDoc = next;
  writeAutosave(next);
  broadcastDoc(next);
}

/**
 * Register an SSE subscriber (an Express `Response` already configured for
 * `text/event-stream`).
 *
 * Immediately writes the current document as the opening SSE message so the
 * browser has a snapshot as soon as it connects — no polling needed.
 *
 * Returns an unsubscribe function; call it when the client disconnects.
 */
export function subscribeLive(res: Response): () => void {
  _subscribers.add(res);

  // Send the current snapshot immediately so the browser is in sync from t=0.
  const snapshot = `data: ${JSON.stringify(_liveDoc)}\n\n`;
  try {
    res.write(snapshot);
  } catch {
    // If the write fails immediately the client is already gone; clean up now.
    _subscribers.delete(res);
  }

  return (): void => {
    _subscribers.delete(res);
  };
}

/**
 * Replace the live document without broadcasting (test helper / reset).
 * Production code should always use `setLiveDoc` to ensure the browser is notified.
 *
 * @internal — exposed for tests only.
 */
export function _resetLiveDoc(doc?: CadDocument): void {
  _liveDoc = doc ?? createEmptyDocument();
}

/**
 * Return the current subscriber count (test helper).
 *
 * @internal — exposed for tests only.
 */
export function _subscriberCount(): number {
  return _subscribers.size;
}
