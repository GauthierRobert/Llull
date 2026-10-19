/**
 * Damaged documents (SC-D2): truncated, bit-flipped and hostile variants of the corpus (tests/corpus/documents/) never throw past
 * `load_document`, never hang, never pollute prototypes; the result is the unchanged document (with a failure summary) or a loaded
 * document that saves and reloads again. Variants are generated from a fixed seed, so a failure names a reproducible case.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';

const CORPUS_DIR = path.resolve(__dirname, '..', 'corpus', 'documents');
const MAX_LOAD_MS = 5_000;
const NESTING_DEPTH = 10_000;
const HUGE_INPUT_FILES: ReadonlySet<string> = new Set(['v1-primitives.llull.json', 'v2-primitives.llull.json', 'v3-gears.llull.json']);

const corpus: ReadonlyArray<readonly [string, string]> = readdirSync(CORPUS_DIR)
  .filter((name) => name.endsWith('.llull.json'))
  .sort()
  .map((name) => [name, readFileSync(path.join(CORPUS_DIR, name), 'utf8')] as const);

/** mulberry32: a small seeded PRNG so every variant is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BEFORE = createEmptyDocument();

/** Load `json` over a fixed document; assert the outcome is safe. */
function expectSafeLoad(json: string): void {
  const started = performance.now();
  let result: ReturnType<typeof execute> | undefined;
  expect(() => {
    result = execute(BEFORE, 'load_document', { json });
  }).not.toThrow();
  expect(performance.now() - started).toBeLessThan(MAX_LOAD_MS);
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  expect(Object.prototype).not.toHaveProperty('polluted');
  if (result === undefined) return;
  if (result.document === BEFORE) {
    expect(result.affected).toEqual([]);
    expect(result.summary.length).toBeGreaterThan(0);
    return;
  }
  expect(result.summary).toMatch(/^Loaded document/);
  expectSavesAndReloads(result.document);
}

function expectSavesAndReloads(doc: CadDocument): void {
  const saved = serializeDocument(doc);
  expect(() => deserializeDocument(saved)).not.toThrow();
}

function truncations(text: string): string[] {
  const offsets = new Set([
    0,
    1,
    2,
    text.length - 2,
    text.length - 1,
    ...[0.1, 0.25, 0.5, 0.75, 0.9].map((f) => Math.floor(text.length * f)),
  ]);
  return [...offsets].filter((offset) => offset >= 0 && offset < text.length).map((offset) => text.slice(0, offset));
}

function bitFlips(text: string, seed: number, count: number): string[] {
  const random = seededRandom(seed);
  const bytes = Buffer.from(text, 'utf8');
  return Array.from({ length: count }, () => {
    const copy = Buffer.from(bytes);
    const flips = 1 + Math.floor(random() * 8);
    for (let index = 0; index < flips; index++) {
      const at = Math.floor(random() * copy.length);
      copy[at] = (copy[at] ?? 0) ^ (1 << Math.floor(random() * 8));
    }
    return copy.toString('utf8');
  });
}

/** Every numeric literal position in `text` (outside strings is good enough: ids carry no bare numbers after a colon/bracket). */
function numberSpans(text: string): Array<readonly [number, number]> {
  return [...text.matchAll(/(?<=[:[,]\s*)-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)].map(
    (match) => [match.index, match.index + match[0].length] as const,
  );
}

const HOSTILE_NUMBERS = ['1e308', '-1e308', '1e309', '-1e309', '-1', '0', '-0', '5e-324', '9007199254740993', '1e-400'];

function hostileNumbers(text: string, seed: number, count: number): string[] {
  const random = seededRandom(seed);
  const spans = numberSpans(text);
  if (spans.length === 0) return [];
  const variants = HOSTILE_NUMBERS.map((value) =>
    spans.reduceRight((acc, [start, end]) => acc.slice(0, start) + value + acc.slice(end), text),
  );
  for (let index = 0; index < count; index++) {
    const [start, end] = spans[Math.floor(random() * spans.length)] ?? [0, 0];
    const value = HOSTILE_NUMBERS[Math.floor(random() * HOSTILE_NUMBERS.length)] ?? '0';
    variants.push(text.slice(0, start) + value + text.slice(end));
  }
  return variants;
}

interface Envelope {
  format: string;
  version: number;
  document: Record<string, unknown> & { entities: Record<string, Record<string, unknown>>; order: string[] };
}

const envelopeOf = (text: string): Envelope => JSON.parse(text) as Envelope;

/** Structural edits; each returns the JSON text of the hostile file ('' = a huge-input edit left unbuilt without `includeHuge`). */
function structuralVariants(text: string, includeHuge: boolean): Array<readonly [string, string]> {
  const firstId = (envelope: Envelope): string => envelope.document.order[0] ?? Object.keys(envelope.document.entities)[0] ?? 'missing';
  const edit = (label: string, change: (envelope: Envelope) => unknown): readonly [string, string] => {
    if (label.startsWith('huge') && !includeHuge) return [label, ''];
    const envelope = envelopeOf(text);
    const replaced = change(envelope);
    return [label, JSON.stringify(replaced ?? envelope)];
  };
  const nested = (leaf: string): string => '['.repeat(NESTING_DEPTH) + leaf + ']'.repeat(NESTING_DEPTH);
  const nestedObject = (leaf: string): string => '{"a":'.repeat(NESTING_DEPTH) + leaf + '}'.repeat(NESTING_DEPTH);
  const pollute = '{"polluted":true}';
  const raw = (label: string, json: string): readonly [string, string] => [label, json];
  const intoDocument = (key: string, valueJson: string): string =>
    text.replace(/"document"\s*:\s*\{/, `"document":{"${key}":${valueJson},`);
  const intoFirstEntity = (key: string, valueJson: string): string => {
    const id = firstId(envelopeOf(text));
    const index = text.indexOf(`"${id}"`, text.indexOf('"entities"'));
    const brace = text.indexOf('{', index);
    return index < 0 || brace < 0 ? text : `${text.slice(0, brace + 1)}"${key}":${valueJson},${text.slice(brace + 1)}`;
  };
  return [
    raw('root __proto__', text.replace(/^\s*\{/, `{"__proto__":${pollute},`)),
    raw('document __proto__', intoDocument('__proto__', pollute)),
    raw('entities __proto__', text.replace(/"entities"\s*:\s*\{/, `"entities":{"__proto__":${pollute},`)),
    raw('entity __proto__', intoFirstEntity('__proto__', pollute)),
    raw('document constructor.prototype', intoDocument('constructor', `{"prototype":${pollute}}`)),
    raw('layers __proto__', text.replace(/"layers"\s*:\s*\{/, `"layers":{"__proto__":${pollute},`)),
    raw('parameters __proto__', intoDocument('parameters', `{"__proto__":${pollute}}`)),
    raw('NaN literal', text.replace(/(?<=[:[,]\s*)-?\d+(?:\.\d+)?/, 'NaN')),
    raw('Infinity literal', text.replace(/(?<=[:[,]\s*)-?\d+(?:\.\d+)?/, 'Infinity')),
    raw('deeply nested root', nested(text)),
    raw('deeply nested document field', intoDocument('extra', nested('1'))),
    raw('deeply nested object in an entity', intoFirstEntity('extra', nestedObject('1'))),
    raw('deeply nested parameters', intoDocument('parameters', nestedObject('1'))),
    edit('NaN as string sizes', (envelope) => {
      const entity = envelope.document.entities[firstId(envelope)];
      if (entity !== undefined) for (const key of ['size', 'radius', 'height', 'width', 'position']) if (key in entity) entity[key] = 'NaN';
    }),
    edit('negative sizes', (envelope) => {
      for (const entity of Object.values(envelope.document.entities)) {
        if (Array.isArray(entity['size'])) entity['size'] = (entity['size'] as number[]).map((value) => -Math.abs(value) - 1);
        for (const key of ['radius', 'height', 'width', 'depth', 'thickness']) if (typeof entity[key] === 'number') entity[key] = -5;
      }
    }),
    edit('null everywhere in an entity', (envelope) => {
      const entity = envelope.document.entities[firstId(envelope)];
      if (entity !== undefined) for (const key of Object.keys(entity)) if (key !== 'id') entity[key] = null;
    }),
    edit('entity kind unknown', (envelope) => {
      const entity = envelope.document.entities[firstId(envelope)];
      if (entity !== undefined) entity['kind'] = 'warp_drive';
    }),
    edit('entities as an array', (envelope) => void (envelope.document.entities = [] as unknown as Envelope['document']['entities'])),
    edit('entity id mismatch', (envelope) => {
      const entity = envelope.document.entities[firstId(envelope)];
      if (entity !== undefined) entity['id'] = 'someone-else';
    }),
    edit(
      'huge order array',
      (envelope) => void (envelope.document.order = Array.from({ length: 1_000_000 }, (_, index) => `ghost-${index}`)),
    ),
    edit('huge numeric array in an entity', (envelope) => {
      const entity = envelope.document.entities[firstId(envelope)];
      if (entity !== undefined) entity['points'] = Array.from({ length: 1_000_000 }, (_, index) => [index, index]);
    }),
    edit('huge feature history', (envelope) => {
      envelope.document['featureHistory'] = Array.from({ length: 100_000 }, (_, index) => ({
        id: `step-${index + 1}`,
        name: 'add_box',
        params: { size: [1, 1, 1] },
        affected: [],
      }));
    }),
    edit('huge entity count', (envelope) => {
      for (let index = 0; index < 50_000; index++) {
        const id = `box-${index}`;
        envelope.document.entities[id] = { id, kind: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'nope' };
        envelope.document.order.push(id);
      }
    }),
    edit('feature history step number overflow', (envelope) => {
      envelope.document['featureHistory'] = [{ id: 'step-99999999999999999999', name: 'add_box', params: {}, affected: [] }];
    }),
    edit('nextStepNumber hostile', (envelope) => void (envelope.document['nextStepNumber'] = -1e308)),
    edit('version far future', (envelope) => void (envelope.version = 1e308)),
    edit('document is a string', (envelope) => void ((envelope as unknown as Record<string, unknown>)['document'] = 'x'.repeat(1_000_000))),
    edit('huge string in an entity', (envelope) => {
      const entity = envelope.document.entities[firstId(envelope)];
      if (entity !== undefined) entity['name'] = 'x'.repeat(5_000_000);
    }),
  ];
}

describe.each(corpus)('damaged %s', (name, text) => {
  const seed = [...name].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);

  it('truncated at several offsets: never throws, never hangs', () => {
    for (const variant of truncations(text)) expectSafeLoad(variant);
  });

  it('random bit flips (seeded): never throws, never hangs', () => {
    for (const variant of bitFlips(text, seed, 40)) expectSafeLoad(variant);
  });

  it('hostile numbers (1e308, 1e309, negative, denormal): never throws, a loaded result saves and reloads', () => {
    for (const variant of hostileNumbers(text, seed, 30)) expectSafeLoad(variant);
  });

  // The huge-input variants (seconds each) run on one file per format version.
  const variants = structuralVariants(text, HUGE_INPUT_FILES.has(name)).filter(([, json]) => json !== '');
  it.each(variants)('%s: never throws, never hangs, no prototype pollution', (_label, variant) => {
    expectSafeLoad(variant);
  });
});
