import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument } from '@core/model/types';

const validation = resolve(import.meta.dirname, '../../../docs/aerospace/09-plm-configuration-traceability/validation');
const vectors = JSON.parse(readFileSync(resolve(validation, 'vectors/hash_vectors.json'), 'utf8')) as {
  fips_known_answer: { input_utf8: string; sha256: string }[];
  canonicalization_cases: { name: string; input: unknown; canonical: string }[];
  sample_document: Record<string, string | number>;
};
const sampleText = readFileSync(resolve(validation, 'sample_document.json'), 'utf8');

describe('sha256Hex (VC-PLM-16)', () => {
  it.each(vectors.fips_known_answer)('known answer for %j', ({ input_utf8: input, sha256 }) => {
    expect(sha256Hex(input)).toBe(sha256);
  });
  it('hashes multi-block input like node:crypto', async () => {
    const { createHash } = await import('node:crypto');
    const text = 'é'.repeat(200) + 'x'.repeat(63);
    expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });
});

describe('canonicalJson (RFC 8785 profile)', () => {
  it.each(vectors.canonicalization_cases)('$name', ({ input, canonical }) => {
    expect(canonicalJson(input)).toBe(canonical);
  });
  it('sorts integer-like keys by code units, not numerically', () => {
    expect(canonicalJson({ '10': 1, '9': 2, a: 3 })).toBe('{"10":1,"9":2,"a":3}');
  });
  it('omits undefined and functions, nulls array holes, writes -0 as 0 and honours toJSON', () => {
    expect(canonicalJson({ a: undefined, b: () => 1, c: -0, d: [undefined, 2], e: new Date(0), f: 5n })).toBe(
      '{"c":0,"d":[null,2],"e":"1970-01-01T00:00:00.000Z","f":"5"}',
    );
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(Number.NaN)).toBe('null');
  });
});

describe('document_content_hash (release scope)', () => {
  const load = (text: string): CadDocument => execute(createEmptyDocument(), 'load_document', { json: text }).document;
  const hashOf = (doc: CadDocument): string => (execute(doc, 'document_content_hash', {}).data as { sha256: string }).sha256;

  it('reproduces the published golden hash of the sample document', () => {
    const result = execute(load(sampleText), 'document_content_hash', { includeCanonical: true });
    const data = result.data as { sha256: string; bytes: number; canonicalJson: string };
    expect(data.sha256).toBe(vectors.sample_document['release_scope_canonical_sha256']);
    expect(data.bytes).toBe(vectors.sample_document['release_scope_canonical_length_bytes']);
    expect(sha256Hex(data.canonicalJson)).toBe(data.sha256);
    expect(result.affected).toEqual([]);
  });
  it('ignores camera, selection and the plm slice but not a parameter edit', () => {
    const doc = load(sampleText);
    const base = hashOf(doc);
    const moved = { ...doc, camera: { ...doc.camera, zoom: 3 }, selection: [...doc.order.slice(0, 1)] };
    expect(hashOf(moved)).toBe(base);
    expect(hashOf(execute(doc, 'set_parameter', { name: 't', expression: '5' }).document)).not.toBe(base);
    const envelope = JSON.parse(sampleText) as { document: { parameters: Record<string, unknown> } };
    envelope.document.parameters['t'] = { name: 't', expression: '5', value: 5 };
    expect(hashOf(load(JSON.stringify(envelope)))).toBe(vectors.sample_document['release_scope_after_parameter_t_edit_sha256']);
  });
});
