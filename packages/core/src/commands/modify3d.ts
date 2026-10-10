/**
 * Fillet, chamfer and shell: the injected GeometryKernel rounds/bevels the exact edges of a 3D solid
 * (or hollows it) — on its B-rep, never on triangles; the source entity is replaced by a `mesh` entity
 * whose `brep` records the modification recipe. A null kernel result is a no-op.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import type { ShapeRecipe } from '../geometry/shapeRecipe';
import { is3D } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, vec3, z } from './schema';
import { selectEdges } from './edgeSelection';
import type { ExecutionContext } from './context';
import { currentContext } from './context';
import { nextId } from '../lib/id';
import { referenceLossSuffix, replaceEntities } from './entityOps';
import { kernelUnavailable } from './kernelRefusal';
import {
  evaluateRecipe,
  fallbackSuffix,
  kernelResultEntity,
  operandRecipe,
  topologySuffix,
} from './kernelShape';
import { changed, noop } from './noop';

/** Surface-neutral pointer to the B-rep kernel (browser URL flag or server env var). */
const OCC_KERNEL_HINT =
  'the OCC kernel (?kernel=occt in the browser, LLULL_KERNEL=occt on the server)';

function validateSolidTarget(
  doc: CadDocument,
  opName: string,
  id: string,
): { entity: Entity } | CommandResult {
  const entity = doc.entities[id];
  if (!entity) return noop(doc, `${opName}: entity '${id}' not found.`);
  if (!is3D(entity)) {
    return noop(
      doc,
      `${opName}: entity '${id}' is a 2D shape (kind '${entity.kind}'); only 3D solids can be filleted, chamfered or shelled.`,
    );
  }
  if (entity.kind === 'instance') {
    return noop(
      doc,
      `${opName}: entity '${id}' is a component instance; run explode_instance first to get solids.`,
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
  /** Selected unique-edge indices (fillet / chamfer); checked against the exact topology. */
  readonly edges?: readonly number[];
  /** Points naming edges by their nearest mid point (`edgesNear`), resolved on the current solid. */
  readonly near?: readonly Vec3[];
  /** The modification node over the operand's exact recipe and the resolved edges. */
  readonly recipe: (source: ShapeRecipe, edges: readonly number[]) => ShapeRecipe;
}

/**
 * Shared body of fillet_edge / chamfer_edge / shell_solid: validate, build the modification recipe on
 * the operand's exact shape (its real B-rep edges under OCC), replace the source by the result.
 */
function modifyEdges(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  { command, pastTense, amountName, amount, id, edges = [], near = [], recipe }: EdgeModification,
): CommandResult {
  if (amount <= 0) return noop(doc, `${command}: ${amountName} must be > 0 (got ${amount}).`);
  const validation = validateSolidTarget(doc, command, id);
  if ('summary' in validation) return validation;
  const { entity } = validation;

  const kernel = (ctx ?? currentContext()).kernel;
  if (!kernel) return noop(doc, kernelUnavailable(command));
  const source = operandRecipe(kernel, entity);
  const sourceShape = kernel.evaluate(source);
  if (sourceShape === null) {
    return noop(
      doc,
      `${command}: kernel could not build entity '${id}' (kind '${entity.kind}'). The entity may have degenerate geometry or an unsupported kind for this kernel.`,
    );
  }
  const selection = selectEdges(kernel.topology(sourceShape), edges, near);
  if ('problem' in selection)
    return noop(doc, `${command}: ${selection.problem} on '${id}'; document unchanged.`);
  const result = evaluateRecipe(kernel, recipe(source, selection.edges));
  if (typeof result === 'string') {
    return noop(
      doc,
      `${command}: kernel does not support ${command} for this operand (returned null). Use ${OCC_KERNEL_HINT} or a different operand.`,
    );
  }

  const newId = nextId('mesh');
  const meshEntity = kernelResultEntity(newId, result, entity);
  const document = replaceEntities(doc, [id], meshEntity);
  return changed(
    document,
    `${command}: ${pastTense} '${id}' (kind '${entity.kind}', ${amountName} ${amount}) → mesh '${newId}' (${result.mesh.indices.length / 3} triangles). Source entity consumed.${near.length > 0 ? ` edgesNear selected edges ${selection.edges.join(', ')}.` : ''}${fallbackSuffix(kernel, [entity])}${topologySuffix(kernel, result.shape)}${referenceLossSuffix(doc, document)}`,
    [newId],
  );
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
    'Round (fillet) exact B-rep edges of a 3D solid entity and replace it with a new mesh entity ' +
    'that keeps the exact construction (its brep recipe), so booleans, further fillets and STEP export ' +
    'still see true faces and edges. The source entity is consumed. ' +
    'Select edges with edgeIndices (indices from inspect_topology) and/or edgesNear (points near the edges, ' +
    'robust to parametric edits); with neither, ALL edges are filleted. ' +
    `Requires a geometry kernel that supports fillets (${OCC_KERNEL_HINT}). ` +
    'With the default Manifold kernel, this command gracefully no-ops (returns unchanged doc). ' +
    'Target must be a 3D solid (box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution, or mesh — including boolean results).',
  params: z.object({
    id: z
      .string()
      .describe('Id of the 3D solid entity to fillet. Must exist and be a 3D solid kind.'),
    edgeIndices: z
      .array(z.number().int().nonnegative())
      .describe(
        '0-based indices of the unique B-rep edges to fillet, as listed by inspect_topology on the same entity ' +
          '(each edge counted once). Pass [] or omit (with no edgesNear) to fillet ALL edges.',
      )
      .optional(),
    edgesNear: z
      .array(
        vec3(
          'A point [x, y, z] near the edge to fillet (e.g. its mid point from inspect_topology).',
        ),
      )
      .describe(
        'Select edges by location: each point picks the roundable edge whose mid point is nearest. ' +
          'Prefer this in parametric models: the feature history keeps the points, so the same edge is ' +
          're-selected after an upstream edit renumbers edges. Combines with edgeIndices.',
      )
      .optional(),
    radius: z.number().describe('Fillet radius in document units. Must be > 0.'),
  }),
  run: (doc, { id, edgeIndices = [], edgesNear = [], radius }, ctx): CommandResult =>
    modifyEdges(doc, ctx, {
      command: 'fillet_edge',
      pastTense: 'filleted',
      amountName: 'radius',
      amount: radius,
      id,
      edges: edgeIndices,
      near: edgesNear,
      recipe: (source, edges) => ({ op: 'fillet', source, edges: [...edges], size: radius }),
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
    'Bevel (chamfer) exact B-rep edges of a 3D solid entity and replace it with a new mesh entity ' +
    'that keeps the exact construction (its brep recipe). The source entity is consumed. ' +
    'Select edges with edgeIndices (indices from inspect_topology) and/or edgesNear (points near the edges, ' +
    'robust to parametric edits); with neither, ALL edges are chamfered. ' +
    `Requires a geometry kernel that supports chamfers (${OCC_KERNEL_HINT}); ` +
    'with the default Manifold kernel this command gracefully no-ops. ' +
    'Target must be a 3D solid (box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution, or mesh — including boolean results).',
  params: z.object({
    id: z
      .string()
      .describe('Id of the 3D solid entity to chamfer. Must exist and be a 3D solid kind.'),
    edgeIndices: z
      .array(z.number().int().nonnegative())
      .describe(
        '0-based indices of the unique B-rep edges to chamfer, as listed by inspect_topology on the same entity ' +
          '(each edge counted once). Pass [] or omit (with no edgesNear) to chamfer ALL edges.',
      )
      .optional(),
    edgesNear: z
      .array(
        vec3(
          'A point [x, y, z] near the edge to chamfer (e.g. its mid point from inspect_topology).',
        ),
      )
      .describe(
        'Select edges by location: each point picks the roundable edge whose mid point is nearest. ' +
          'Prefer this in parametric models: the feature history keeps the points, so the same edge is ' +
          're-selected after an upstream edit renumbers edges. Combines with edgeIndices.',
      )
      .optional(),
    distance: z.number().describe('Chamfer distance in document units. Must be > 0.'),
  }),
  run: (doc, { id, edgeIndices = [], edgesNear = [], distance }, ctx): CommandResult =>
    modifyEdges(doc, ctx, {
      command: 'chamfer_edge',
      pastTense: 'chamfered',
      amountName: 'distance',
      amount: distance,
      id,
      edges: edgeIndices,
      near: edgesNear,
      recipe: (source, edges) => ({ op: 'chamfer', source, edges: [...edges], size: distance }),
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
      recipe: (source) => ({ op: 'shell', source, thickness }),
    }),
});
