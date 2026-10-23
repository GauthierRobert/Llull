/**
 * The mesh host tools of the `llull` CLI (07 MSH TR-MSH-06): `mesh_import` (mesh file -> welded canonical mesh in this machine's content-addressed
 * asset store, never the document; attach it with `attach_mesh_asset`) and `mesh_assets` (the stored meshes). CLI shorthand:
 * `llull mesh import FILE --units mm`, `llull mesh list`. Run in-process for a local --doc and through `POST /exchange` for --app / --server.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importUnitScale, scaleAndWeld } from '@core/commands/mesh/importPipeline';
import { fastMeasure } from '@core/geometry/mesh/fastMeasure';
import { parseMeshFile } from '@lib/meshFormats';
import { isParseFailure } from '@lib/meshFormats/types';
import { DOCUMENT_UNITS, type DocumentUnit } from '@core/model/types';
import { MAX_IMPORT_BODIES, MAX_IMPORT_BYTES, MAX_IMPORT_TRIANGLES } from '@core/commands/limits';
import type { CommandOutcome } from '@protocol/restProtocol';
import { isRecord } from '@lib/isRecord';
import { sha256Hex } from '../sha256';
import { defaultMeshAssetStore, type MeshAssetStore } from './store';

const NAMES: ReadonlySet<string> = new Set(['mesh_import', 'mesh_assets']);

export const isMeshHostTool = (name: string): boolean => NAMES.has(name);

const failure = (code: string, message: string): CommandOutcome => ({
  summary: `mesh_import: ${code} — ${message}`,
  affected: [],
  isError: true,
  changed: false,
  data: { code },
});

const isUnit = (value: unknown): value is DocumentUnit =>
  typeof value === 'string' && (DOCUMENT_UNITS as readonly string[]).includes(value);

/** Welded CANONICAL mesh of every body of a mesh file, stored as assets of `store`. */
function importFile(args: Record<string, unknown>, documentUnits: DocumentUnit, store: MeshAssetStore): CommandOutcome {
  const file = args['path'];
  if (typeof file !== 'string' || file === '') return failure('MESH_PARAM_INVALID', 'path is required');
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return failure('MESH_IMPORT_PARSE', `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sha256 = sha256Hex(bytes);
  const pinned = typeof args['sourceSha256'] === 'string' ? args['sourceSha256'] : undefined;
  if (pinned !== undefined && pinned.toLowerCase() !== sha256)
    return failure('MESH_IMPORT_SHA_MISMATCH', `the file sha256 is ${sha256}, not the pinned ${pinned}`);
  const format = args['format'];
  const parsed = parseMeshFile(bytes, format === 'stl' || format === 'obj' || format === 'ply' || format === '3mf' ? format : undefined, {
    maxBodies: MAX_IMPORT_BODIES,
    maxTriangles: MAX_IMPORT_TRIANGLES,
    maxBytes: MAX_IMPORT_BYTES,
  });
  if (isParseFailure(parsed)) return failure(parsed.code, parsed.message);
  const units = args['units'];
  if (parsed.unitMetres === undefined && !isUnit(units))
    return failure('MESH_IMPORT_UNITS_REQUIRED', `${parsed.format} files carry no unit: give units`);
  const unitScale = importUnitScale(parsed.unitMetres, isUnit(units) ? units : undefined, documentUnits) ?? 1;
  const weldTolerance = typeof args['weldTolerance'] === 'number' && args['weldTolerance'] > 0 ? args['weldTolerance'] : undefined;
  const bodies = parsed.bodies.filter((body) => body.triangles.length > 0);
  if (bodies.length === 0) return failure('MESH_IMPORT_EMPTY', 'the file holds no triangles');
  const stored = bodies.map((body, index) => {
    const { mesh, tolerance, mergedVertices } = scaleAndWeld(body.positions, body.triangles, unitScale, weldTolerance);
    const manifest = store.putMesh(mesh, {
      format: parsed.format,
      fileName: path.basename(file),
      sourceSha256: sha256,
      unitScale,
      verified: pinned !== undefined,
    });
    const measure = fastMeasure(mesh);
    return {
      body: index,
      name: body.name ?? null,
      assetKey: manifest.key,
      triangles: manifest.triangles,
      vertices: manifest.vertices,
      bounds: manifest.bounds,
      mergedVertices,
      weldTolerance: tolerance,
      closed: measure.closed,
      openEdges: measure.boundaryEdges,
      nonManifoldEdges: measure.nonManifoldEdges,
      area: measure.area,
      volume: measure.volume,
    };
  });
  store.putFile(bytes); // the source stays with its assets: a pinned (verified) manifest needs it, and import_mesh_file fileKey replays from it
  const first = stored[0];
  return {
    summary:
      `mesh_import: ${path.basename(file)} (${parsed.format}) -> ${stored.length} asset(s)` +
      `${first !== undefined ? ` ${first.assetKey} (${first.triangles} triangles, ${first.vertices} vertices)` : ''}, unit scale ${unitScale} (to ${documentUnits}), ` +
      `${pinned !== undefined ? 'verified against the pinned sha256' : 'unverified (no pinned sha256)'}. Attach it: attach_mesh_asset assetKey=<key>`,
    affected: [],
    isError: false,
    changed: false,
    data: {
      sourceSha256: sha256,
      format: parsed.format,
      unitScale,
      documentUnits,
      unverified: pinned === undefined,
      bodies: stored,
      store: store.dir,
    },
  };
}

/** Runs a mesh host tool; null for any other name. `documentUnits` are the units of the document the tool runs against. */
export function runMeshHostTool(
  name: string,
  params: unknown,
  documentUnits: DocumentUnit,
  store: MeshAssetStore = defaultMeshAssetStore(),
): CommandOutcome | null {
  if (!isMeshHostTool(name)) return null;
  if (name === 'mesh_assets') {
    const assets = store
      .list()
      .map((key) => store.manifest(key))
      .filter((m) => m !== null);
    return {
      summary: `mesh_assets: ${assets.length} mesh asset(s) in ${store.dir}.`,
      affected: [],
      isError: false,
      changed: false,
      data: { store: store.dir, assets },
    };
  }
  return importFile(isRecord(params) ? params : {}, documentUnits, store);
}
