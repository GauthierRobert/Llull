/**
 * @layer mcp
 * MCP resources — read-only views of the live document, so an agent can orient without calling a
 * mutating tool first. Pure over the document; transport wiring lives in `server/`.
 *
 *   cad://document     full serialized CadDocument (llull-document envelope, current version)
 *   cad://scene        structured SceneSnapshot (entity ids/kinds/bounds/layers/groups/selection)
 *   cad://selection    selected entity ids + their kind/position summaries
 *   cad://conventions  static agent modeling guide (Markdown)
 *
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import { serializeDocument } from '@core/commands/persistence';
import { computeSceneSnapshot } from '@core/commands/scene';
import { CONVENTIONS_GUIDE, CONVENTIONS_URI } from './conventions';

/** A resource listing entry (MCP `Resource`); the transport casts it to the SDK type. */
interface McpResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/** A text resource read result (MCP `TextResourceContents`). */
interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export const CAD_RESOURCE_URIS = {
  document: 'cad://document',
  scene: 'cad://scene',
  selection: 'cad://selection',
  conventions: CONVENTIONS_URI,
} as const;

/** @pure static metadata; needs no document */
export function listMcpResources(): McpResourceDescriptor[] {
  return [
    {
      uri: CAD_RESOURCE_URIS.document,
      name: 'CAD Document',
      description:
        'Full serialized CadDocument in the current llull-document JSON envelope (version 2). ' +
        'Use this to inspect or reload the complete document state.',
      mimeType: 'application/json',
    },
    {
      uri: CAD_RESOURCE_URIS.scene,
      name: 'Scene Snapshot',
      description:
        'Structured read-only snapshot of the document: entity ids, kinds, world bounds, ' +
        'layers, groups, and the current selection. Orient here before editing. Models with more than 500 entities get the first 500 plus a `truncated` note (use find_entities, or cad://document for everything).',
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
    {
      uri: CAD_RESOURCE_URIS.conventions,
      name: 'Agent Modeling Conventions',
      description:
        'Read this BEFORE modeling. Covers: document units, the right-handed +Z-up world frame, ' +
        'per-primitive anchor conventions (box=center, cylinder=center, sphere=center, ' +
        'cone=base-center, torus=center, wedge=lower-front-left, pyramid=base-center), ' +
        'rotation in Euler XYZ radians, the recommended orient→create→render→lint loop, ' +
        'and common pitfalls.',
      mimeType: 'text/markdown',
    },
  ];
}

const jsonResource = (uri: string, text: string): McpResourceContent => ({
  uri,
  mimeType: 'application/json',
  text,
});

/** Lists in `cad://scene` / `cad://selection` are cut here so a huge model cannot flood a context. */
export const MAX_RESOURCE_ITEMS = 500;

/** The scene snapshot with long lists cut to `MAX_RESOURCE_ITEMS`; `truncated` says what was cut. */
function boundedScene(doc: CadDocument): Record<string, unknown> {
  const snapshot = computeSceneSnapshot(doc);
  const cut = (items: readonly unknown[]): boolean => items.length > MAX_RESOURCE_ITEMS;
  if (!cut(snapshot.entities) && !cut(snapshot.selection) && !cut(snapshot.animations)) {
    return { ...snapshot };
  }
  return {
    ...snapshot,
    entities: snapshot.entities.slice(0, MAX_RESOURCE_ITEMS),
    selection: snapshot.selection.slice(0, MAX_RESOURCE_ITEMS),
    animations: snapshot.animations.slice(0, MAX_RESOURCE_ITEMS),
    truncated: {
      entityCount: snapshot.entities.length,
      entitiesShown: Math.min(snapshot.entities.length, MAX_RESOURCE_ITEMS),
      selectionCount: snapshot.selection.length,
      animationCount: snapshot.animations.length,
      note: `lists are cut to ${MAX_RESOURCE_ITEMS} items; use find_entities with filters, or cad://document for everything`,
    },
  };
}

/** `cad://selection` payload: selected ids with kind/position (`unknown` for a dangling id). */
function selectionSummary(doc: CadDocument): { count: number; entities: unknown[] } {
  const entities = doc.selection.slice(0, MAX_RESOURCE_ITEMS).map((id) => {
    const e = doc.entities[id];
    return e ? { id, kind: e.kind, position: e.position } : { id, kind: 'unknown', position: null };
  });
  return { count: doc.selection.length, entities };
}

/**
 * Dispatch a resource read by URI. Document-independent resources (conventions) ignore `doc`.
 *
 * @pure over doc
 * @layer mcp
 * @failure unknown URI -> null (the transport replies with an error)
 */
export function readMcpResource(doc: CadDocument, uri: string): McpResourceContent | null {
  switch (uri) {
    case CAD_RESOURCE_URIS.document:
      return jsonResource(uri, serializeDocument(doc));
    case CAD_RESOURCE_URIS.scene:
      return jsonResource(uri, JSON.stringify(boundedScene(doc)));
    case CAD_RESOURCE_URIS.selection:
      return jsonResource(uri, JSON.stringify(selectionSummary(doc)));
    case CAD_RESOURCE_URIS.conventions:
      return { uri, mimeType: 'text/markdown', text: CONVENTIONS_GUIDE };
    default:
      return null;
  }
}
