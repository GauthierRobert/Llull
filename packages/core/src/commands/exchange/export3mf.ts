/** export_3mf: read-only export of the 3D bodies as a 3MF package (document returned unchanged, output in `data`). */

import type { CommandResult } from '../types';
import { currentContext } from '../context';
import { exportAssetRefusal } from '../mesh/meshCommon';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { codedRejection, exportRefusal, noop, report } from '../noop';
import { uint8ArrayToBase64 } from '../../lib/base64';
import { safeFileName } from '../../lib/safeFileName';
import { collectExportParts } from '../../geometry/entityTriangles';
import type { Vec3 } from '../../model/types';
import type { Triangle } from '../../geometry/triangles';
import { toMm } from '../../model/units';
import { entityIdsField } from './exportFormats';
import { buildThreeMf, type ThreeMfBody } from './threeMf';
import { MAX_3MF_BYTES, ThreeMfTooLargeError } from './threeMfStream';
import { beamLatticeOf, levelSetOf } from '../../plugins/host';
import type { LevelSetExport } from '../../geometry/field/levelSetExport';
import type { MeshData as FieldMesh } from '../../model/types';
import type { BeamLatticeExport } from '../../model/beamLattice';
import type { MeshData } from '../../model/types';

/** Largest triangle-list mesh object written in memory (about 85 bytes of XML per triangle and vertex pair, three copies while building); indexed meshes stream instead. */
const MAX_MESH_TRIANGLES = 2_000_000;

/** Indexed meshes above this many triangles are streamed and deflated; smaller ones are stored as before. */
const STREAM_TRIANGLES = 250_000;

/** The level set of a plugin body for the writer: function in document units, domain box and mesh operands in millimetres. */
function levelSetInMm(levelset: LevelSetExport, mm: number): NonNullable<ThreeMfBody['levelset']> {
  const pad = 2 * levelset.minFeature;
  const [lo, hi] = [levelset.bounds.min.map((c) => (c - pad) * mm), levelset.bounds.max.map((c) => (c + pad) * mm)];
  const corner = (i: number): Vec3 => [(i & 1 ? hi : lo)[0] as number, (i & 2 ? hi : lo)[1] as number, (i & 4 ? hi : lo)[2] as number];
  const faces = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  const domain: Triangle[] = [];
  for (let t = 0; t < faces.length; t += 3)
    domain.push([corner(faces[t] as number), corner(faces[t + 1] as number), corner(faces[t + 2] as number)]);
  const trianglesOf = (mesh: FieldMesh): Triangle[] => {
    const out: Triangle[] = [];
    const at = (index: number): Vec3 => [
      mesh.positions[index * 3] as number,
      mesh.positions[index * 3 + 1] as number,
      mesh.positions[index * 3 + 2] as number,
    ];
    for (let t = 0; t + 2 < mesh.indices.length; t += 3)
      out.push([at(mesh.indices[t] as number), at(mesh.indices[t + 1] as number), at(mesh.indices[t + 2] as number)]);
    return out;
  };
  return {
    program: levelset.program,
    toFunction: 1 / mm,
    minFeatureSize: levelset.minFeature * mm,
    domain,
    meshes: levelset.program.meshes.map((entry) => trianglesOf(entry.mesh)),
  };
}

/** Millimetre form of a plugin's beam lattice (nodes, radii, clip and representation meshes). */
function latticeInMm(lattice: BeamLatticeExport, representation: readonly Triangle[], mm: number): NonNullable<ThreeMfBody['lattice']> {
  const triangles = (mesh: MeshData | null): Triangle[] | null => {
    if (mesh === null) return null;
    const point = (index: number): Vec3 => [
      (mesh.positions[index * 3] as number) * mm,
      (mesh.positions[index * 3 + 1] as number) * mm,
      (mesh.positions[index * 3 + 2] as number) * mm,
    ];
    const out: Triangle[] = [];
    for (let t = 0; t + 2 < mesh.indices.length; t += 3)
      out.push([point(mesh.indices[t] as number), point(mesh.indices[t + 1] as number), point(mesh.indices[t + 2] as number)]);
    return out;
  };
  return {
    nodes: lattice.nodes.map((n): Vec3 => [n[0] * mm, n[1] * mm, n[2] * mm]),
    beams: lattice.beams.map((beam) => ({ ...beam, r1: beam.r1 * mm, r2: beam.r2 * mm })),
    radius: lattice.radius * mm,
    ballRadius: lattice.nodeRadius === null ? null : lattice.nodeRadius * mm,
    clip: triangles(lattice.clip),
    representation: representation.length > 0 ? representation : null,
  };
}

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data = { format:'3mf', fileName, base64, objectCount, triangleCount, objects[{ name, vertices, triangles, manifold, beams?, levelsetNodes? }], implicit?, beamLattice? };
 *   one 3MF object per non-empty body (name, base-material colour); coordinates in millimetres whatever the document unit;
 *   implicit (only with implicit:'levelset') = { written[ids], skipped[{ id, reason }] }; beamLattice (only with beamLattice:true) = { written[ids], skipped[{ id, reason }], beams };
 *   objects[].beams is set on a beam-lattice object, levelsetNodes on a level-set object (both with 0 triangles)
 * @invariant an indexed mesh above 250000 triangles is streamed from its arrays and DEFLATE-compressed (smaller ones are stored byte for byte as before);
 *   the package is one base64 string, so the deflated model part is capped at 375000000 bytes (about 8 million triangles of a gyroid-like mesh)
 * @failure no exportable 3D body -> no-op, no data; 2D and unknown ids skipped
 * @failure EXPORT_MESH_TOO_LARGE (coded rejection, document unchanged) -> the deflated model passes the cap, or a non-indexed body has over 2000000 triangles
 * @failure an asset-backed mesh whose asset is missing -> MESH_ASSET_MISSING / MESH_ASSET_UNAVAILABLE rejection
 */
export const export3mf = defineCommand({
  name: 'export_3mf',
  annotations: { readOnly: true },
  description:
    'Export the 3D bodies (all, or entityIds) as a 3MF package (.3mf, ZIP with 3D/3dmodel.model), the format slicers and print services ' +
    'read: one object per body carrying its name (set_entity_name, else the id) and its colour as a base material, one build item per ' +
    'object, units millimetre (document lengths are converted). Vertices are welded into an indexed mesh; data.objects[].manifold says ' +
    'whether each body is a closed, consistently oriented shell (printable). Returns data: { format:"3mf", fileName, base64, objectCount, ' +
    'triangleCount, objects[] (name, vertices, triangles, manifold; beams for a beam lattice, levelsetNodes for a level set), implicit?, beamLattice? }; the CLI writes it with --save PATH.3mf. ' +
    'Large meshes (over 250000 triangles) are streamed and compressed, so multi-million-triangle implicit bodies export; the package is returned as one base64 string, which caps it near 8 million triangles ' +
    '(EXPORT_MESH_TOO_LARGE above: use implicit "levelset", beamLattice, a coarser voxel, decimate_mesh or export_stl). 2D shapes and unknown ids are skipped. Does NOT modify the document.',
  params: z.object({
    entityIds: entityIdsField,
    name: z.string().optional().describe('File name without extension (default "model"); reduced to letters, digits, "." "_" "-".'),
    implicit: z
      .enum(['mesh', 'levelset'])
      .optional()
      .describe(
        'levelset: write implicit bodies as a 3MF Volumetric & Implicit level set (the field itself as an implicit function of native nodes, bounded by a box mesh; no triangles), for printers that read the extension; strut / graph lattices and bodies built on them stay beam lattices or meshes (data.implicit lists written and skipped with the reason). The function is negative inside (the spec does not state the interior sign of a level set; llull uses the sign of its own mesh-distance node). Document units other than millimetres are refused for bodies built on solids. mesh (default): triangles.',
      ),
    beamRepresentation: z
      .boolean()
      .optional()
      .describe(
        'With beamLattice: also write the realised mesh of each lattice as its representationmesh (for consumers that cannot build beams; the file then holds the mesh too). Default false.',
      ),
    beamLattice: z
      .boolean()
      .optional()
      .describe(
        'Write implicit strut / graph lattice bodies as a 3MF Beam Lattice (nodes + beams with end radii, the clipping region as clippingmesh, the realised mesh as representationmesh) instead of their triangles: small files, slicer-native struts. TPMS and other bodies stay meshes; data.beamLattice lists what was written and what was skipped with the reason.',
      ),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_3mf', '3mf', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const collected = collectExportParts(doc, params.entityIds, (ctx ?? currentContext()).meshAssets);
    const unreadable = exportAssetRefusal(doc, 'export_3mf', collected.unreadable);
    if (unreadable !== null) return unreadable;
    const mm = toMm(doc, 1);
    const scale = (v: Vec3): Vec3 => [v[0] * mm, v[1] * mm, v[2] * mm];
    const levelsets: string[] = [];
    const skippedLevelsets: Array<{ id: string; reason: string }> = [];
    const tooLarge: Array<{ id: string; triangles: number }> = [];
    const lattices: string[] = [];
    const skippedLattices: Array<{ id: string; reason: string }> = [];
    const scaleTris = (tris: readonly Triangle[]): Triangle[] => tris.map(([a, b, c]): Triangle => [scale(a), scale(b), scale(c)]);
    const bodies = collected.parts
      .map((part): ThreeMfBody => {
        const base = { name: part.name ?? part.id, color: part.color };
        const meshBody = (): ThreeMfBody => {
          if (part.indexed !== undefined && part.triangleCount > STREAM_TRIANGLES)
            return { ...base, tris: [], indexed: { ...part.indexed, scale: mm } };
          if (part.triangleCount <= MAX_MESH_TRIANGLES) return { ...base, tris: scaleTris(part.tris) };
          tooLarge.push({ id: part.id, triangles: part.triangleCount });
          return { ...base, tris: [] };
        };
        if (params.implicit === 'levelset') {
          const answer = levelSetOf(doc, part.id, ctx);
          if (typeof answer === 'string') skippedLevelsets.push({ id: part.id, reason: answer });
          else if (answer !== null) {
            if (mm !== 1 && answer.program.meshes.length > 0)
              skippedLevelsets.push({ id: part.id, reason: 'a body built on solids needs a millimetre document for its level set' });
            else {
              levelsets.push(part.id);
              return { ...base, tris: [], levelset: levelSetInMm(answer, mm) };
            }
          }
        }
        if (params.beamLattice !== true) return meshBody();
        const answer = beamLatticeOf(doc, part.id, ctx);
        if (answer === null) return meshBody();
        if (typeof answer === 'string') {
          skippedLattices.push({ id: part.id, reason: answer });
          return meshBody();
        }
        lattices.push(part.id);
        return { ...base, tris: [], lattice: latticeInMm(answer, params.beamRepresentation === true ? scaleTris(part.tris) : [], mm) };
      })
      .filter((body) => body.tris.length > 0 || body.indexed !== undefined || body.lattice !== undefined || body.levelset !== undefined);
    const first = tooLarge[0];
    if (first !== undefined)
      return codedRejection(
        doc,
        'export_3mf',
        'EXPORT_MESH_TOO_LARGE',
        `body '${first.id}' has ${first.triangles} triangles and is not an indexed mesh; a triangle-list 3MF object is limited to ${MAX_MESH_TRIANGLES}`,
        'convert it to a mesh solid first, or reduce it (decimate_mesh); export_stl handles large meshes better',
        tooLarge.map((entry) => entry.id),
      );
    if (bodies.length === 0) return noop(doc, 'export_3mf: no 3D body with geometry to export (2D shapes and unknown ids are skipped).');
    let built: ReturnType<typeof buildThreeMf>;
    try {
      built = buildThreeMf(bodies);
    } catch (error) {
      if (!(error instanceof ThreeMfTooLargeError)) throw error;
      return codedRejection(
        doc,
        'export_3mf',
        'EXPORT_MESH_TOO_LARGE',
        `the model needs more than ${MAX_3MF_BYTES} deflated bytes (${error.bytes} bytes of XML written when it stopped); the package is returned as one base64 string`,
        'export the large bodies one at a time, write implicit bodies as implicit: "levelset" (the field, no triangles) or beamLattice: true (strut lattices), reduce the mesh (decimate_mesh, a coarser voxel), or use export_stl',
        collected.parts.map((part) => part.id),
      );
    }
    const { bytes, objects } = built;
    const triangleCount = objects.reduce((sum, object) => sum + object.triangles, 0);
    const open = objects.filter((object) => !object.manifold && object.beams === undefined).map((object) => object.name);
    const fileName = `${safeFileName(params.name, 'model')}.3mf`;
    return report(
      doc,
      `export_3mf: ${objects.length} object(s), ${triangleCount} triangle(s)${lattices.length > 0 ? `, ${lattices.length} beam lattice(s) of ${objects.reduce((sum, object) => sum + (object.beams ?? 0), 0)} beams` : ''}, ${bytes.length} bytes → ${fileName} (millimetres).` +
        (levelsets.length > 0 ? ` ${levelsets.length} level set(s) (no triangles).` : '') +
        (skippedLevelsets.length > 0
          ? ` Kept as meshes (no level set): ${skippedLevelsets.map((s) => `${s.id} (${s.reason})`).join('; ')}.`
          : '') +
        (skippedLattices.length > 0
          ? ` Kept as meshes (no beam lattice): ${skippedLattices.map((s) => `${s.id} (${s.reason})`).join('; ')}.`
          : '') +
        (open.length > 0 ? ` Not closed manifold shells: ${open.join(', ')}.` : '') +
        (collected.unknownIds.length > 0 ? ` Unknown ids skipped: ${collected.unknownIds.join(', ')}.` : ''),
      {
        format: '3mf',
        fileName,
        base64: uint8ArrayToBase64(bytes),
        objectCount: objects.length,
        triangleCount,
        objects,
        ...(params.implicit === 'levelset' ? { implicit: { written: levelsets, skipped: skippedLevelsets } } : {}),
        ...(params.beamLattice === true
          ? {
              beamLattice: {
                written: lattices,
                skipped: skippedLattices,
                beams: objects.reduce((sum, object) => sum + (object.beams ?? 0), 0),
              },
            }
          : {}),
      },
    );
  },
});
