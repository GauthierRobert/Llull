/**
 * Fillet, chamfer and shell: the injected GeometryKernel tessellates a 3D solid and rounds/bevels its
 * edges (or hollows it); the source entity is replaced by the resulting `mesh` entity. A null kernel
 * result is a no-op.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity } from '../model/types';
import type { GeometryKernel, MeshData } from '../geometry/kernel';
import { is3D } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import type { ExecutionContext } from './context';
import { currentContext } from './context';
import { nextId } from '../lib/id';
import { referenceLossSuffix, replaceEntities } from './entityOps';
import { kernelUnavailable } from './kernelRefusal';
import { newEntity } from './newEntity';
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
      `${opName}: entity '${id}' is a 2D shape (kind '${entity.kind}'); only 3D solids can be filleted, chamfered or shelled.`,
    );
  }
  return { entity };
}

interface EdgeModification {
  readonly command: 'fillet_edge' | 'chamfer_edge' | 'shell_solid';
  readonly pastTense: string;
  readonly amountName: 'radius' | 'distance' | 'thickness';
  readonly amount: number;
  readonly id: string;
  readonly apply: (kernel: GeometryKernel, mesh: MeshData) => MeshData | null;
}

/** Shared body of fillet_edge / chamfer_edge / shell_solid: validate, tessellate, modify edges, replace the source. */
function modifyEdges(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  { command, pastTense, amountName, amount, id, apply }: EdgeModification,
): CommandResult {
  if (amount <= 0) return noop(doc, `${command}: ${amountName} must be > 0 (got ${amount}).`);
  const validation = validateSolidTarget(doc, command, id);
  if ('summary' in validation) return validation;
  const { entity } = validation;

  const kernel = (ctx ?? currentContext()).kernel;
  if (!kernel) return noop(doc, kernelUnavailable(command));
  const meshData = kernel.tessellate(entity);
  if (!meshData) {
    return noop(
      doc,
      `${command}: kernel could not tessellate entity '${id}' (kind '${entity.kind}'). The entity may have degenerate geometry or an unsupported kind for this kernel.`,
    );
  }
  const modified = apply(kernel, meshData);
  if (!modified) {
    return noop(
      doc,
      `${command}: kernel does not support ${command} for this operand (returned null). Try ?kernel=occt or a different operand.`,
    );
  }

  const newId = nextId('mesh');
  const meshEntity = newEntity('mesh', newId, { mesh: modified }, [0, 0, 0], entity.color, {
    layerId: entity.layerId,
  });
  const document = replaceEntities(doc, [id], meshEntity);
  return {
    document,
    summary: `${command}: ${pastTense} '${id}' (kind '${entity.kind}', ${amountName} ${amount}) → mesh '${newId}' (${modified.indices.length / 3} triangles). Source entity consumed.${referenceLossSuffix(doc, document)}`,
    affected: [newId],
  };
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
  run: (doc, { id, edgeIndices = [], radius }, ctx): CommandResult =>
    modifyEdges(doc, ctx, {
      command: 'fillet_edge',
      pastTense: 'filleted',
      amountName: 'radius',
      amount: radius,
      id,
      apply: (kernel, mesh) => kernel.filletEdges(mesh, edgeIndices, radius),
    }),
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
  run: (doc, { id, edgeIndices = [], distance }, ctx): CommandResult =>
    modifyEdges(doc, ctx, {
      command: 'chamfer_edge',
      pastTense: 'chamfered',
      amountName: 'distance',
      amount: distance,
      id,
      apply: (kernel, mesh) => kernel.chamferEdges(mesh, edgeIndices, distance),
    }),
});

/**
 * @command shell_solid
 * @pure
 * @layer core/commands
 * @affects removes source entity; creates 1 hollow mesh entity with walls of the given thickness
 * @invariant target must be a closed 3D solid; thickness > 0; geometry kernel must be injected
 * @failure missing id, 2D kind, thickness <= 0, kernel absent, or kernel null -> no-op, affected:[]
 */
export const shellSolid = defineCommand({
  name: 'shell_solid',
  annotations: { requiresKernel: true },
  description:
    'Hollow out a closed 3D solid, leaving walls of the given thickness (grown inward), and replace it ' +
    'with a new mesh entity. The source entity is consumed. ' +
    'Requires a geometry kernel that supports shellSolid; a kernel without it (or a solid that is too ' +
    'thin for the thickness) makes this a graceful no-op that leaves the document unchanged. ' +
    'Target must be a 3D solid (box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution or mesh).',
  params: z.object({
    id: z
      .string()
      .describe('Id of the closed 3D solid entity to hollow. Must exist and be a 3D solid.'),
    thickness: z
      .number()
      .describe(
        "Wall thickness in document units. Must be > 0 and smaller than half the solid's thinnest dimension.",
      ),
  }),
  run: (doc, { id, thickness }, ctx): CommandResult =>
    modifyEdges(doc, ctx, {
      command: 'shell_solid',
      pastTense: 'shelled',
      amountName: 'thickness',
      amount: thickness,
      id,
      apply: (kernel, mesh) => kernel.shellSolid(mesh, thickness),
    }),
});
