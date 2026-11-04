/** import_gltf — glTF 2.0 / GLB to mesh entities, or components + instances for EXT_mesh_gpu_instancing nodes (the reader of `export_gltf`). */

import type { CadDocument, Component, Entity } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { nextId } from '../../lib/id';
import { base64ToUint8Array } from '../../lib/base64';
import { MAX_IMPORT_BYTES } from '../limits';
import { changed, codedRejection } from '../noop';
import { newEntity } from '../entity/newEntity';
import { withEntities } from '../entity/entityOps';
import { instanceEntity } from '../assembly/assemblies';
import { readGltfFile } from './gltfContainer';
import { GLTF_REMEDIATION, GltfError, type GltfCode } from './gltfJson';
import { type PlannedBody, type PlannedComponent, planGltfScene } from './gltfImportScene';

/** Base64 characters of the largest accepted file. */
const MAX_BASE64_CHARS = Math.ceil((MAX_IMPORT_BYTES * 4) / 3) + 4;

const meshOf = (id: string, body: PlannedBody): Entity =>
  newEntity('mesh', id, { mesh: { positions: body.positions, indices: body.indices } }, [0, 0, 0], body.color, { name: body.name });

/**
 * @affects creates one mesh entity per plain mesh primitive and one instance entity per instanced TRS (appended to order in scene order); adds one
 *   component per instanced mesh (its primitives as component entities)
 * @invariant coordinates are kept as in the file (glTF Y-up is not converted; `scale` multiplies lengths); a node hierarchy is composed into world transforms
 * @invariant ids are minted by nextId: file ids (extras.llullIds / llullIdRuns) are ignored
 * @failure bad params / malformed or truncated file / external uri / required extension other than EXT_mesh_gpu_instancing / index or accessor out of
 *   range / over a limit / no triangle mesh -> no-op, affected:[], error.code GLTF_* (never throws)
 */
export const importGltf = defineCommand({
  name: 'import_gltf',
  description:
    'Import a glTF 2.0 file (.glb binary, or .gltf JSON with embedded data: URI buffers) into the document: the reader of export_gltf. Every mesh node of the default ' +
    'scene becomes mesh entities in world space (node hierarchy transforms composed, one entity per triangle primitive, colour from the material baseColorFactor, ' +
    'named after the node). A node with the EXT_mesh_gpu_instancing extension becomes ONE component per glTF mesh (its primitives, in the mesh frame) plus one ' +
    'instance entity per TRANSLATION / ROTATION / SCALE entry (position, Euler XYZ rotation, per-axis scale); an instance that cannot be an instance ' +
    '(mirrored or sheared by its parent transform) is baked as mesh entities, and a zero-scale one is skipped. Entity ids are minted fresh; the llullIds extras of ' +
    'export_gltf are ignored, so ids differ from the exported document but names, colours and world geometry round-trip. Coordinates are NOT converted (glTF Y-up ' +
    'stays Y-up, as export_gltf writes llull Z-up unchanged); pass scale: 1000 to read a file in metres into a millimetre document. Supported: FLOAT POSITION, ' +
    'triangle lists (other primitive modes are counted as skipped), UNSIGNED_BYTE / SHORT / INT indices, strided buffer views. Refused: external buffer URIs ' +
    '(GLTF_EXTERNAL_URI: nothing outside the file is ever read), required extensions other than EXT_mesh_gpu_instancing such as Draco (GLTF_EXTENSION_REQUIRED), sparse / ' +
    'normalized accessors (GLTF_UNSUPPORTED), inconsistent accessors or out-of-range indices (GLTF_BAD_ACCESSOR), broken JSON / GLB structure (GLTF_MALFORMED), ' +
    'more than 200000 node expansions, 1000000 instances, 10000 mesh bodies or 2000000 baked triangles (GLTF_LIMIT), and a scene without triangles (GLTF_NO_GEOMETRY). ' +
    'Give exactly one of dataBase64 (the file bytes, GLB or JSON; the CLI fills it from file=<path>) or text (glTF JSON). Returns the created ids in affected ' +
    '(bodies and instances in scene order) and data { meshEntities, instances, components, triangles, skippedPrimitives, skippedInstances }.',
  params: z.object({
    dataBase64: z
      .string()
      .max(MAX_BASE64_CHARS)
      .optional()
      .describe(
        'The file bytes, base64 encoded: a .glb, or a .gltf JSON. Give exactly one of dataBase64 or text. The CLI sets it from file=<path>.',
      ),
    text: z
      .string()
      .max(MAX_IMPORT_BYTES)
      .optional()
      .describe('The glTF 2.0 JSON as text (buffers embedded as base64 data: URIs). Give exactly one of dataBase64 or text.'),
    scale: z
      .number()
      .positive()
      .finite()
      .optional()
      .describe('Multiplier applied to every length of the file (default 1). glTF is in metres: 1000 imports into a millimetre document.'),
  }),
  run: (doc, params): CommandResult => {
    const refuse = (code: GltfCode, message: string, path = 'dataBase64'): CommandResult =>
      codedRejection(doc, 'import_gltf', code, message, GLTF_REMEDIATION[code], [], [path]);
    if ((params.text === undefined) === (params.dataBase64 === undefined))
      return refuse('CMD_INVALID_PARAMS', 'give exactly one of dataBase64 or text', 'dataBase64');
    try {
      const bytes = params.dataBase64 === undefined ? null : base64ToUint8Array(params.dataBase64);
      if (params.dataBase64 !== undefined && bytes === null) return refuse('GLTF_MALFORMED', 'dataBase64 is not valid base64');
      const file = readGltfFile(bytes === null ? { text: params.text ?? '' } : { bytes });
      const plan = planGltfScene(file, params.scale ?? 1);
      if (plan.placements.length === 0)
        return refuse('GLTF_NO_GEOMETRY', `the scene holds no triangle mesh (${plan.skippedPrimitives} non-triangle primitive(s) skipped)`);
      return build(doc, plan);
    } catch (error) {
      if (error instanceof GltfError) return refuse(error.code, error.message, error.path);
      return refuse('GLTF_MALFORMED', `the file could not be read (${error instanceof Error ? error.message : String(error)})`);
    }
  },
});

/** The document with the plan's components, bodies and instances created in scene order. */
function build(doc: CadDocument, plan: ReturnType<typeof planGltfScene>): CommandResult {
  const components: Record<string, Component> = { ...doc.components };
  const ids = new Map<PlannedComponent, string>();
  for (const planned of plan.components) {
    const id = nextId('comp');
    const entities = planned.bodies.map((body) => meshOf(nextId('mesh'), body));
    ids.set(planned, id);
    components[id] = {
      id,
      name: planned.name,
      entities: Object.fromEntries(entities.map((e) => [e.id, e])),
      order: entities.map((e) => e.id),
    };
  }
  const created: Entity[] = plan.placements.map((placement) =>
    placement.kind === 'body'
      ? meshOf(nextId('mesh'), placement.body)
      : instanceEntity(nextId('instance'), ids.get(placement.component) ?? '', placement.position, placement.rotation, placement.scale),
  );
  const bodyCount = plan.placements.filter((placement) => placement.kind === 'body').length;
  const instanceCount = created.length - bodyCount;
  const affected = created.map((entity) => entity.id);
  const skipped = plan.skippedPrimitives + plan.skippedInstances;
  const result = changed(
    { ...withEntities(doc, created), components },
    `Imported glTF: ${bodyCount} mesh entit${bodyCount === 1 ? 'y' : 'ies'}, ${instanceCount} instance${instanceCount === 1 ? '' : 's'} of ` +
      `${plan.components.length} component${plan.components.length === 1 ? '' : 's'} (${plan.triangleCount} triangles)` +
      `${skipped > 0 ? `; skipped ${plan.skippedPrimitives} non-triangle primitive(s) and ${plan.skippedInstances} zero-scale instance(s)` : ''}.`,
    affected,
  );
  return {
    ...result,
    data: {
      meshEntities: bodyCount,
      instances: instanceCount,
      components: plan.components.length,
      triangles: plan.triangleCount,
      skippedPrimitives: plan.skippedPrimitives,
      skippedInstances: plan.skippedInstances,
    },
  };
}
