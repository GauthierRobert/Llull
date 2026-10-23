/** import_mesh_file — STL (ascii + binary), OBJ, PLY and 3MF bytes become welded, indexed mesh entities with provenance (07 MSH M0, FR-MSH-01). */

import { DOCUMENT_UNITS, type BaseEntity, type Entity, type MeshSolidEntity } from '../../model/types';
import type { FaceGroup } from '../../model/meshProvenance';
import { analyzeIndexedMesh } from '../../geometry/mesh/analysis';
import { MESH_INLINE_TRIANGLE_CAP } from '../../geometry/mesh/assets';
import { fastMeasure } from '../../geometry/mesh/fastMeasure';
import { base64ToUint8Array } from '../../lib/base64';
import { isHexColor } from '../../lib/isHexColor';
import { nextId } from '../../lib/id';
import { parseMeshFile } from '../../lib/meshFormats';
import { isParseFailure } from '../../lib/meshFormats/types';
import { sha256Hex } from '../../lib/sha256';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { DEFAULT_MESH_COLOR } from '../exchange/importMesh';
import { MAX_IMPORT_BODIES, MAX_IMPORT_BYTES, MAX_IMPORT_TRIANGLES } from '../limits';
import { newEntity } from '../entity/newEntity';
import type { CommandResult } from '../types';
import { importUnitScale, scaleAndWeld } from './importPipeline';
import { contextOf, isStoreFailure, meshRejection, namedDefault, storeMesh, withConventions } from './meshCommon';

/**
 * @affects creates 1 mesh entity per body (STL solid blocks, OBJ file, PLY file, 3MF build items), welded and indexed, in body order
 * @invariant units are never guessed: STL / OBJ / PLY need `units`, 3MF states its own; the scale factor is reported once in data.unitScale
 * @invariant bodies are `unverified` unless `sourceSha256` was given and matches the file bytes
 * @failure bad content / unknown format / missing units / empty / sha mismatch / over limits -> no-op with a MESH_IMPORT_* code
 */
export const importMeshFile = defineCommand({
  name: 'import_mesh_file',
  description:
    'Import a triangle mesh file as mesh entities: STL (ascii or binary), OBJ (polygons are fan-triangulated; groups become faceGroups), PLY ' +
    '(ascii / binary) or 3MF (units from the file). Vertices closer than weldTolerance are welded and the report lists triangles, welded ' +
    'vertices, dropped attributes, open and non-manifold edges and shells. STL, OBJ and PLY carry no unit, so `units` is REQUIRED for them ' +
    '(coordinates are converted once into the document unit). Give the file as `fileKey` (the sha256 of a file kept in the mesh asset ' +
    'store of this machine; the CLI stores `file=PATH` there so the document keeps 64 hex characters, not the file), `base64` or `text` (stored in the document ' +
    `step: small files only). A result over ${MESH_INLINE_TRIANGLE_CAP} triangles is kept in the asset store with a display LOD. The result is ` +
    '`unverified` unless you pass the file sha256 as `sourceSha256` and it matches. Next: analyze_mesh, then check_mesh. Refusals carry ' +
    'error.code MESH_IMPORT_UNITS_REQUIRED, MESH_IMPORT_FORMAT_UNKNOWN, MESH_IMPORT_PARSE, MESH_IMPORT_EMPTY, MESH_IMPORT_SHA_MISMATCH, ' +
    'MESH_IMPORT_TOO_LARGE, MESH_ASSET_MISSING, MESH_ASSET_UNAVAILABLE.',
  params: z.object({
    fileKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe(
        'sha256 (64 hex) of a file kept in the mesh asset store (the CLI stores `file=PATH` and fills this). Give exactly one of fileKey, base64 or text.',
      ),
    base64: z
      .string()
      .optional()
      .describe(
        'The file bytes, base64 encoded (STL, OBJ, PLY or 3MF); recorded in the document step. Give exactly one of fileKey, base64 or text.',
      ),
    text: z.string().optional().describe('The file as text (ascii STL, OBJ, ascii PLY). Give exactly one of fileKey, base64 or text.'),
    format: z.enum(['stl', 'obj', 'ply', '3mf']).optional().describe('File format; default: sniffed from the content.'),
    units: z
      .enum(DOCUMENT_UNITS)
      .optional()
      .describe('Unit of the file coordinates (mm, cm, m, in, ft). Required for STL, OBJ and PLY; for 3MF it overrides the file unit.'),
    weldTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Vertices closer than this (document units) are merged. Default: 1e-6 x the bounding-box diagonal (reported as a named default).',
      ),
    name: z.string().optional().describe('Entity name; several bodies get a numeric suffix. Default: the name in the file, else none.'),
    color: z.string().optional().describe('Display colour "#rrggbb". Default: light grey.'),
    fileName: z.string().optional().describe('Original file name, kept in the entity provenance only.'),
    sourceSha256: z
      .string()
      .optional()
      .describe(
        'sha256 (hex) you expect the file bytes to have. A match marks the mesh verified; a mismatch refuses the import (MESH_IMPORT_SHA_MISMATCH).',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const reject = (code: string, message: string, paths: string[] = []): CommandResult =>
      meshRejection(doc, 'import_mesh_file', code, message, [], paths);
    if ([params.fileKey, params.base64, params.text].filter((v) => v !== undefined).length !== 1) {
      return reject('MESH_PARAM_INVALID', 'give exactly one of fileKey, base64 or text', ['fileKey', 'base64', 'text']);
    }
    const assets = contextOf(ctx).meshAssets;
    let bytes: Uint8Array | null;
    if (params.fileKey !== undefined) {
      if (assets === undefined || assets === null)
        return reject('MESH_ASSET_UNAVAILABLE', 'no mesh asset store is installed here, so fileKey cannot be read', ['fileKey']);
      bytes = assets.readFile(params.fileKey);
      if (bytes === null)
        return reject(
          'MESH_ASSET_MISSING',
          `file ${params.fileKey} is not in the mesh asset store of the process running this command. With --app / --server the llull CLI wrote the file to ITS store and the backend reads its own: both must use the same directory (LLULL_MESH_CACHE, default ~/.llull/cache/mesh).`,
          ['fileKey'],
        );
    } else bytes = params.base64 !== undefined ? base64ToUint8Array(params.base64) : new TextEncoder().encode(params.text);
    if (bytes === null) return reject('MESH_PARAM_INVALID', 'base64 is not valid base64', ['base64']);
    const sha256 = sha256Hex(bytes);
    if (params.sourceSha256 !== undefined && params.sourceSha256.toLowerCase() !== sha256) {
      return reject('MESH_IMPORT_SHA_MISMATCH', `the file sha256 is ${sha256}, not the pinned ${params.sourceSha256}`, ['sourceSha256']);
    }
    const parsed = parseMeshFile(bytes, params.format, {
      maxBodies: MAX_IMPORT_BODIES,
      maxTriangles: MAX_IMPORT_TRIANGLES,
      maxBytes: MAX_IMPORT_BYTES,
    });
    if (isParseFailure(parsed)) return reject(parsed.code, parsed.message);
    if (parsed.unitMetres === undefined && params.units === undefined) {
      return reject('MESH_IMPORT_UNITS_REQUIRED', `${parsed.format} files carry no unit: give units`, ['units']);
    }
    const unitScale = importUnitScale(parsed.unitMetres, params.units, doc.units) ?? 1;
    const bodies = parsed.bodies.filter((body) => body.triangles.length > 0);
    if (bodies.length > MAX_IMPORT_BODIES) return reject('MESH_IMPORT_TOO_LARGE', `${bodies.length} bodies exceed ${MAX_IMPORT_BODIES}`);
    const total = bodies.reduce((sum, body) => sum + body.triangles.length / 3, 0);
    if (total > MAX_IMPORT_TRIANGLES) return reject('MESH_IMPORT_TOO_LARGE', `${total} triangles exceed ${MAX_IMPORT_TRIANGLES}`);
    const verified = params.sourceSha256 !== undefined;
    const entities: Record<string, Entity> = { ...doc.entities };
    const order = [...doc.order];
    const affected: string[] = [];
    const report: Array<Record<string, unknown>> = [];
    const format = parsed.format;
    let weldDefaulted = false;
    for (const [index, body] of bodies.entries()) {
      const body_ = scaleAndWeld(body.positions, body.triangles, unitScale, params.weldTolerance);
      const { mesh: weldedMesh, tolerance } = body_;
      weldDefaulted ||= body_.defaulted;
      const welded = { positions: weldedMesh.positions, triangles: weldedMesh.indices, mergedVertices: body_.mergedVertices };
      const big = welded.triangles.length / 3 > MESH_INLINE_TRIANGLE_CAP;
      const analysis = big
        ? (() => {
            const fast = fastMeasure(weldedMesh);
            return {
              faces: fast.faces,
              vertices: fast.vertices,
              boundaryEdges: fast.boundaryEdges,
              nonManifoldEdgeCount: fast.nonManifoldEdges,
              shellCount: null,
              closed: fast.closed,
              volume: fast.volume,
              area: fast.area,
            };
          })()
        : analyzeIndexedMesh(welded.positions, welded.triangles, { selfIntersections: false, maxListed: 0 });
      const stored = storeMesh(weldedMesh, assets);
      if (isStoreFailure(stored)) return reject(stored.code, stored.message);
      const id = nextId('mesh');
      const label = params.name ?? body.name;
      const name = label === undefined ? undefined : bodies.length > 1 ? `${label} ${index + 1}` : label;
      const faceGroups: FaceGroup[] = body.groups.map((group) => ({ id: group.name, faces: [[group.start, group.end] as const] }));
      const geometry: Omit<MeshSolidEntity, keyof BaseEntity> = {
        mesh: stored.mesh,
        ...(stored.asset !== undefined ? { asset: stored.asset } : {}),
        meshSource: {
          format,
          ...(params.fileName !== undefined ? { fileName: params.fileName } : {}),
          sourceSha256: sha256,
          unitScale,
          verified,
        },
        ...(faceGroups.length > 0 ? { faceGroups } : {}),
      };
      entities[id] = newEntity('mesh', id, geometry, [0, 0, 0], isHexColor(params.color) ? params.color : DEFAULT_MESH_COLOR, { name });
      order.push(id);
      affected.push(id);
      report.push({
        id,
        triangles: analysis.faces,
        weldedVertices: analysis.vertices,
        mergedVertices: welded.mergedVertices,
        openEdges: analysis.boundaryEdges,
        nonManifoldEdges: analysis.nonManifoldEdgeCount,
        shells: analysis.shellCount,
        closed: analysis.closed,
        volume: analysis.volume,
        area: analysis.area,
        weldTolerance: tolerance,
        faceGroups: faceGroups.length,
      });
    }
    const first = report[0] ?? {};
    const data = withConventions(
      doc,
      {
        format,
        bodies: report,
        triangles: total,
        weldedVertices: first['weldedVertices'],
        openEdges: first['openEdges'],
        nonManifoldEdges: first['nonManifoldEdges'],
        shells: first['shells'],
        volume: first['volume'],
        area: first['area'],
        droppedAttributes: parsed.dropped,
        unitScale,
        sha256,
      },
      {
        unverified: !verified,
        ...(weldDefaulted
          ? {
              defaults: [
                namedDefault('weldTolerance', Number(first['weldTolerance'] ?? 0), doc.units, 'llull default 1e-6 x bbox diagonal'),
              ],
            }
          : {}),
      },
    );
    const result = changed(
      { ...doc, entities, order },
      `import_mesh_file: ${format} -> ${affected.length} mesh${affected.length === 1 ? '' : 'es'} (${affected.join(', ')}), ${total} triangles, unit scale ${unitScale} (${params.units ?? 'file unit'} -> ${doc.units})` +
        `${verified ? ', verified against the pinned sha256' : ', unverified (no pinned sha256)'}.`,
      affected,
    );
    return { ...result, data };
  },
});
