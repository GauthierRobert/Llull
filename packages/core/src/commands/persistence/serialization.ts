/**
 * @affects replaces all entities in the document with the loaded ones
 * @invariant parsed document satisfies CadDocument structural + value constraints
 * @failure invalid JSON / wrong format or version / structural or value validation error -> no-op, affected:[]
 */

import { type CadDocument, DOCUMENT_UNITS } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, noop } from '../noop';
import { errorMessage } from '../../lib/errorMessage';
import { isRecord } from '../../lib/isRecord';
import { derivedEntityIds, documentExtensions } from '../../plugins/host';
import { validateDocumentShape, validateDocumentValues } from './validation';
import { migrateRetiredCommands } from './retiredCommands';
import { withoutPrivateValues } from '../materials/libraryRecords';

interface DocumentEnvelope {
  format: 'llull-document';
  version: 3;
  document: CadDocument;
}

/** Bump on a breaking field; `migrate()` upgrades older documents. */
const CURRENT_SCHEMA_VERSION = 3;

/** v1 files (legacy ids, building entities stored) load unchanged; v2 adds step-scoped ids; v3 adds kernelSettings + blobs (aerospace 01); v1/v2 need no rewrite for v3 (both slices stay absent). */
const READABLE_VERSIONS: ReadonlySet<unknown> = new Set([1, 2, 3]);

interface SerializeOptions {
  /**
   * Keep evaluated geometry that the definition regenerates (building-element entities). Default false: files store the definition only.
   * Hashing and diffing pass true.
   */
  readonly includeDerived?: boolean;
}

/**
 * Deterministic `{ format: 'llull-document', version, document }` JSON; derived entities omitted unless `includeDerived`.
 * @invariant values of `private` material libraries are never written: their records are stubs { id, libraryRef, marking } (TR-MAT-31)
 * @invariant a function of the document alone: kernel provenance (`kernelSettings`) is written by the commands that use the exact kernel
 *   (`import_step_exact`, `set_modeling_tolerance`) from their own ctx, never from the ambient kernel at save time
 */
export function serializeDocument(doc: CadDocument, options: SerializeOptions = {}): string {
  const envelope: DocumentEnvelope = {
    format: 'llull-document',
    version: CURRENT_SCHEMA_VERSION,
    document: withoutPrivateValues(options.includeDerived === true ? doc : withoutDerivedEntities(doc)),
  };
  return JSON.stringify(envelope);
}

function withoutDerivedEntities(doc: CadDocument): CadDocument {
  const derived = derivedEntityIds(doc);
  if (derived.size === 0) return doc;
  const entities = Object.entries(doc.entities).filter(([id]) => !derived.has(id));
  return { ...doc, entities: Object.fromEntries(entities) };
}

const STEP_SCOPED_ID = /-(\d+)\.\d+$/;
const STEP_ID = /^step-(\d+)$/;

/**
 * `nextStepNumber` is at least one past every step number used by a step or entity id, so a file whose counter is missing or stale can
 * never make a new step re-mint an existing id.
 */
function withSafeStepCounter(raw: Record<string, unknown>): Record<string, unknown> {
  let highest = 0;
  const noteStepNumber = (digits: string | undefined, what: string): void => {
    if (digits === undefined) return;
    const n = Number(digits);
    if (!Number.isSafeInteger(n)) throw new Error(`load_document: ${what} has a step number that is not a safe integer.`);
    // `-0.<n>` is a legal user-chosen id suffix: it can never collide with a step-minted id (steps start at 1)
    if (n >= 1) highest = Math.max(highest, n);
  };
  // Entries are not validated yet: skip anything that is not a record with a string id so the value validation below reports
  // "featureHistory[i] is malformed" instead of a TypeError.
  const steps: unknown[] = Array.isArray(raw['featureHistory']) ? raw['featureHistory'] : [];
  for (const step of steps) {
    if (!isRecord(step) || typeof step['id'] !== 'string') continue;
    noteStepNumber(STEP_ID.exec(step['id'])?.[1], `history step '${step['id']}'`);
  }
  for (const id of Object.keys(isRecord(raw['entities']) ? raw['entities'] : {}))
    noteStepNumber(STEP_SCOPED_ID.exec(id)?.[1], `entity id '${id}'`);
  const drawings = raw['drawings'];
  for (const [sheetId, sheet] of Object.entries(isRecord(drawings) && isRecord(drawings['sheets']) ? drawings['sheets'] : {})) {
    noteStepNumber(STEP_SCOPED_ID.exec(sheetId)?.[1], `sheet id '${sheetId}'`);
    const views: unknown[] = isRecord(sheet) && Array.isArray(sheet['views']) ? sheet['views'] : [];
    for (const view of views)
      if (isRecord(view) && typeof view['id'] === 'string') noteStepNumber(STEP_SCOPED_ID.exec(view['id'])?.[1], `view id '${view['id']}'`);
  }
  const stored = raw['nextStepNumber'];
  if (stored !== undefined && (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 1))
    throw new Error(`load_document: nextStepNumber must be a safe integer >= 1, got ${String(stored)}.`);
  const next = Math.max(stored ?? 1, highest + 1);
  if (!Number.isSafeInteger(next)) throw new Error('load_document: nextStepNumber would exceed the safe integer range.');
  return next === 1 && stored === undefined ? raw : { ...raw, nextStepNumber: next };
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

/** `layerOrder` without duplicates, with any layer it omits appended (benign drift); ids that are not layers are kept for validation. */
function repairedLayerOrder(raw: Record<string, unknown>): string[] {
  const order = [...new Set(raw['layerOrder'] as string[])];
  const missing = Object.keys(raw['layers'] as Record<string, unknown>).filter((id) => !order.includes(id));
  return [...order, ...missing];
}

/** `order` with any entity it omits appended (benign drift; every entity is value-checked regardless of `order`). */
function repairedOrder(raw: Record<string, unknown>): string[] {
  const order = raw['order'] as string[];
  const listed = new Set(order);
  return [...order, ...Object.keys(raw['entities'] as Record<string, unknown>).filter((id) => !listed.has(id))];
}

/**
 * Upgrade a raw document object (already shape-validated) to the current schema: the SINGLE place for back-compat defaults. A new optional
 * `CadDocument` field gets its default here.
 */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const units = DOCUMENT_UNITS.find((unit) => unit === raw['units']) ?? 'mm';
  const displayPrecision: number =
    typeof raw['displayPrecision'] === 'number' && raw['displayPrecision'] >= 0 && Number.isInteger(raw['displayPrecision'])
      ? raw['displayPrecision']
      : 3;
  const collections = Object.fromEntries(
    COLLECTION_DEFAULTS.map(([key, shape]) => {
      const value = raw[key];
      return [key, shape === 'record' ? (isRecord(value) ? value : {}) : Array.isArray(value) ? value : []];
    }),
  );
  return { ...raw, units, displayPrecision, order: repairedOrder(raw), layerOrder: repairedLayerOrder(raw), ...collections };
}

/**
 * Parse and validate a `serializeDocument` string (old files gain defaults via `migrate()`).
 * @invariant every document a registered command produced reloads and re-serializes equal (tests/unit/persistenceRoundTrip.test.ts); the
 *   feature-history command-name check is skipped while the command table is empty (registry not imported)
 * @failure throws an Error naming the failing field (bad JSON, format, version, structure, values); `load_document` turns it into a no-op
 *   summary
 */
export function deserializeDocument(json: string): CadDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('load_document: invalid JSON — could not parse input string.');
  }
  if (!isRecord(parsed)) throw new Error('load_document: expected a JSON object at the root level.');
  if (parsed['format'] !== 'llull-document')
    throw new Error(`load_document: unrecognized format '${String(parsed['format'])}' — expected 'llull-document'.`);
  if (!READABLE_VERSIONS.has(parsed['version']))
    throw new Error(`load_document: unsupported version ${String(parsed['version'])} — expected 1, 2 or ${CURRENT_SCHEMA_VERSION}.`);
  const rawDoc = parsed['document'];
  if (!validateDocumentShape(rawDoc))
    throw new Error(
      'load_document: document structure is invalid — missing or malformed required fields ' +
        '(entities, order, layers, layerOrder, selection, camera).',
    );
  const migratedDoc = withSafeStepCounter(restoreDerivedEntities(migrateRetiredCommands(migrate(rawDoc))));
  const valueErrors = validateDocumentValues(migratedDoc);
  if (valueErrors.length > 0) throw new Error(`load_document: document contains invalid values:\n  ${valueErrors.join('\n  ')}`);
  return migratedDoc as unknown as CadDocument;
}

export const loadDocument = defineCommand({
  name: 'load_document',
  description:
    'Replace the current document with one parsed from a serialized JSON string ' +
    'produced by serializeDocument (envelope format: llull-document v3; v1 and v2 are still read). ' +
    'On parse or validation failure the document is left unchanged.',
  annotations: { metaHistory: true, idempotent: true },
  params: z.object({
    json: z
      .string()
      .describe(
        'A JSON string produced by serializeDocument — the full llull-document envelope ' +
          '({ format: "llull-document", version: 3, document: { ... } }; versions 1 and 2 are also read). ' +
          'Must contain a valid CadDocument with entities, order, layers, layerOrder, selection, and camera.',
      ),
  }),
  run: (doc, { json }): CommandResult => {
    let parsed: CadDocument;
    try {
      parsed = deserializeDocument(json);
    } catch (err) {
      return noop(doc, errorMessage(err));
    }
    const entityCount = Object.keys(parsed.entities).length;
    const layerCount = Object.keys(parsed.layers).length;
    return changed(
      parsed,
      `Loaded document: ${entityCount} ${entityCount === 1 ? 'entity' : 'entities'}, ${layerCount} ${layerCount === 1 ? 'layer' : 'layers'}.`,
      parsed.order,
    );
  },
});
