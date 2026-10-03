/**
 * Non-boolean 3D solid modifier commands — fillet and chamfer.
 *
 * Each command takes a single 3D solid entity, delegates tessellation and
 * edge modification to the injected GeometryKernel, and produces a new
 * `mesh` entity. The source entity is consumed (pruned from the document).
 *
 * When the kernel returns null (Manifold graceful no-op, or OCC stub) the
 * document is returned unchanged with an explanatory summary.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, MeshSolidEntity } from '../model/types';
import { is3D } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { currentContext } from './context';
import { nextId } from '../lib/id';
import { replaceEntities } from './entityOps';
import { noop } from './noop';

function validateSolidTarget(
  doc: CadDocument,
  opName: string,
  id: string,
): { entity: Entity } | CommandResult {
  const entity = doc.entities[id];
  if (!entity) {
    return noop(doc, `${opName}: entity '${id}' not found.`);
  }
  if (!is3D(entity)) {
    return noop(
      doc,
      `${opName}: entity '${id}' is a 2D shape (kind '${entity.kind}'); only 3D solids can be filleted or chamfered.`,
    );
  }
  return { entity };
}

/**
 * @command fillet_edge
 * @pure
 * @layer core/commands
 * @affects removes source entity; creates 1 mesh entity with rounded edges
 * @invariant target must be a 3D solid; radius > 0; geometry kernel must be injected
 * @failure missing id, 2D kind, radius ≤ 0, kernel absent, or kernel null → no-op, affected:[]
 */
export const filletEdge = defineCommand({
  name: 'fillet_edge',
  annotations: { requiresKernel: true },
  description:
    'Round (fillet) the edges of a 3D solid entity and replace it with a new mesh entity. ' +
    'The source entity is consumed and replaced by the filleted mesh result. ' +
    'edgeIndices selects which edges to fillet; omit or pass [] to fillet ALL edges ' +
    '(OCC convention: the kernel enumerates edges 0-based and applies radius to each selected edge). ' +
    'Requires a geometry kernel that supports filletEdges (available with ?kernel=occt). ' +
    'With the default Manifold kernel, this command gracefully no-ops (returns unchanged doc). ' +
    'Target must be a 3D solid (box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, or mesh).',
  params: z.object({
    id: z
      .string()
      .describe('Id of the 3D solid entity to fillet. Must exist and be a 3D solid kind.'),
    edgeIndices: z
      .array(z.number())
      .describe(
        '0-based indices of the edges to fillet. Pass [] or omit to fillet ALL edges. ' +
          'Edge numbering is kernel-defined (OCC enumerates edges in topology traversal order). ' +
          'Ignored by kernels that do not support partial-edge selection.',
      )
      .optional(),
    radius: z.number().describe('Fillet radius in document units. Must be > 0.'),
  }),
  run: (doc, { id, edgeIndices = [], radius }, ctx): CommandResult => {
    if (radius <= 0) {
      return noop(doc, `fillet_edge: radius must be > 0 (got ${radius}).`);
    }

    const validation = validateSolidTarget(doc, 'fillet_edge', id);
    if ('summary' in validation) return validation;
    const { entity } = validation;

    const k = (ctx ?? currentContext()).kernel;
    if (!k) {
      return noop(
        doc,
        `fillet_edge: geometry kernel not available (still loading or not installed); document unchanged — retry once the kernel is ready.`,
      );
    }

    const meshData = k.tessellate(entity);
    if (!meshData) {
      return noop(
        doc,
        `fillet_edge: kernel could not tessellate entity '${id}' (kind '${entity.kind}'). The entity may have degenerate geometry or an unsupported kind for this kernel.`,
      );
    }

    const filleted = k.filletEdges(meshData, edgeIndices, radius);
    if (!filleted) {
      return {
        document: doc,
        summary:
          `fillet_edge: kernel does not support fillet_edge for this operand (returned null). ` +
          `Try ?kernel=occt or a different operand.`,
        affected: [],
      };
    }

    const newId = nextId('mesh');
    const meshEntity: MeshSolidEntity = {
      id: newId,
      kind: 'mesh',
      mesh: filleted,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: entity.layerId,
      color: entity.color,
    };

    const triangleCount = filleted.indices.length / 3;
    return {
      document: replaceEntities(doc, [id], meshEntity),
      summary: `fillet_edge: filleted '${id}' (kind '${entity.kind}', radius ${radius}) → mesh '${newId}' (${triangleCount} triangles). Source entity consumed.`,
      affected: [newId],
    };
  },
});

/**
 * @command chamfer_edge
 * @pure
 * @layer core/commands
 * @affects removes source entity; creates 1 mesh entity with beveled edges
 * @invariant target must be a 3D solid; distance > 0; geometry kernel must be injected
 * @failure missing id, 2D kind, distance ≤ 0, kernel absent, or kernel null → no-op, affected:[]
 */
export const chamferEdge = defineCommand({
  name: 'chamfer_edge',
  annotations: { requiresKernel: true },
  description:
    'Bevel (chamfer) the edges of a 3D solid entity and replace it with a new mesh entity. ' +
    'The source entity is consumed and replaced by the chamfered mesh result. ' +
    'edgeIndices selects which edges to chamfer; omit or pass [] to chamfer ALL edges ' +
    '(OCC convention: the kernel enumerates edges 0-based). ' +
    'Requires a geometry kernel that supports chamferEdges. ' +
    'Both the default Manifold kernel and the current OCC kernel gracefully no-op ' +
    '(chamferEdges OCC spike is pending a separate batch). ' +
    'Target must be a 3D solid (box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, or mesh).',
  params: z.object({
    id: z
      .string()
      .describe('Id of the 3D solid entity to chamfer. Must exist and be a 3D solid kind.'),
    edgeIndices: z
      .array(z.number())
      .describe(
        '0-based indices of the edges to chamfer. Pass [] or omit to chamfer ALL edges. ' +
          'Edge numbering is kernel-defined (OCC enumerates edges in topology traversal order).',
      )
      .optional(),
    distance: z.number().describe('Chamfer distance in document units. Must be > 0.'),
  }),
  run: (doc, { id, edgeIndices = [], distance }, ctx): CommandResult => {
    if (distance <= 0) {
      return noop(doc, `chamfer_edge: distance must be > 0 (got ${distance}).`);
    }

    const validation = validateSolidTarget(doc, 'chamfer_edge', id);
    if ('summary' in validation) return validation;
    const { entity } = validation;

    const k = (ctx ?? currentContext()).kernel;
    if (!k) {
      return noop(
        doc,
        `chamfer_edge: geometry kernel not available (still loading or not installed); document unchanged — retry once the kernel is ready.`,
      );
    }

    const meshData = k.tessellate(entity);
    if (!meshData) {
      return noop(
        doc,
        `chamfer_edge: kernel could not tessellate entity '${id}' (kind '${entity.kind}'). The entity may have degenerate geometry or an unsupported kind for this kernel.`,
      );
    }

    const chamfered = k.chamferEdges(meshData, edgeIndices, distance);
    if (!chamfered) {
      return {
        document: doc,
        summary:
          `chamfer_edge: kernel does not support chamfer_edge for this operand (returned null). ` +
          `Try ?kernel=occt or a different operand.`,
        affected: [],
      };
    }

    const newId = nextId('mesh');
    const meshEntity: MeshSolidEntity = {
      id: newId,
      kind: 'mesh',
      mesh: chamfered,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: entity.layerId,
      color: entity.color,
    };

    const triangleCount = chamfered.indices.length / 3;
    return {
      document: replaceEntities(doc, [id], meshEntity),
      summary: `chamfer_edge: chamfered '${id}' (kind '${entity.kind}', distance ${distance}) → mesh '${newId}' (${triangleCount} triangles). Source entity consumed.`,
      affected: [newId],
    };
  },
});
