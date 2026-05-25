/**
 * @command load_document
 * @pure
 * @layer core/commands
 * @affects replaces all entities in the document with the loaded ones
 * @invariant parsed document satisfies CadDocument structural constraints
 * @failure invalid JSON / wrong format or version / missing required fields -> no-op, affected:[]
 */

import type { CadDocument, Entity, Layer, CameraState, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

interface DocumentEnvelope {
  format: 'llull-document';
  version: 1;
  document: CadDocument;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a CadDocument to a stable JSON string.
 *
 * Wraps the document in an envelope `{ format: 'llull-document', version: 1, document }`
 * so future schema migrations can be detected. The output is deterministic (standard
 * JSON.stringify with no replacer); entity ordering follows `doc.order`.
 */
export function serializeDocument(doc: CadDocument): string {
  const envelope: DocumentEnvelope = {
    format: 'llull-document',
    version: 1,
    document: doc,
  };
  return JSON.stringify(envelope);
}

// ---------------------------------------------------------------------------
// Deserialization + validation helpers (narrow unknown, no any)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === 'number')
  );
}

function validateCamera(v: unknown): v is CameraState {
  if (!isRecord(v)) return false;
  return (
    isVec3(v['target']) &&
    typeof v['azimuth'] === 'number' &&
    typeof v['polar'] === 'number' &&
    typeof v['distance'] === 'number'
  );
}

function validateLayer(v: unknown): v is Layer {
  if (!isRecord(v)) return false;
  return (
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['visible'] === 'boolean' &&
    typeof v['locked'] === 'boolean'
  );
}

function validateEntity(v: unknown): v is Entity {
  if (!isRecord(v)) return false;
  return (
    typeof v['id'] === 'string' &&
    typeof v['kind'] === 'string' &&
    isVec3(v['position']) &&
    isVec3(v['rotation']) &&
    typeof v['layerId'] === 'string' &&
    typeof v['color'] === 'string'
  );
}

function validateDocument(v: unknown): v is CadDocument {
  if (!isRecord(v)) return false;

  const { entities, order, layers, layerOrder, selection, camera } = v;

  if (!isRecord(entities)) return false;
  for (const entity of Object.values(entities)) {
    if (!validateEntity(entity)) return false;
  }

  if (!isStringArray(order)) return false;
  if (!isStringArray(layerOrder)) return false;
  if (!isStringArray(selection)) return false;

  if (!isRecord(layers)) return false;
  for (const layer of Object.values(layers)) {
    if (!validateLayer(layer)) return false;
  }

  if (!validateCamera(camera)) return false;

  return true;
}

/**
 * Parse and validate a JSON string produced by `serializeDocument`.
 *
 * Throws a descriptive `Error` on any failure:
 * - invalid JSON
 * - missing or wrong `format` field (expected 'llull-document')
 * - wrong or missing `version` field (expected 1)
 * - structurally invalid `document` (missing required fields / wrong types)
 *
 * Callers that need graceful no-op behavior (e.g. `load_document`) must catch
 * this error and handle it themselves.
 */
export function deserializeDocument(json: string): CadDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('load_document: invalid JSON — could not parse input string.');
  }

  if (!isRecord(parsed)) {
    throw new Error('load_document: expected a JSON object at the root level.');
  }

  if (parsed['format'] !== 'llull-document') {
    throw new Error(
      `load_document: unrecognized format '${String(parsed['format'])}' — expected 'llull-document'.`,
    );
  }

  if (parsed['version'] !== 1) {
    throw new Error(
      `load_document: unsupported version ${String(parsed['version'])} — expected 1.`,
    );
  }

  const doc = parsed['document'];
  if (!validateDocument(doc)) {
    throw new Error(
      'load_document: document structure is invalid — missing or malformed required fields ' +
        '(entities, order, layers, layerOrder, selection, camera).',
    );
  }

  return doc;
}

// ---------------------------------------------------------------------------
// load_document command
// ---------------------------------------------------------------------------

interface LoadDocumentParams {
  json: string;
}

export const loadDocument: CommandDefinition<LoadDocumentParams> = {
  name: 'load_document',
  description:
    'Replace the current document with one parsed from a serialized JSON string ' +
    'produced by serializeDocument (envelope format: llull-document v1). ' +
    'On parse or validation failure the document is left unchanged.',
  paramsSchema: {
    type: 'object',
    properties: {
      json: {
        type: 'string',
        description:
          'A JSON string produced by serializeDocument — the full llull-document v1 envelope ' +
          '({ format: "llull-document", version: 1, document: { ... } }). ' +
          'Must contain a valid CadDocument with entities, order, layers, layerOrder, selection, and camera.',
      },
    },
    required: ['json'],
  },
  run: (doc, { json }): CommandResult => {
    let parsed: CadDocument;
    try {
      parsed = deserializeDocument(json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { document: doc, summary: message, affected: [] };
    }

    const entityCount = Object.keys(parsed.entities).length;
    const layerCount = Object.keys(parsed.layers).length;

    return {
      document: parsed,
      summary: `Loaded document: ${entityCount} ${entityCount === 1 ? 'entity' : 'entities'}, ${layerCount} ${layerCount === 1 ? 'layer' : 'layers'}.`,
      affected: parsed.order,
    };
  },
};
