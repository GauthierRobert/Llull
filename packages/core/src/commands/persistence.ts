/**
 * @command load_document
 * @pure
 * @layer core/commands
 * @affects replaces all entities in the document with the loaded ones
 * @invariant parsed document satisfies CadDocument structural + value constraints
 * @failure invalid JSON / wrong format or version / structural or value validation error -> no-op, affected:[]
 */

import type { CadDocument, DocumentUnit, FeatureStep } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { isRecord } from '../lib/isRecord';
import { derivedEntityIds } from '../model/partition';
import { documentExtensions } from '../plugins/host';
import { VALID_UNITS } from './persistenceGuards';
import { validateDocumentShape, validateDocumentValues } from './persistenceValidation';

interface DocumentEnvelope {
  format: 'llull-document';
  version: 2;
  document: CadDocument;
}

/** Bump on a breaking field; `migrate()` upgrades older documents. */
const CURRENT_SCHEMA_VERSION = 2;

/** v1 files (legacy ids, building entities stored) load unchanged; v2 adds step-scoped ids. */
const READABLE_VERSIONS: ReadonlySet<unknown> = new Set([1, 2]);

interface SerializeOptions {
  /**
   * Keep evaluated geometry that the definition regenerates (building-element entities).
   * Default false: files store the definition only. Hashing and diffing pass true.
   */
  readonly includeDerived?: boolean;
}

/** Deterministic `{ format: 'llull-document', version, document }` JSON; derived entities omitted unless `includeDerived`. */
export function serializeDocument(doc: CadDocument, options: SerializeOptions = {}): string {
  const envelope: DocumentEnvelope = {
    format: 'llull-document',
    version: CURRENT_SCHEMA_VERSION,
    document: options.includeDerived === true ? doc : withoutDerivedEntities(doc),
  };
  return JSON.stringify(envelope);
}

function withoutDerivedEntities(doc: CadDocument): CadDocument {
  const derived = derivedEntityIds(doc);
  if (derived.size === 0) return doc;
  const entities: CadDocument['entities'] = {};
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (!derived.has(id)) entities[id] = entity;
  }
  return { ...doc, entities };
}

const STEP_SCOPED_ID = /-(\d+)\.\d+$/;
const STEP_ID = /^step-(\d+)$/;

/**
 * `nextStepNumber` is at least one past every step number used by a step or entity id, so a file
 * whose counter is missing or stale can never make a new step re-mint an existing id.
 */
function withSafeStepCounter(raw: Record<string, unknown>): Record<string, unknown> {
  let highest = 0;
  const steps = Array.isArray(raw['featureHistory'])
    ? (raw['featureHistory'] as FeatureStep[])
    : [];
  for (const step of steps) highest = Math.max(highest, Number(STEP_ID.exec(step.id)?.[1] ?? 0));
  for (const id of Object.keys(isRecord(raw['entities']) ? raw['entities'] : {})) {
    highest = Math.max(highest, Number(STEP_SCOPED_ID.exec(id)?.[1] ?? 0));
  }
  const stored = typeof raw['nextStepNumber'] === 'number' ? raw['nextStepNumber'] : 1;
  const next = Math.max(stored, highest + 1);
  return next === 1 && raw['nextStepNumber'] === undefined ? raw : { ...raw, nextStepNumber: next };
}

/** Re-derive geometry the file omitted, via every installed plugin's document extension. */
function restoreDerivedEntities(raw: Record<string, unknown>): Record<string, unknown> {
  return documentExtensions().reduce((current, extension) => extension.restore(current), raw);
}

/** Optional document collections, in output key order; absent (older files) -> empty default. */
const COLLECTION_DEFAULTS: ReadonlyArray<readonly [string, 'record' | 'array']> = [
  ['parameters', 'record'],
  ['animations', 'record'],
  ['featureHistory', 'array'],
  ['configurations', 'record'],
  ['materials', 'record'],
  ['groups', 'record'],
  ['recipes', 'record'],
  ['components', 'record'],
  ['constraints', 'record'],
  ['constraintOrder', 'array'],
  ['joints', 'record'],
  ['jointOrder', 'array'],
  ['driveRelations', 'record'],
  ['driveRelationOrder', 'array'],
];

/**
 * Upgrade a raw document object (already shape-validated) to the current schema: the SINGLE
 * place for back-compat defaults. A new optional `CadDocument` field gets its default here.
 */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const units: DocumentUnit =
    typeof raw['units'] === 'string' && VALID_UNITS.has(raw['units'])
      ? (raw['units'] as DocumentUnit)
      : 'mm';
  const displayPrecision: number =
    typeof raw['displayPrecision'] === 'number' &&
    raw['displayPrecision'] >= 0 &&
    Number.isInteger(raw['displayPrecision'])
      ? raw['displayPrecision']
      : 3;
  const collections = Object.fromEntries(
    COLLECTION_DEFAULTS.map(([key, shape]) => {
      const value = raw[key];
      return [
        key,
        shape === 'record' ? (isRecord(value) ? value : {}) : Array.isArray(value) ? value : [],
      ];
    }),
  );
  return { ...raw, units, displayPrecision, ...collections };
}

/**
 * Parse and validate a `serializeDocument` string (old files gain defaults via `migrate()`).
 * @failure throws an Error naming the failing field (bad JSON, format, version, structure, values);
 *   `load_document` turns it into a no-op summary
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

  if (!READABLE_VERSIONS.has(parsed['version'])) {
    throw new Error(
      `load_document: unsupported version ${String(parsed['version'])} — expected 1 or ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  const rawDoc = parsed['document'];
  if (!validateDocumentShape(rawDoc)) {
    throw new Error(
      'load_document: document structure is invalid — missing or malformed required fields ' +
        '(entities, order, layers, layerOrder, selection, camera).',
    );
  }

  const migratedDoc = withSafeStepCounter(restoreDerivedEntities(migrate(rawDoc)));

  const valueErrors = validateDocumentValues(migratedDoc);
  if (valueErrors.length > 0) {
    throw new Error(
      `load_document: document contains invalid values:\n  ${valueErrors.join('\n  ')}`,
    );
  }

  return migratedDoc as unknown as CadDocument;
}

export const loadDocument = defineCommand({
  name: 'load_document',
  description:
    'Replace the current document with one parsed from a serialized JSON string ' +
    'produced by serializeDocument (envelope format: llull-document v2; v1 is still read). ' +
    'On parse or validation failure the document is left unchanged.',
  annotations: { metaHistory: true, idempotent: true },
  params: z.object({
    json: z
      .string()
      .describe(
        'A JSON string produced by serializeDocument — the full llull-document envelope ' +
          '({ format: "llull-document", version: 2, document: { ... } }; version 1 is also read). ' +
          'Must contain a valid CadDocument with entities, order, layers, layerOrder, selection, and camera.',
      ),
  }),
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
});
