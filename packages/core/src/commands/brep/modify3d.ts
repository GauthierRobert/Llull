/**
 * Fillet, chamfer and shell: the injected GeometryKernel rounds/bevels the exact edges of a 3D solid (or hollows it) — on its B-rep, never
 * on triangles; the source entity is replaced by a `mesh` entity whose `brep` records the modification recipe. A null kernel result is a
 * no-op.
 */

import type { CadDocument, Vec3 } from '../../model/types';
import type { ShapeRecipe } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { selectEdges } from './edgeSelection';
import { currentContext } from '../context';
import type { ExecutionContext } from '../types';
import { kernelUnavailable } from '../kernelRefusal';
import { commitKernelResult, evaluateRecipe, operandRecipe } from './kernelShape';
import { noop } from '../noop';
import { FILLET_MODES, edgeLawSchema } from './filletSpec';
import { filletEach } from './filletEach';
import { OCC_KERNEL_HINT, modifyFailure, validateSolidTarget } from './modifyTarget';

interface EdgeModification {
  readonly command: 'fillet_edge' | 'chamfer_edge' | 'shell_solid';
  readonly pastTense: string;
  readonly amountName: 'radius' | 'distance' | 'thickness';
  readonly amount: number;
  readonly id: string;
  /** Selected unique-edge indices (fillet / chamfer); checked against the exact topology. */
  readonly edges?: readonly number[];
  /** Points naming edges by their nearest edge (`edgesNear`), resolved on the current solid. */
  readonly near?: readonly Vec3[];
  /** The modification node over the operand's exact recipe, the resolved edges and their mid points (empty when the kernel has no topology). */
  readonly recipe: (source: ShapeRecipe, edges: readonly number[], near: readonly Vec3[]) => ShapeRecipe;
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
  if (sourceShape === null)
    return noop(
      doc,
      `${command}: kernel could not build entity '${id}' (kind '${entity.kind}'). The entity may have degenerate geometry or an unsupported kind for this kernel.`,
    );
  const selection = selectEdges(kernel.topology(sourceShape), edges, near);
  if ('problem' in selection) return noop(doc, `${command}: ${selection.problem} on '${id}'; document unchanged.`);
  const topology = kernel.topology(sourceShape);
  const mids = selection.edges.map((index) => topology?.edges[index]?.mid);
  const modified = recipe(source, selection.edges, mids.every((mid): mid is Vec3 => mid !== undefined) ? mids : []);
  const result = evaluateRecipe(kernel, modified);
  if (typeof result === 'string') return noop(doc, modifyFailure(command, kernel, modified, result));
  const picked = near.length > 0 ? ` edgesNear selected edges ${selection.edges.join(', ')}.` : '';
  return commitKernelResult(
    doc,
    kernel,
    result,
    [entity],
    (newId, triangles) =>
      `${command}: ${pastTense} '${id}' (kind '${entity.kind}', ${amountName} ${amount}) → mesh '${newId}' (${triangles} triangles). Source entity consumed.${picked}`,
  );
}

/**
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
    'To give each edge its own radius (optionally varying along the edge) pass edges: [{ index | near, size, sizeEnd?, sizes? }] instead; ' +
    'mode "chord" reads every size as the chord between the tangent points (planar faces, converted per edge to a radius). ' +
    `Requires a geometry kernel that supports fillets (${OCC_KERNEL_HINT}). ` +
    'With the default Manifold kernel, this command gracefully no-ops (returns unchanged doc). ' +
    'Target must be a 3D solid (box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution, or mesh — including boolean results).',
  params: z.object({
    id: z.string().describe('Id of the 3D solid entity to fillet. Must exist and be a 3D solid kind.'),
    edgeIndices: z
      .array(z.number().int().nonnegative())
      .describe(
        '0-based indices of the unique B-rep edges to fillet, as listed by inspect_topology on the same entity ' +
          '(each edge counted once). Pass [] or omit (with no edgesNear) to fillet ALL edges.',
      )
      .optional(),
    edgesNear: z
      .array(vec3('A point [x, y, z] near the edge to fillet (e.g. its mid point from inspect_topology).'))
      .describe(
        'Select edges by location: each point picks the roundable edge nearest to it (distance to the edge curve, so any point on an edge, e.g. its visible corner on a drawing, selects it). ' +
          'Prefer this in parametric models: the feature history keeps the points, so the same edge is ' +
          're-selected after an upstream edit renumbers edges. Combines with edgeIndices.',
      )
      .optional(),
    radius: z
      .number()
      .describe('Fillet radius in document units. Must be > 0. Required unless edges is given (then each entry carries its own size).')
      .optional(),
    radiusEnd: z
      .number()
      .describe(
        'Variable fillet: radius at the END of each selected edge (> 0); the radius varies linearly ' +
          'from radius at the edge start to radiusEnd. Omit for a constant radius.',
      )
      .optional(),
    edges: z
      .array(edgeLawSchema)
      .describe(
        'Per-edge radii: each entry names ONE edge (index, or near = a point on it) and gives its own radius law (size, optional sizeEnd for a ' +
          'linear variation along the edge, optional sizes control points). Edges listed here are rounded in one operation; use it INSTEAD OF ' +
          'radius / radiusEnd / edgeIndices / edgesNear. Differing radii need a kernel that reads radius laws (native OCC); equal ones work everywhere exact.',
      )
      .optional(),
    mode: z
      .enum(FILLET_MODES)
      .describe(
        '"radius" (default): sizes are radii. "chord": sizes (radius, radiusEnd, edges[].size...) are the CHORD length between the two tangent ' +
          'points of the round on the faces at the edge; converted per edge to r = c / (2 cos(theta / 2)) for planar faces meeting at wedge angle theta ' +
          '(a right-angle edge: r = c / sqrt 2). Needs an exact kernel and two planar faces at every edge.',
      )
      .optional(),
  }),
  run: (doc, { id, edgeIndices = [], edgesNear = [], radius, radiusEnd, edges, mode = 'radius' }, ctx): CommandResult => {
    if (edges !== undefined || mode === 'chord')
      return filletEach(doc, ctx, { id, mode, edges, edgeIndices, edgesNear, radius, radiusEnd });
    if (radius === undefined) return noop(doc, 'fillet_edge: give radius (or edges with one size per edge); document unchanged.');
    if (radiusEnd !== undefined && !(radiusEnd > 0)) return noop(doc, `fillet_edge: radiusEnd must be > 0 (got ${radiusEnd}).`);
    return modifyEdges(doc, ctx, {
      command: 'fillet_edge',
      pastTense: 'filleted',
      amountName: 'radius',
      amount: radius,
      id,
      edges: edgeIndices,
      near: edgesNear,
      recipe: (source, edgeList, near) => ({
        op: 'fillet',
        source,
        edges: [...edgeList],
        size: radius,
        ...(near.length > 0 ? { near } : {}),
        ...(radiusEnd === undefined ? {} : { sizeEnd: radiusEnd }),
      }),
    });
  },
});

/**
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
    id: z.string().describe('Id of the 3D solid entity to chamfer. Must exist and be a 3D solid kind.'),
    edgeIndices: z
      .array(z.number().int().nonnegative())
      .describe(
        '0-based indices of the unique B-rep edges to chamfer, as listed by inspect_topology on the same entity ' +
          '(each edge counted once). Pass [] or omit (with no edgesNear) to chamfer ALL edges.',
      )
      .optional(),
    edgesNear: z
      .array(vec3('A point [x, y, z] near the edge to chamfer (e.g. its mid point from inspect_topology).'))
      .describe(
        'Select edges by location: each point picks the roundable edge nearest to it (distance to the edge curve, so any point on an edge, e.g. its visible corner on a drawing, selects it). ' +
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
      recipe: (source, edges, near) => ({ op: 'chamfer', source, edges: [...edges], size: distance, ...(near.length > 0 ? { near } : {}) }),
    }),
});

/**
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
    'By default the result has a sealed internal cavity; pass openFacesNear (points on the faces to remove) for an open-topped shell. ' +
    'Requires a geometry kernel that supports shellSolid; a kernel without it (or a solid that is too ' +
    'thin for the thickness) makes this a graceful no-op that leaves the document unchanged. ' +
    'Target must be a 3D solid (box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution or mesh).',
  params: z.object({
    id: z.string().describe('Id of the closed 3D solid entity to hollow. Must exist and be a 3D solid.'),
    thickness: z.number().describe("Wall thickness in document units. Must be > 0 and smaller than half the solid's thinnest dimension."),
    openFacesNear: z
      .array(vec3('A point [x, y, z] on or near the face to remove (e.g. its centre from inspect_topology).'))
      .describe(
        'Faces to leave OPEN (removed), picked by location: each point removes the face nearest to it, giving an open-topped box / pocket ' +
          'instead of a sealed internal cavity. Omit or pass [] for a sealed cavity. Needs the OCC kernel.',
      )
      .optional(),
  }),
  run: (doc, { id, thickness, openFacesNear = [] }, ctx): CommandResult =>
    modifyEdges(doc, ctx, {
      command: 'shell_solid',
      pastTense: 'shelled',
      amountName: 'thickness',
      amount: thickness,
      id,
      recipe: (source) => ({ op: 'shell', source, thickness, ...(openFacesNear.length > 0 ? { openNear: openFacesNear } : {}) }),
    }),
});
