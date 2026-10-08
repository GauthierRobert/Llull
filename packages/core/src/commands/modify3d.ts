/**
 * Fillet, chamfer and shell: the injected GeometryKernel rounds/bevels the exact edges of a 3D solid
 * (or hollows it) — on its B-rep, never on triangles; the source entity is replaced by a `mesh` entity
 * whose `brep` records the modification recipe. A null kernel result is a no-op.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity } from '../model/types';
import type { ShapeRecipe } from '../geometry/shapeRecipe';
import type { ShapeTopology } from '../geometry/kernel';
import { is3D } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
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
import { noop } from './noop';

/** Surface-neutral pointer to the B-rep kernel (browser URL flag or server env var). */
const OCC_KERNEL_HINT =
  'the OCC kernel (?kernel=occt in the browser, LLULL_KERNEL=occt on the server)';

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
  /** The modification node over the operand's exact recipe. */
  readonly recipe: (source: ShapeRecipe) => ShapeRecipe;
}

/**
 * Why `edges` cannot be selected on a shape of `topology` (out of range, repeated, seam or degenerate),
 * or null; a kernel without exact topology (null) cannot check, so it accepts.
 */
function edgeSelectionProblem(
  topology: ShapeTopology | null,
  edges: readonly number[],
): string | null {
  if (topology === null) return null;
  const count = topology.edges.length;
  const outOfRange = edges.filter((index) => index >= count);
  if (outOfRange.length > 0) {
    return `edge index ${outOfRange.join(', ')} out of range (the solid has ${count} edges, 0..${count - 1}; inspect_topology lists them)`;
  }
  const repeated = edges.filter((index, at) => edges.indexOf(index) !== at);
  if (repeated.length > 0) return `edge index ${[...new Set(repeated)].join(', ')} selected twice`;
  const unroundable = edges.filter((index) => {
    const edge = topology.edges[index];
    return edge !== undefined && (edge.seam || edge.degenerate);
  });
  return unroundable.length > 0
    ? `edge ${unroundable.join(', ')} is a seam or degenerate edge (no corner to round)`
    : null;
}

/**
 * Shared body of fillet_edge / chamfer_edge / shell_solid: validate, build the modification recipe on
 * the operand's exact shape (its real B-rep edges under OCC), replace the source by the result.
 */
function modifyEdges(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  { command, pastTense, amountName, amount, id, edges = [], recipe }: EdgeModification,
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
  const badEdges = edgeSelectionProblem(kernel.topology(sourceShape), edges);
  if (badEdges !== null)
    return noop(doc, `${command}: ${badEdges} on '${id}'; document unchanged.`);
  const result = evaluateRecipe(kernel, recipe(source));
  if (typeof result === 'string') {
    return noop(
      doc,
      `${command}: kernel does not support ${command} for this operand (returned null). Use ${OCC_KERNEL_HINT} or a different operand.`,
    );
  }

  const newId = nextId('mesh');
  const meshEntity = kernelResultEntity(newId, result, entity);
  const document = replaceEntities(doc, [id], meshEntity);
  return {
    document,
    summary: `${command}: ${pastTense} '${id}' (kind '${entity.kind}', ${amountName} ${amount}) → mesh '${newId}' (${result.mesh.indices.length / 3} triangles). Source entity consumed.${fallbackSuffix(kernel, [entity])}${topologySuffix(kernel, result.shape)}${referenceLossSuffix(doc, document)}`,
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
    'Round (fillet) exact B-rep edges of a 3D solid entity and replace it with a new mesh entity ' +
    'that keeps the exact construction (its brep recipe), so booleans, further fillets and STEP export ' +
    'still see true faces and edges. The source entity is consumed. ' +
    'edgeIndices selects which edges to fillet (indices from inspect_topology); omit or pass [] to fillet ALL edges. ' +
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
          '(each edge counted once). Pass [] or omit to fillet ALL edges.',
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
      edges: edgeIndices,
      recipe: (source) => ({ op: 'fillet', source, edges: edgeIndices, size: radius }),
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
    'edgeIndices selects which edges to chamfer (indices from inspect_topology); omit or pass [] to chamfer ALL edges. ' +
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
          '(each edge counted once). Pass [] or omit to chamfer ALL edges.',
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
      edges: edgeIndices,
      recipe: (source) => ({ op: 'chamfer', source, edges: edgeIndices, size: distance }),
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
