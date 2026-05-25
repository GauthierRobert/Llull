/**
 * @layer core/mcp
 *
 * MCP resource builders — pure, framework-agnostic.
 *
 * Three read-only resources expose the server's current document state to an
 * MCP agent without the agent having to call any mutating tool first.
 *
 * Resource URIs:
 *   cad://document  — full serialized CadDocument (llull-document v1 envelope)
 *   cad://scene     — structured SceneSnapshot (entity ids/kinds/bounds/layers/groups/selection)
 *   cad://selection — currently selected entity ids + their kind/position summaries
 *
 * All functions are pure over the document: they read, never mutate.
 * No fetch, no DOM, no SDK imports — transport wiring lives in server/.
 *
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import { serializeDocument } from '@core/commands/persistence';
import { computeSceneSnapshot } from '@core/commands/scene';

// ---------------------------------------------------------------------------
// Resource descriptor type (minimal — mirrors MCP ResourceSchema fields)
// ---------------------------------------------------------------------------

/**
 * A single resource listing entry, matching the MCP `Resource` schema.
 * The transport layer casts this to the SDK's type; we keep no SDK dep here.
 */
export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * A single text-content block for a resource read result.
 * Mirrors the MCP `TextResourceContents` schema.
 */
export interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Static resource list (URIs + metadata, document-independent)
// ---------------------------------------------------------------------------

/** The three URIs this module exposes. */
export const CAD_RESOURCE_URIS = {
  document: 'cad://document',
  scene: 'cad://scene',
  selection: 'cad://selection',
} as const;

export type CadResourceUri = (typeof CAD_RESOURCE_URIS)[keyof typeof CAD_RESOURCE_URIS];

/**
 * Return the static list of resource descriptors.
 *
 * @pure — no document needed; just metadata.
 * @layer core/mcp
 */
export function listMcpResources(): McpResourceDescriptor[] {
  return [
    {
      uri: CAD_RESOURCE_URIS.document,
      name: 'CAD Document',
      description:
        'Full serialized CadDocument in the llull-document v1 JSON envelope. ' +
        'Use this to inspect or reload the complete document state.',
      mimeType: 'application/json',
    },
    {
      uri: CAD_RESOURCE_URIS.scene,
      name: 'Scene Snapshot',
      description:
        'Structured read-only snapshot of the document: entity ids, kinds, world bounds, ' +
        'layers, groups, and the current selection. Orient here before editing.',
      mimeType: 'application/json',
    },
    {
      uri: CAD_RESOURCE_URIS.selection,
      name: 'Current Selection',
      description:
        'The currently selected entity ids and a brief summary (kind, position) for each. ' +
        'Empty array when nothing is selected.',
      mimeType: 'application/json',
    },
  ];
}

// ---------------------------------------------------------------------------
// Resource read handlers
// ---------------------------------------------------------------------------

/**
 * Read `cad://document` — full serialized CadDocument.
 *
 * @pure over doc
 * @layer core/mcp
 */
export function readDocumentResource(doc: CadDocument): McpResourceContent {
  return {
    uri: CAD_RESOURCE_URIS.document,
    mimeType: 'application/json',
    text: serializeDocument(doc),
  };
}

/**
 * Read `cad://scene` — structured SceneSnapshot.
 *
 * @pure over doc
 * @layer core/mcp
 */
export function readSceneResource(doc: CadDocument): McpResourceContent {
  const snapshot = computeSceneSnapshot(doc);
  return {
    uri: CAD_RESOURCE_URIS.scene,
    mimeType: 'application/json',
    text: JSON.stringify(snapshot),
  };
}

/**
 * Read `cad://selection` — selected entity ids + kind/position summaries.
 *
 * @pure over doc
 * @layer core/mcp
 */
export function readSelectionResource(doc: CadDocument): McpResourceContent {
  const selected = doc.selection.map((id) => {
    const e = doc.entities[id];
    if (!e) return { id, kind: 'unknown', position: null };
    return { id, kind: e.kind, position: e.position };
  });
  return {
    uri: CAD_RESOURCE_URIS.selection,
    mimeType: 'application/json',
    text: JSON.stringify({ count: selected.length, entities: selected }),
  };
}

/**
 * Dispatch a resource read by URI.
 *
 * Returns `null` when the URI is not one of the three known resources
 * (the transport should reply with an appropriate error).
 *
 * @pure over doc
 * @layer core/mcp
 * @failure unknown URI -> null
 */
export function readMcpResource(doc: CadDocument, uri: string): McpResourceContent | null {
  switch (uri) {
    case CAD_RESOURCE_URIS.document:
      return readDocumentResource(doc);
    case CAD_RESOURCE_URIS.scene:
      return readSceneResource(doc);
    case CAD_RESOURCE_URIS.selection:
      return readSelectionResource(doc);
    default:
      return null;
  }
}
