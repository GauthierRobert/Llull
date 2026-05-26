/**
 * @layer core/mcp
 *
 * UiBridge port — the narrow interface that decouples MCP-layer bridge tools
 * from the concrete server-side (or test stub) implementation.
 *
 * Architecture notes:
 * - This file is PURE TS: no DOM, no fetch, no UI imports (architecture L2).
 * - The concrete implementation lives in `server/src/uiBridge.ts`.
 * - MCP tools that need UI↔session bridging receive a `UiBridge` as a parameter;
 *   they never import the implementation (DIP / architecture L5).
 *
 * Bidirectional bridge semantics:
 *   snapshot_in_from_ui  → getLiveDocument() → replaces session working doc
 *   snapshot_out_to_ui   → publishDocument() → stages pending publish for UI pull
 */

import type { CadDocument } from '@core/model/types';

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

/**
 * Narrow port for the UI↔MCP live-sync bridge.
 *
 * @pure - implementations MUST NOT mutate the provided CadDocument.
 * @layer core/mcp (interface only — no implementation here)
 */
export interface UiBridge {
  /**
   * Return the most recently pushed UI document, or `null` when no document
   * has been pushed yet (UI not connected or bridge is fresh).
   *
   * @readOnly — callers MUST NOT mutate the returned document.
   */
  getLiveDocument(): CadDocument | null;

  /**
   * Stage `doc` as a pending publish — the UI will receive it on the next
   * `/ui-bridge/pull` request.
   *
   * This is a ONE-WAY, ONE-SHOT operation: the staged document is cleared
   * after the first pull so the UI never receives the same snapshot twice.
   *
   * Returns `{ ok: true }` on success; `{ ok: false, summary }` when the
   * bridge cannot accept the document (e.g. serialisation error).
   */
  publishDocument(doc: CadDocument): Promise<{ ok: boolean; summary: string }>;
}
