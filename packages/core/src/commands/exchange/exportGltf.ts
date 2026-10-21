/**
 * export_gltf: read-only glTF 2.0 / GLB export (scene layout: ./gltfScene.ts) — one named node per entity, indexed meshes shared by identical copies (each child of an
 * instance), one PBR material per distinct appearance, entity groups as parent nodes, finishes as textures, decals as overlays (document
 * returned unchanged).
 */

import type { CommandResult } from '../types';
import { exportRefusal, report } from '../noop';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { uint8ArrayToBase64 } from '../../lib/base64';
import { collectExportParts, exportSummary } from '../../geometry/entityTriangles';
import type { CadDocument } from '../../model/types';
import { entityIdsField } from './exportFormats';
import { type GroupOf, buildGltfScene, collectDecalParts, collectSceneParts } from './gltfScene';

/** Align a byte length to a 4-byte boundary (glTF chunk requirement). */
function align4(n: number): number {
  return (n + 3) & ~3;
}

type GltfScene = ReturnType<typeof buildGltfScene>;

/** First group (document order) containing each entity id. */
function groupIndex(doc: CadDocument): GroupOf {
  const owner = new Map<string, { id: string; name: string }>();
  for (const group of Object.values(doc.groups)) {
    for (const memberId of group.memberIds) {
      if (!owner.has(memberId)) owner.set(memberId, { id: group.id, name: group.name });
    }
  }
  return (entityId) => owner.get(entityId);
}

/** One GLB chunk: u32 length + u32 type + payload padded to 4 bytes with `pad`. */
function glbChunk(type: number, payload: Uint8Array, pad: number): Uint8Array {
  const padded = align4(payload.length);
  const chunk = new Uint8Array(8 + padded).fill(pad);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, padded, true);
  view.setUint32(4, type, true);
  chunk.set(payload, 8);
  return chunk;
}

/** GLB container: 12-byte header + JSON chunk (+ BIN chunk when there is a payload). */
function buildGlb(jsonObj: Record<string, unknown>, binPayload: Uint8Array): Uint8Array {
  const chunks = [glbChunk(0x4e4f534a, new TextEncoder().encode(JSON.stringify(jsonObj)), 0x20)];
  if (binPayload.length > 0) chunks.push(glbChunk(0x004e4942, binPayload, 0));
  const total = 12 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let offset = 12;
  for (const chunk of chunks) {
    glb.set(chunk, offset);
    offset += chunk.length;
  }
  return glb;
}

/** Add the inlined BIN payload (`data:` URI) to buffer 0 of a JSON-mode glTF. */
function withInlineBuffer(scene: GltfScene): Record<string, unknown> {
  if (scene.bin.length === 0) return scene.json;
  const uri = `data:application/octet-stream;base64,${uint8ArrayToBase64(scene.bin)}`;
  return { ...scene.json, buffers: [{ byteLength: scene.bin.length, uri }] };
}

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.format matches the binary param; data.triangleCount >= 0
 * @invariant one node per exported entity (node.name = entity name or id); identical local geometry + appearance share one indexed mesh
 *   (node matrix = entity placement), a unique part keeps a world-space mesh; one material per
 *   distinct entity color; an entity in a group hangs under a node named after the group
 * @invariant glTF JSON is valid 2.0 (asset.version="2.0"); GLB header magic=0x46546C67
 * @failure 2D-only or unknown entities silently skipped; empty → triangleCount:0, nodeCount:0
 * @failure never throws for user error
 * @failure the document uses ITAR / EAR material records -> MAT_EXPORT_CONTROLLED, nothing exported (MAT_HUMAN_GATE for an agent confirmation)
 */
export const exportGltf = defineCommand({
  name: 'export_gltf',
  annotations: { readOnly: true },
  description:
    'Export the document (or a subset of entities) to glTF 2.0 format. ' +
    'Produces a triangle tessellation in world space for every exportable 3D solid entity. ' +
    '2D shape entities are silently skipped. Revolution and instance entities are fully expanded. ' +
    'Returns the UNCHANGED document, affected:[], and a data object with: ' +
    '  format ("gltf" or "glb"), triangleCount, nodeCount, materialCount, ' +
    '  text (glTF 2.0 JSON string — when binary=false, default),   base64 (GLB binary blob base64-encoded — when binary=true). ' +
    'Structure: one glTF node per entity (node.name = the entity name from set_entity_name, ' +
    'else its id; each child of an instance is its own node), and entities that belong to a group ' +
    '(group_entities) are children of a node named after the group. Node extras carry the llull ' +
    'entity id and kind. Meshes are indexed and carry POSITION and creased smooth NORMAL attributes; parts with identical geometry ' +
    'and appearance (pattern copies: array_polar / array_linear bolts, blades) share ONE mesh placed by each node matrix. One PBR material ' +
    'per distinct appearance: the assigned document material (color, metalness, roughness) or else ' +
    'the entity color, converted to linear glTF factors — ready for Blender / Cycles or any viewer. A ' +
    'material finish (create_material finish) embeds procedural albedo / normal / roughness PNG maps ' +
    'with box-projected TEXCOORD_0 (plus KHR_materials_clearcoat); text decals (add_decal) are extra ' +
    'alpha-blended textured meshes. The BIN buffer is inlined as a data: URI in JSON mode. ' +
    'In GLB mode the 12-byte header + JSON chunk + BIN chunk are packed per the glTF 2.0 spec. ' +
    'entityIds: omit to export all 3D entities; provide an array to export a subset. ' +
    'binary: false (default) → data.text contains JSON; true → data.base64 contains GLB. Does NOT modify the document.',
  params: z.object({
    entityIds: entityIdsField,
    confirmExportControlled,
    binary: z
      .boolean()
      .optional()
      .describe(
        'Output format selector. false (default): data.text contains a glTF 2.0 JSON string ' +
          'with the binary buffer inlined as a data: URI. true: data.base64 contains a base64-encoded GLB binary container ' +
          '(12-byte header + JSON chunk + BIN chunk per glTF 2.0 spec). ' +
          'Most web viewers accept JSON glTF; most desktop importers accept GLB.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { entityIds, binary = false } = params;
    const refused = exportRefusal(doc, 'export_gltf', 'gltf', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const collected = collectExportParts(doc, entityIds);
    const ids = collected.parts.map((part) => part.id);
    const scene = buildGltfScene(collectSceneParts(doc, ids), collectDecalParts(doc, ids), groupIndex(doc));
    const tris = collected.parts.flatMap((part) => part.tris);
    const counts = { triangleCount: tris.length, nodeCount: scene.nodeCount, materialCount: scene.materialCount };
    const summary =
      exportSummary('export_gltf', binary ? 'glb' : 'gltf', { ...collected, tris }) +
      ` ${scene.nodeCount} node(s), ${scene.materialCount} material(s).`;
    if (binary) {
      const base64 = uint8ArrayToBase64(buildGlb(scene.json, scene.bin));
      return report(doc, summary, { format: 'glb', ...counts, base64 });
    }
    const text = JSON.stringify(withInlineBuffer(scene), null, 2);
    return report(doc, summary, { format: 'gltf', ...counts, text });
  },
});
