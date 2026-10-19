/** FeArtifactStore: content-addressed round trip, kind check, tamper / truncation detection, the server execution context. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { createFeArtifactStore, feaCacheDir } from '../src/fea/artifactStore';
import { serverContext } from '../src/fea/context';

const mesh: FeMeshArtifact = {
  kind: 'fe_mesh',
  unitSystem: 'N-mm-t-s',
  mesher: 'gmsh',
  mesherVersion: '4.15.2',
  inputHash: 'abc',
  nodes: [
    [1, 0, 0, 0],
    [2, 1, 0, 0],
    [3, 0, 1, 0],
    [4, 0, 0, 1],
  ],
  blocks: [{ type: 'C3D4', entityId: 'box-1', elements: [[1, 1, 2, 3, 4]] }],
  nodeSets: { C_a: [1, 2, 3] },
  faceSets: { C_a: [[1, 1]] },
  targets: { C_a: { residual: 0 } },
};
const results: FeResultsArtifact = {
  kind: 'fe_results',
  meshHash: 'm',
  inputHash: 'i',
  solver: 'calculix',
  solverVersion: '2.21',
  steps: [{ step: 1, time: 1, fields: { DISP: { components: ['D1', 'D2', 'D3'], values: { '1': [0, 0, 0] } } } }],
};

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-fea-store-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('FeArtifactStore', () => {
  it('stores under sha256(canonicalJson) and reads the same artifact back', () => {
    const store = createFeArtifactStore(dir);
    const hash = store.put(mesh);
    expect(hash).toBe(sha256Hex(canonicalJson(mesh)));
    expect(store.put(mesh)).toBe(hash);
    expect(store.get(hash)).toEqual(mesh);
    expect(store.get(store.put(results))?.kind).toBe('fe_results');
    expect(readdirSync(dir).filter((file) => file.endsWith('.json.gz'))).toHaveLength(2);
  });

  it('reads an unknown or malformed hash as absent', () => {
    const store = createFeArtifactStore(dir);
    expect(store.get('0'.repeat(64))).toBeNull();
    expect(store.get('../../etc/passwd')).toBeNull();
  });

  it('detects tampering: content that no longer hashes to its name is absent', () => {
    const store = createFeArtifactStore(dir);
    const hash = store.put(results);
    const forged = { ...results, solverVersion: '9.99' };
    writeFileSync(path.join(dir, `${hash}.json.gz`), gzipSync(JSON.stringify(forged)));
    expect(store.get(hash)).toBeNull();
  });

  it('rejects a truncated file and a file of another kind', () => {
    const store = createFeArtifactStore(dir);
    const hash = store.put(mesh);
    const file = path.join(dir, `${hash}.json.gz`);
    writeFileSync(file, readFileSync(file).subarray(0, 12));
    expect(store.get(hash)).toBeNull();
    const other = { kind: 'something_else' };
    const otherHash = sha256Hex(canonicalJson(other));
    writeFileSync(path.join(dir, `${otherHash}.json.gz`), gzipSync(JSON.stringify(other)));
    expect(store.get(otherHash)).toBeNull();
  });

  it('finds a derived artifact under an input-hash alias, still content-verified (RS1 RS-7)', () => {
    const store = createFeArtifactStore(dir);
    const hash = store.put({ ...results, solver: 'llull-compute post fatigue' });
    const key = sha256Hex('input of the job');
    expect(store.get(key)).toBeNull();
    store.alias(key, hash);
    expect(store.get(key)?.kind).toBe('fe_results');
    writeFileSync(path.join(dir, `${key}.ref`), 'not-a-hash');
    expect(store.get(key)).toBeNull();
    store.alias(key, sha256Hex('nothing stored here'));
    expect(store.get(key)).toBeNull();
    expect(() => store.alias('bad', hash)).toThrow(/sha256/);
  });
});

describe('feaCacheDir / serverContext', () => {
  it('honours LLULL_FEA_CACHE and defaults under ~/.llull/cache/fea', () => {
    expect(feaCacheDir({ LLULL_FEA_CACHE: dir })).toBe(path.resolve(dir));
    expect(feaCacheDir({})).toMatch(/\.llull[\\/]cache[\\/]fea$/);
  });

  it('carries the artifact port and no human signature', () => {
    const context = serverContext();
    expect(context.feaArtifacts).toBeDefined();
    expect(context.humanSignature).toBeNull();
    expect(context.registry).toBeTypeOf('function');
  });
});
