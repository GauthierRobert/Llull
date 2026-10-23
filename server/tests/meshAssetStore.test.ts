/**
 * 07 MSH M3 host side: the content-addressed mesh asset store (canonical bytes, idempotent writes, damage reads as missing), the
 * `mesh_import` / `mesh_assets` host tools, and the whole path through the CLI: `llull mesh import` -> `attach_mesh_asset` -> a command
 * that reads the full-resolution asset and writes a new one (VC-MSH-31).
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { installGeometryKernel } from '../src/geometryKernel';
import { runMeshHostTool } from '../src/meshAssets/meshTools';
import { canonicalMeshBytes, createMeshAssetStore, isMeshAssetKey, meshCacheDir, meshFromCanonicalBytes } from '../src/meshAssets/store';

const dir = mkdtempSync(path.join(tmpdir(), 'llull-mesh-store-'));
process.env['LLULL_MESH_CACHE'] = path.join(dir, 'cache');

const DATA = path.join(import.meta.dirname, '..', '..', 'docs', 'design', '07-mesh-modeling', 'validation', 'data');
const STL = path.join(DATA, 'icosphere_r10_l1_binary.stl');
const STL_SHA = '0d60c7d8b80d575d5fa3bc3b49cafbfe077d854496ebf513d6de063d102154fd';

const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };

afterAll(() => {
  setGeometryKernel(null);
  setMeshProcessingEngine(null);
});

describe('canonical bytes', () => {
  it('round-trips a mesh and refuses damaged bytes', () => {
    const bytes = canonicalMeshBytes(triangle);
    expect(bytes.length).toBe(8 + 9 * 8 + 3 * 4);
    expect(meshFromCanonicalBytes(bytes)).toEqual(triangle);
    expect(meshFromCanonicalBytes(bytes.subarray(0, bytes.length - 1))).toBeNull();
    expect(meshFromCanonicalBytes(new Uint8Array(3))).toBeNull();
  });
});

describe('the store', () => {
  const store = createMeshAssetStore(path.join(dir, 'store'));

  it('keys a mesh by the sha256 of its canonical bytes and writes it once', () => {
    const ref = store.writeMesh(triangle);
    expect(ref.key).toBe(createHash('sha256').update(canonicalMeshBytes(triangle)).digest('hex'));
    expect(ref).toEqual({ key: ref.key, triangles: 1, vertices: 3, bounds: { min: [0, 0, 0], max: [1, 1, 0] } });
    expect(store.writeMesh(triangle)).toEqual(ref);
    expect(store.list()).toEqual([ref.key]);
    expect(store.readMesh(ref.key)).toEqual(triangle);
    expect(createMeshAssetStore(path.join(dir, 'store')).readMesh(ref.key)).toEqual(triangle);
  });

  it('keeps the importer provenance in the manifest and the first one wins', () => {
    const other = { positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] };
    const source = {
      format: 'obj',
      fileName: 'tri.obj',
      sourceSha256: store.putFile(Buffer.from('v 0 0 0')),
      unitScale: 1,
      verified: true,
    } as const;
    const manifest = store.putMesh(other, source);
    expect(manifest.source).toEqual(source);
    expect(store.manifest(manifest.key)?.source).toEqual(source);
    expect(store.putMesh(other).source).toEqual(source);
    expect(store.writeMesh(other)).not.toHaveProperty('source');
  });

  it('reads damage, missing and malformed keys as null, and stores files by sha256', () => {
    expect(store.manifest('x')).toBeNull();
    expect(store.readMesh('c'.repeat(64))).toBeNull();
    expect(store.readFile('not a key')).toBeNull();
    expect(store.readFile('d'.repeat(64))).toBeNull();
    const key = store.putFile(Buffer.from('solid x'));
    expect(key).toBe(createHash('sha256').update('solid x').digest('hex'));
    expect(store.putFile(Buffer.from('solid x'))).toBe(key);
    expect(Buffer.from(store.readFile(key) ?? []).toString()).toBe('solid x');
    const ref = store.writeMesh({ positions: [0, 0, 0, 3, 0, 0, 0, 3, 0], indices: [0, 1, 2] });
    writeFileSync(path.join(dir, 'store', 'meshes', ref.key, 'mesh.bin'), 'damaged');
    expect(createMeshAssetStore(path.join(dir, 'store')).readMesh(ref.key)).toBeNull();
    expect(isMeshAssetKey(ref.key)).toBe(true);
    expect(isMeshAssetKey('ABC')).toBe(false);
    expect(createMeshAssetStore(path.join(dir, 'empty')).list()).toEqual([]);
  });

  it('defaults to the LLULL_MESH_CACHE directory', () => {
    expect(meshCacheDir({ LLULL_MESH_CACHE: path.join(dir, 'x') })).toBe(path.join(dir, 'x'));
    expect(meshCacheDir({})).toContain(path.join('.llull', 'cache', 'mesh'));
  });
});

describe('mesh_import and mesh_assets', () => {
  const store = createMeshAssetStore(path.join(dir, 'tools'));

  it('imports a file once: unit conversion, weld, canonical asset, provenance and counts', () => {
    const result = runMeshHostTool('mesh_import', { path: STL, units: 'in', sourceSha256: STL_SHA }, 'mm', store);
    expect(result?.isError).toBe(false);
    const data = result?.data as { sourceSha256: string; unitScale: number; unverified: boolean; bodies: Array<Record<string, unknown>> };
    expect(data.sourceSha256).toBe(STL_SHA);
    expect(data.unitScale).toBe(25.4);
    expect(data.unverified).toBe(false);
    const body = data.bodies[0] as { assetKey: string; triangles: number; vertices: number; closed: boolean; volume: number };
    expect([body.triangles, body.vertices, body.closed]).toEqual([80, 42, true]);
    expect(body.volume / 3658.71216465).toBeCloseTo(25.4 ** 3, 4);
    expect(store.manifest(body.assetKey)?.source).toMatchObject({
      format: 'stl-binary',
      fileName: 'icosphere_r10_l1_binary.stl',
      verified: true,
    });
    const again = runMeshHostTool('mesh_import', { path: STL, units: 'in', sourceSha256: STL_SHA }, 'mm', store);
    expect((again?.data as { bodies: Array<{ assetKey: string }> }).bodies[0]?.assetKey).toBe(body.assetKey);
    const listed = runMeshHostTool('mesh_assets', {}, 'mm', store);
    expect((listed?.data as { assets: unknown[] }).assets).toHaveLength(1);
    expect(listed?.summary).toContain('1 mesh asset');
  });

  it('refuses the way import_mesh_file does: units, pin, parse, empty, unreadable, missing path', () => {
    const code = (params: unknown): unknown => (runMeshHostTool('mesh_import', params, 'mm', store)?.data as { code: string }).code;
    expect(code({ path: STL })).toBe('MESH_IMPORT_UNITS_REQUIRED');
    expect(code({ path: STL, units: 'mm', sourceSha256: 'f'.repeat(64) })).toBe('MESH_IMPORT_SHA_MISMATCH');
    expect(code({ path: path.join(dir, 'missing.stl'), units: 'mm' })).toBe('MESH_IMPORT_PARSE');
    expect(code({ units: 'mm' })).toBe('MESH_PARAM_INVALID');
    const junk = path.join(dir, 'junk.bin');
    writeFileSync(junk, 'not a mesh at all');
    expect(code({ path: junk, units: 'mm' })).toMatch(/MESH_IMPORT_/);
    const obj = path.join(dir, 'empty.obj');
    writeFileSync(obj, 'o nothing\nv 0 0 0\n');
    expect(code({ path: obj, units: 'mm' })).toMatch(/MESH_IMPORT_(EMPTY|PARSE)/);
    expect(runMeshHostTool('add_box', {}, 'mm', store)).toBeNull();
  });

  it('imports several bodies with a custom weld tolerance and a 3MF-style unit-less OBJ', () => {
    const obj = path.join(dir, 'two.obj');
    writeFileSync(obj, 'o a\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\no b\nv 5 0 0\nv 6 0 0\nv 5 1 0\nf 4 5 6\n');
    const result = runMeshHostTool('mesh_import', { path: obj, units: 'mm', weldTolerance: 1e-3, format: 'obj' }, 'mm', store);
    expect((result?.data as { bodies: unknown[] }).bodies.length).toBeGreaterThanOrEqual(1);
    expect(result?.data).toMatchObject({ format: 'obj', unverified: true });
  });
});

describe('end to end through the CLI', () => {
  function capture(): { io: CliIo; out: string[] } {
    const out: string[] = [];
    return {
      out,
      io: {
        stdout: (text) => out.push(text),
        stderr: () => undefined,
        readStdin: () => Promise.resolve(''),
        env: {},
        prepareKernel: async () => {
          await installGeometryKernel({ env: { LLULL_KERNEL: 'manifold' } });
        },
      },
    };
  }
  async function run(args: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
    const { io, out } = capture();
    const code = await runCli([...args, '--json'], io);
    const text = out.join('');
    return { code, json: text.trim().startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  it('llull mesh import -> attach_mesh_asset -> cut_mesh -> mesh list', async () => {
    const doc = path.join(dir, 'e2e.llull');
    const imported = await run(['mesh', 'import', STL, 'units=mm']);
    expect(imported.code).toBe(EXIT_OK);
    const key = ((imported.json['data'] as { bodies: Array<{ assetKey: string }> }).bodies[0] as { assetKey: string }).assetKey;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const attached = await run(['attach_mesh_asset', `assetKey=${key}`, '--doc', doc]);
    expect(attached.code).toBe(EXIT_OK);
    const saved = readFileSync(doc, 'utf8');
    expect(saved).toContain('"kind":"mesh"');
    const id = (attached.json['data'] as { id: string }).id;
    const cut = await run(['cut_mesh', `id=${id}`, 'plane={"origin":[0,0,0],"normal":[0,0,1]}', 'keep=both', '--doc', doc]);
    expect(cut.code).toBe(EXIT_OK);
    const volumes = (cut.json['data'] as { volumes: { positive: number; negative: number } }).volumes;
    expect(volumes.positive + volumes.negative).toBeCloseTo(3658.71216465, 5);
    const listed = await run(['mesh', 'list']);
    expect(listed.code).toBe(EXIT_OK);
    expect((listed.json['data'] as { assets: unknown[] }).assets.length).toBeGreaterThanOrEqual(1);
  });

  it('mesh needs a verb', async () => {
    const { io } = capture();
    await expect(runCli(['mesh', 'frobnicate'], io)).resolves.not.toBe(EXIT_OK);
  });
});

describe('the store distrusts files on disk', () => {
  const root = path.join(dir, 'distrust');
  const other = { positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] };

  it('reads a mesh only when its bytes hash to the key', () => {
    const store = createMeshAssetStore(root);
    const key = store.writeMesh(triangle).key;
    const fresh = createMeshAssetStore(root); // no in-memory entry
    expect(fresh.readMesh(key)).toEqual(triangle);
    writeFileSync(path.join(root, 'meshes', key, 'mesh.bin'), canonicalMeshBytes(other));
    expect(createMeshAssetStore(root).readMesh(key)).toBeNull();
  });

  it('refuses a manifest of the wrong shape and a "verified" claim without the pinned source file', () => {
    const store = createMeshAssetStore(root);
    const key = store.putMesh(other, { format: 'stl-ascii', unitScale: 1, verified: true, sourceSha256: 'b'.repeat(64) }).key;
    expect(createMeshAssetStore(root).manifest(key)?.source?.verified).toBe(false);
    const bytes = Buffer.from('solid');
    const sourceKey = store.putFile(bytes);
    const third = { positions: [0, 0, 0, 3, 0, 0, 0, 3, 0], indices: [0, 1, 2] };
    const pinned = store.putMesh(third, { format: 'stl-ascii', unitScale: 1, verified: true, sourceSha256: sourceKey });
    expect(createMeshAssetStore(root).manifest(pinned.key)?.source?.verified).toBe(true);
    writeFileSync(path.join(root, 'meshes', key, 'manifest.json'), JSON.stringify({ key, triangles: 'many' }));
    expect(createMeshAssetStore(root).manifest(key)).toBeNull();
  });
});
