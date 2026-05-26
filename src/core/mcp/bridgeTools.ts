/**
 * @layer core/mcp
 *
 * MCP-only bridge tool definitions and dispatcher.
 *
 * These two tools (`snapshot_in_from_ui`, `snapshot_out_to_ui`) are NOT core
 * commands registered in `registry.ts` — they are MCP-transport-level tools that
 * require a `UiBridge` dependency to communicate with the running UI.  They are
 * deliberately kept out of `core/commands` because they have no pure
 * `(doc, params) => CommandResult` form; they need I/O.
 *
 * They are injected into the MCP server at the `tools/call` handler level so the
 * bridge reference is never a module-level singleton (DIP / architecture L2/L5).
 *
 * Tool annotations:
 *   snapshot_in_from_ui  — readOnly: true  (reads UI doc → session; no UI mutation)
 *   snapshot_out_to_ui   — destructive: true (stages session doc → pending UI publish)
 *
 * @pure over CadDocument — neither function mutates its input.
 * No network, no DOM, no SDK imports. All transports live in `server/`.
 */

import type { CadDocument } from '@core/model/types';
import type { UiBridge } from './uiBridge';
import type { McpToolDefinition } from './tools';
import { shapeToolCallContent } from './dispatch';
import type { McpShapedResult } from './dispatch';

// ---------------------------------------------------------------------------
// Tool schema definitions (hand-written, not from registry — these are
// bridge-level tools, not document commands; they have no paramsSchema in the
// registry sense — they take no user parameters).
// ---------------------------------------------------------------------------

/**
 * The two bridge tool definitions returned by `buildBridgeToolDefinitions`.
 * Appended to `buildMcpTools()` output by the server's `tools/list` handler.
 */
export function buildBridgeToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: 'snapshot_in_from_ui',
      description:
        'Replace this MCP session\'s working document with the current live UI document. ' +
        'The UI must have pushed its document via POST /ui-bridge/push first. ' +
        'No-op (with explanation) if no UI document is available. ' +
        'Read-only with respect to the UI — the UI document is not modified.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'snapshot_out_to_ui',
      description:
        'Stage the current MCP session document as a pending publish for the UI. ' +
        'The UI can retrieve it via POST /ui-bridge/pull. ' +
        'Marks the staged document as destructive: it will REPLACE the UI document ' +
        'on the next pull. Returns a summary of the staged document (entity count, layers).',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      annotations: {
        destructiveHint: true,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Result of a bridge tool call: the (possibly updated) session document and
 * the MCP-shaped content response.
 */
export interface BridgeToolResult extends McpShapedResult {
  /** Updated session document. Same reference as input unless snapshot_in replaced it. */
  document: CadDocument;
}

/**
 * Dispatch a bridge tool call.
 *
 * Called from the MCP `tools/call` handler BEFORE the normal command bus path.
 * Returns `null` when `toolName` is not a bridge tool — the caller falls through
 * to `applyCommand`.
 *
 * @pure over the provided CadDocument; the async I/O happens inside `bridge`.
 * @layer core/mcp
 *
 * @param sessionDoc - the caller's current session document.
 * @param toolName   - the MCP tool name from the request.
 * @param bridge     - the injected UiBridge (from server startup).
 */
export async function applyBridgeToolCall(
  sessionDoc: CadDocument,
  toolName: string,
  bridge: UiBridge,
): Promise<BridgeToolResult | null> {
  if (toolName === 'snapshot_in_from_ui') {
    return applySnapshotIn(sessionDoc, bridge);
  }
  if (toolName === 'snapshot_out_to_ui') {
    return applySnapshotOut(sessionDoc, bridge);
  }
  return null;
}

// ---------------------------------------------------------------------------
// snapshot_in_from_ui implementation
// ---------------------------------------------------------------------------

/**
 * Replace the session document with the live UI document.
 *
 * - Calls `bridge.getLiveDocument()`.
 * - If null → graceful no-op, returns the unchanged session doc.
 * - Otherwise → returns the UI doc as the new session doc.
 *
 * @pure with respect to sessionDoc — never mutates it.
 * @readOnly with respect to the UI — never calls `publishDocument`.
 */
async function applySnapshotIn(
  sessionDoc: CadDocument,
  bridge: UiBridge,
): Promise<BridgeToolResult> {
  const liveDoc = bridge.getLiveDocument();

  if (liveDoc === null) {
    const shaped = shapeToolCallContent({
      summary:
        'snapshot_in_from_ui: no UI document available. ' +
        'The UI must POST its document to /ui-bridge/push first.',
      affected: [],
      isError: false,
    });
    return { ...shaped, document: sessionDoc };
  }

  const entityCount = Object.keys(liveDoc.entities).length;
  const layerCount = Object.keys(liveDoc.layers).length;

  const shaped = shapeToolCallContent({
    summary:
      `snapshot_in_from_ui: session document replaced with live UI document ` +
      `(${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}, ${layerCount} layer${layerCount === 1 ? '' : 's'}).`,
    affected: [],
    isError: false,
  });

  return { ...shaped, document: liveDoc };
}

// ---------------------------------------------------------------------------
// snapshot_out_to_ui implementation
// ---------------------------------------------------------------------------

/**
 * Stage the session document as a pending UI publish.
 *
 * - Calls `bridge.publishDocument(sessionDoc)`.
 * - Returns a summary describing the staged document.
 * - Session doc is NEVER mutated.
 *
 * @pure over sessionDoc.
 * @destructive from the UI's perspective: the staged doc will replace the UI doc on pull.
 */
async function applySnapshotOut(
  sessionDoc: CadDocument,
  bridge: UiBridge,
): Promise<BridgeToolResult> {
  const entityCount = Object.keys(sessionDoc.entities).length;
  const layerCount = Object.keys(sessionDoc.layers).length;

  const publishResult = await bridge.publishDocument(sessionDoc);

  if (!publishResult.ok) {
    const shaped = shapeToolCallContent({
      summary: `snapshot_out_to_ui: failed to stage document — ${publishResult.summary}`,
      affected: [],
      isError: true,
    });
    return { ...shaped, document: sessionDoc };
  }

  const shaped = shapeToolCallContent({
    summary:
      `snapshot_out_to_ui: session document staged for UI publish ` +
      `(${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}, ${layerCount} layer${layerCount === 1 ? '' : 's'}). ` +
      `The UI can retrieve it via POST /ui-bridge/pull.`,
    affected: [],
    isError: false,
  });

  return { ...shaped, document: sessionDoc };
}
