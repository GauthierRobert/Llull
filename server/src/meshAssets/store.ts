/**
 * The mesh asset store of this machine (07 MSH FR-MSH-02, TR-MSH-06): content-addressed, immutable, written atomically.
 *   `<dir>/meshes/<key>/{manifest.json, mesh.bin}`  key = sha256 of the canonical bytes of `mesh.bin`
 *   `<dir>/files/<sha256>`                          a source file as read (what `import_mesh_file fileKey` replays from)
 * `mesh.bin` = u32 vertex count, u32 triangle count, vertex positions as little-endian f64, triangle indices as little-endian u32; the vertex
 * order is the engine's canonical first-use order, so the same mesh always hashes to the same key.
 * Environment: LLULL_MESH_CACHE (directory, default ~/.llull/cache/mesh).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { MeshAssetManifest, MeshAssetPort } from '@core/geometry/mesh/assets';
import type { MeshData } from '@core/model/types';
import type { MeshSource } from '@core/model/meshProvenance';
import { z } from 'zod';

const KEY = /^[0-9a-f]{64}$/;
const HEADER_BYTES = 8;

export const isMeshAssetKey = (value: string): boolean => KEY.test(value);

export function meshCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_MESH_CACHE'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(homedir(), '.llull', 'cache', 'mesh');
}

const triple = z.tuple([z.number(), z.number(), z.number()]);
const manifestShape = z.object({
  key: z.string().regex(KEY),
  triangles: z.number().int().min(0),
  vertices: z.number().int().min(0),
  bounds: z.object({ min: triple, max: triple }),
  source: z
    .object({
      format: z.enum(['stl-ascii', 'stl-binary', 'obj', 'ply', '3mf', 'generated']),
      fileName: z.string().optional(),
      sourceSha256: z.string().regex(KEY).optional(),
      unitScale: z.number().positive(),
      verified: z.boolean(),
    })
    .optional(),
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Canonical bytes of `mesh` (see the file header). */
export function canonicalMeshBytes(mesh: MeshData): Buffer {
  const vertices = mesh.positions.length / 3;
  const triangles = mesh.indices.length / 3;
  const bytes = Buffer.allocUnsafe(HEADER_BYTES + mesh.positions.length * 8 + mesh.indices.length * 4);
  bytes.writeUInt32LE(vertices, 0);
  bytes.writeUInt32LE(triangles, 4);
  let at = HEADER_BYTES;
  for (const value of mesh.positions) {
    bytes.writeDoubleLE(value, at);
    at += 8;
  }
  for (const value of mesh.indices) {
    bytes.writeUInt32LE(value, at);
    at += 4;
  }
  return bytes;
}

/** Inverse of `canonicalMeshBytes`; null when the bytes are not a whole canonical mesh. */
export function meshFromCanonicalBytes(bytes: Uint8Array): MeshData | null {
  if (bytes.length < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertices = view.getUint32(0, true);
  const triangles = view.getUint32(4, true);
  if (bytes.length !== HEADER_BYTES + vertices * 24 + triangles * 12) return null;
  const positions = new Array<number>(vertices * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = view.getFloat64(HEADER_BYTES + i * 8, true);
  const base = HEADER_BYTES + vertices * 24;
  const indices = new Array<number>(triangles * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = view.getUint32(base + i * 4, true);
  return { positions, indices };
}

function boundsOf(mesh: MeshData): MeshAssetManifest['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const value = mesh.positions[i + a] as number;
      if (value < (min[a] as number)) min[a] = value;
      if (value > (max[a] as number)) max[a] = value;
    }
  }
  return mesh.positions.length === 0 ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max };
}

/** Write `bytes` to `target` through a temporary file, so a crash never leaves a partial asset. */
function writeOnce(target: string, bytes: Uint8Array): void {
  if (existsSync(target)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (!existsSync(target)) throw error;
  }
}

export interface MeshAssetStore extends MeshAssetPort {
  readonly dir: string;
  /** Store a source file by its sha256; returns the key. */
  putFile(bytes: Uint8Array): string;
  /** Store a mesh with the provenance of the importer; returns its manifest. */
  putMesh(mesh: MeshData, source?: MeshSource): MeshAssetManifest;
  /** Keys of the stored meshes (sorted). */
  list(): string[];
}

/** The store at `dir`; the most recently read mesh stays in memory (a command chain re-reads the same asset). */
export function createMeshAssetStore(dir: string = meshCacheDir()): MeshAssetStore {
  const meshDir = (key: string): string => path.join(dir, 'meshes', key);
  let cached: { key: string; mesh: MeshData } | null = null;

  const manifest = (key: string): MeshAssetManifest | null => {
    if (!isMeshAssetKey(key)) return null;
    try {
      const parsed = manifestShape.safeParse(JSON.parse(readFileSync(path.join(meshDir(key), 'manifest.json'), 'utf8')));
      if (!parsed.success || parsed.data.key !== key) return null;
      const { source, ...rest } = parsed.data;
      if (source === undefined) return rest;
      const { fileName, sourceSha256, ...others } = source;
      // A manifest is a file anyone can edit: "verified" holds only while the pinned source file is in this store.
      const pinned = sourceSha256 !== undefined && existsSync(path.join(dir, 'files', sourceSha256));
      return {
        ...rest,
        source: {
          ...others,
          ...(fileName !== undefined ? { fileName } : {}),
          ...(sourceSha256 !== undefined ? { sourceSha256 } : {}),
          verified: others.verified && pinned,
        },
      };
    } catch {
      return null;
    }
  };

  const putMesh = (mesh: MeshData, source?: MeshSource): MeshAssetManifest => {
    const bytes = canonicalMeshBytes(mesh);
    const key = sha256(bytes);
    const existing = manifest(key);
    if (existing !== null && existsSync(path.join(meshDir(key), 'mesh.bin'))) {
      cached = { key, mesh };
      return existing;
    }
    const record: MeshAssetManifest = {
      key,
      triangles: mesh.indices.length / 3,
      vertices: mesh.positions.length / 3,
      bounds: boundsOf(mesh),
      ...(source !== undefined ? { source } : {}),
    };
    writeOnce(path.join(meshDir(key), 'mesh.bin'), bytes);
    writeOnce(path.join(meshDir(key), 'manifest.json'), Buffer.from(JSON.stringify(record, null, 1)));
    cached = { key, mesh };
    return record;
  };

  return {
    dir,
    manifest,
    readMesh(key) {
      if (cached?.key === key) return cached.mesh;
      if (manifest(key) === null) return null;
      try {
        const bytes = readFileSync(path.join(meshDir(key), 'mesh.bin'));
        if (sha256(bytes) !== key) return null; // damaged or replaced file: the key is the content hash
        const mesh = meshFromCanonicalBytes(bytes);
        if (mesh !== null) cached = { key, mesh };
        return mesh;
      } catch {
        return null;
      }
    },
    writeMesh(mesh) {
      const manifestOfMesh = putMesh(mesh);
      return {
        key: manifestOfMesh.key,
        triangles: manifestOfMesh.triangles,
        vertices: manifestOfMesh.vertices,
        bounds: manifestOfMesh.bounds,
      };
    },
    putMesh,
    putFile(bytes) {
      const key = sha256(bytes);
      writeOnce(path.join(dir, 'files', key), bytes);
      return key;
    },
    readFile(key) {
      if (!isMeshAssetKey(key)) return null;
      try {
        return readFileSync(path.join(dir, 'files', key));
      } catch {
        return null;
      }
    },
    list() {
      try {
        return readdirSync(path.join(dir, 'meshes')).sort().filter(isMeshAssetKey);
      } catch {
        return [];
      }
    },
  };
}

let shared: MeshAssetStore | null = null;

/** The process-wide store at the configured directory. */
export function defaultMeshAssetStore(): MeshAssetStore {
  shared ??= createMeshAssetStore();
  return shared;
}
