/**
 * Old-document corpus (SC-D2): files written by earlier builds (llull-document v1, v2, v3; tests/corpus/documents/) must load via
 * `load_document` and evaluate as saved. Each `<name>.llull.json` has a sidecar `<name>.expected.json`.
 * The v1/v2 files are the golden snapshots of the builds before the v2 (c87410ce) and v3 (3eb97d50) bumps, taken from git history.
 * `LLULL_CORPUS_UPDATE=1` rewrites the sidecars (review the diff).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';

const CORPUS_DIR = path.resolve(__dirname, '..', 'corpus', 'documents');
const DOCUMENT_SUFFIX = '.llull.json';

interface Expected {
  readonly version: number;
  readonly entityCount: number;
  readonly kinds: Record<string, number>;
  readonly boundingBox: { readonly min: number[]; readonly max: number[] } | null;
  readonly featureSteps: number;
}

const rounded = (values: readonly number[]): number[] => values.map((value) => Number(value.toPrecision(9)));

function measured(doc: CadDocument, version: number): Expected {
  const kinds: Record<string, number> = {};
  for (const entity of Object.values(doc.entities)) kinds[entity.kind] = (kinds[entity.kind] ?? 0) + 1;
  const box = execute(doc, 'measure_bounding_box', {}).data as { min: number[]; max: number[] } | undefined;
  return {
    version,
    entityCount: Object.keys(doc.entities).length,
    kinds: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b))),
    boundingBox: box === undefined ? null : { min: rounded(box.min), max: rounded(box.max) },
    featureSteps: doc.featureHistory.length,
  };
}

const corpusFiles = readdirSync(CORPUS_DIR)
  .filter((name) => name.endsWith(DOCUMENT_SUFFIX))
  .sort();

describe('old-document corpus', () => {
  it('covers every readable format version', () => {
    const versions = new Set(
      corpusFiles.map((name) => (JSON.parse(readFileSync(path.join(CORPUS_DIR, name), 'utf8')) as { version: number }).version),
    );
    expect([...versions].sort()).toEqual([1, 2, 3]);
  });

  it.each(corpusFiles)('%s loads via load_document and evaluates as saved', (name) => {
    const json = readFileSync(path.join(CORPUS_DIR, name), 'utf8');
    const version = (JSON.parse(json) as { version: number }).version;
    const result = execute(createEmptyDocument(), 'load_document', { json });
    expect(result.summary).toMatch(/^Loaded document/);
    const actual = measured(result.document, version);
    const sidecar = path.join(CORPUS_DIR, name.replace(DOCUMENT_SUFFIX, '.expected.json'));
    if (process.env['LLULL_CORPUS_UPDATE'] === '1') writeFileSync(sidecar, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(sidecar, 'utf8')) as Expected);
    // Saved again by this build, it reloads to the same document.
    const resaved = serializeDocument(result.document);
    expect(serializeDocument(deserializeDocument(resaved))).toBe(resaved);
  });
});
