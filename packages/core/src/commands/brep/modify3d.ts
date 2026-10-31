/**
 * Fillet, chamfer and shell: the injected GeometryKernel rounds/bevels the exact edges of a 3D solid (or hollows it) — on its B-rep, never
 * on triangles; the source entity is replaced by a `mesh` entity whose `brep` records the modification recipe. A null kernel result is a
 * no-op.
 */

import type { CadDocument, Vec3 } from '../../model/types';
import type { ShapeRecipe } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { pickEdges } from './edgeReferences';
import { currentContext } from '../context';
import type { ExecutionContext } from '../types';
import { kernelUnavailable } from '../kernelRefusal';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { operandRecipe } from '../../geometry/operandRecipe';
import { noop } from '../noop';
import { FILLET_MODES, edgeLawSchema } from './filletSpec';
import { profileSchema } from './filletProfile';
import { cornerSchema } from './filletCorners';
import { filletEach } from './filletEach';
import { OCC_KERNEL_HINT, validateSolidTarget } from './modifyTarget';
import { blendRefusal } from './blendRefusal';
import { blendRejection } from './blendCodes';
import { partialSchema, refusePartial } from './filletPartial';
import { isSideProblem, sideFaces } from '../../geometry/blend/sides';
import type { GeometryKernel, ShapeTopology } from '../../geometry/kernel';
import type { ShapeHandle } from '../../geometry/kernelTypes';

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
  /** Persistent edge names recorded by an earlier run (SC-N1); win over `edges` / `near` when the kernel names its edges. */
  readonly names?: readonly string[] | undefined;
  /**
   * The modification node over the operand's exact recipe, the resolved edges and their mid points (empty when the kernel has no topology), or a
   * coded problem (BLD_*) found while resolving what the node needs from the exact shape.
   */
  readonly recipe: (
    source: ShapeRecipe,
    edges: readonly number[],
    near: readonly Vec3[],
    exact: { readonly kernel: GeometryKernel; readonly shape: ShapeHandle; readonly topology: ShapeTopology | null },
  ) => ShapeRecipe | RecipeProblem;
}

/** A refusal decided while building the recipe: stable code, message and the param path it is about. */
interface RecipeProblem {
  readonly code: 'BLD_ASYMMETRIC_SIDE_MISSING';
  readonly message: string;
  readonly path: string;
}

/**
 * Shared body of fillet_edge / chamfer_edge / shell_solid: validate, build the modification recipe on
 * the operand's exact shape (its real B-rep edges under OCC), replace the source by the result.
 */
function modifyEdges(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  { command, pastTense, amountName, amount, id, edges = [], near = [], names, recipe }: EdgeModification,
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
  const topology = kernel.topology(sourceShape);
  const selection = pickEdges(topology, { indices: edges, near, names });
  if ('problem' in selection) {
    const refused = noop(doc, `${command}: ${selection.problem} on '${id}'; document unchanged.`);
    return selection.error === undefined ? refused : { ...refused, error: selection.error };
  }
  const mids = selection.edges.map((index) => topology?.edges[index]?.mid);
  const built = recipe(source, selection.edges, mids.every((mid): mid is Vec3 => mid !== undefined) ? mids : [], {
    kernel,
    shape: sourceShape,
    topology,
  });
  if ('code' in built) return blendRejection(doc, command, built.code, built.message, [id], [built.path]);
  const modified = built;
  const result = evaluateRecipe(kernel, modified);
  if (typeof result === 'string') return blendRefusal(doc, command, id, kernel, modified, result, topology);
  const picked = near.length > 0 ? ` edgesNear selected edges ${selection.edges.join(', ')}.` : '';
  const committed = commitKernelResult(
    doc,
    kernel,
    result,
    [entity],
    (newId, triangles) =>
      `${command}: ${pastTense} '${id}' (kind '${entity.kind}', ${amountName} ${amount}) → mesh '${newId}' (${triangles} triangles). Source entity consumed.${picked}${selection.note}`,
  );
  return selection.record === null || committed.document === doc
    ? committed
    : { ...committed, recordExtras: { edgeNames: selection.record } };
}

/**
 * @affects removes source entity; creates 1 mesh entity with rounded edges
 * @invariant target must be a 3D solid; radius > 0; geometry kernel must be injected
 * @failure missing id, 2D kind, radius ≤ 0, kernel absent, or kernel null → no-op, affected:[]; partial -> BLD_PARTIAL_UNSUPPORTED (a valid range) or BLD_LAW_INVALID (a bad range), see filletPartial.ts
 */
export const filletEdge = defineCommand({
  name: 'fillet_edge',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  description:
    'Round (fillet) exact B-rep edges of a 3D solid entity and replace it with a new mesh entity ' +
    'that keeps the exact construction (its brep recipe), so booleans, further fillets and STEP export ' +
    'still see true faces and edges. The source entity is consumed. ' +
    'Select edges with edgeIndices (indices from inspect_topology) and/or edgesNear (points near the edges, ' +
    'robust to parametric edits); with neither, ALL edges are filleted. ' +
    'To give each edge its own radius (optionally varying along the edge) pass edges: [{ index | near, size, sizeEnd?, sizes?, interpolation?, law? }] instead. ' +
    'A radius law runs from size at the start of the edge to sizeEnd at its end, through sizes control points ({ t in (0, 1) along the picked edge, size }): ' +
    'interpolation "smooth" (default) passes one smooth curve through them with zero slope at the ends, "monotone" is a C1 cubic that never overshoots a station, "linear" joins them with straight pieces; ' +
    'or law { expression of t in [0, 1] (pi, cos, ...), samples } sampled at uniform t. On a CLOSED edge (a cylinder rim) the law must close on itself (r(0) = r(1), BLD_LAW_NOT_PERIODIC otherwise). ' +
    'corners [{ near | name | all, type: "setback", setback }] gives a vertex a setback corner instead of the rolling-ball one. A bad value is BLD_LAW_INVALID with the param path; run check_blends afterwards to read the realised radius back. ' +
    'profile { type: "conic", rho } or { type: "curvature", shape } changes the cross-section (conic: rho 0.4142 is the circle at 90 degrees; curvature: zero curvature at both contacts, G2 to planar faces); ' +
    'size2 (+ side1Near | side1Name) makes the blend asymmetric: size and size2 are then the two LEGS (tangent distances from the edge on each face; straight edge between planar faces, one constant size). ' +
    'A profile blend keeps the contact lines of the circular fillet of the same size, so it is built on straight or curved edges between planar or curved faces (a cylinder rim, a boss on a plate, a rounded outline) and with a size that varies (radiusEnd, edges[].sizes / law); ' +
    'it ends on a flat face square to it, on the next blend of a tangent chain, or closes on itself, and edges that meet at a vertex must all be profiled in the same step with the same section (they get a smooth G1 corner patch: straight convex edges between planar faces). A curvature profile matches the curvature of its faces (G2 to a planar one); where two blends of a chain meet over faces whose curvature jumps it falls back to the G1 quartic for that chain, and says so (summary and data.profile.fallback names the edges), so G2 holds except at reported fallbacks. Edges that meet at a vertex need one constant size (a varying size has no corner patch). The result reports the measured gap to the neighbouring faces and the corner setbacks it chose (data.profile); a blend that meets its faces only to more than 0.95 x 5e-6 x the bounding-box diagonal, or whose chain blends meet at more than 0.0095 rad, 0.95 x the check_blends G1 default (data.profile.junctionG1 reports the largest angle), beyond the crease of the part, is refused with the measured value (a conic whose junctions would kink first fades to the circular arc at the ends that meet the next blend, which is G1 there whatever the curvature of the walls does, and says so: data.profile.circularFade; a curvature profile has no such fade), so fillet_edge never returns a profile shape its own check_blends default fails. A tangent chain that turns across creases of up to about 0.1 rad (the rim of an N-gon prism, a polyline outline: OCCT chains them) is mitred: the blends end in the bisector plane of their section planes over planar supports, and data.profile.creaseRad reports the crease; a varying size on such a chain, a curved support at a crease, a crease OCCT does not chain (0.1 rad or more: the blend then runs out onto the next face) is refused with the measured reason. ' +
    'BLD_PROFILE_FAILED says which condition fails; rho / shape outside [0.05, 0.95] is BLD_RHO_RANGE / BLD_SHAPE_RANGE. ' +
    'mode "chord" reads every size as the chord between the two tangent points of the round (planar faces: closed form; any other pair, e.g. a cylinder rim against its cap: the wedge angle sampled along the edge; BLD_CHORD_UNDEFINED where the faces are tangent). ' +
    `Needs the exact kernel (check kernel_info): ${OCC_KERNEL_HINT}. ` +
    'With the mesh kernel it no-ops (unchanged doc). ' +
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
      .array(vec3('A point [x, y, z] in document units near the edge to fillet (e.g. its mid point from inspect_topology).'))
      .describe(
        'Select edges by location: each point picks the roundable edge nearest to it (distance to the edge curve, so any point on an edge, e.g. its visible corner on a drawing, selects it). ' +
          'Prefer this in parametric models: the feature history keeps the points, so the same edge is ' +
          're-selected after an upstream edit renumbers edges. Combines with edgeIndices.',
      )
      .optional(),
    edgeNames: z
      .array(z.string().min(1))
      .describe(
        'Persistent edge names (inspect_topology lists them on the native kernel): recorded automatically from the first pick and used on regeneration, so the same ' +
          'edge is rounded after an upstream edit; a name that is gone or split refuses the step (REF_LOST / REF_SPLIT). Wins over edgeIndices / edgesNear.',
      )
      .optional(),
    radius: z
      .number()
      .describe('Fillet radius in document units. Must be > 0. Required unless edges is given (then each entry carries its own size).')
      .optional(),
    radiusEnd: z
      .number()
      .describe(
        'Variable fillet: radius at the END of each selected edge (> 0), document units; the radius varies from radius at the edge start to radiusEnd ' +
          '(the kernel smooth transition, flattened at both ends; use edges[] with interpolation "linear" for a straight one). Omit for a constant radius. Not allowed on a closed edge unless equal to radius (BLD_LAW_NOT_PERIODIC).',
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
    corners: z
      .array(cornerSchema)
      .describe(
        'Corner treatment per vertex (default everywhere: the kernel rolling-ball corner). { near | name | all: true, type: "setback", setback } stops the blend of every edge meeting at the vertex setback away from it (measured along the edge, document units) and fills the corner with a smooth patch (G1 to the blends and the faces); setbacks [{ near | name, distance }] overrides single edges. ' +
          'It also completes a vertex of 4 or more rounded edges (a pyramid apex). Every edge meeting at a setback vertex must be rounded in this step, and every rounded edge must end at a setback vertex (its other end may be a vertex closed by one flat face, e.g. the base of a pyramid edge); a setback corner cannot be mixed with rolling_ball vertices on the same rounded edges. This build makes it for straight edges between planar faces with a constant radius, or one that is linear from size to sizeEnd (edges[] with interpolation "linear"; the smooth radiusEnd is refused) (convex edges, or concave edges which get material added; a vertex with both kinds is refused) (BLD_CORNER_UNSUPPORTED says which condition fails). ' +
          'A setback no longer than the distance the blends reach is BLD_SETBACK_TOO_SHORT with the minimum. Vertices are recorded by persistent name "v(<edge names>)".',
      )
      .optional(),
    profile: profileSchema.optional(),
    partial: partialSchema.optional(),
    mode: z
      .enum(FILLET_MODES)
      .describe(
        '"radius" (default): sizes are radii. "chord": sizes (radius, radiusEnd, edges[].size...) are the CHORD length between the two tangent ' +
          'points of the round on the faces at the edge; converted per edge to r = c / (2 cos(theta / 2)) for planar faces meeting at wedge angle theta ' +
          '(a right-angle edge: r = c / sqrt 2); other face pairs use the wedge angle sampled along the edge. Needs an exact kernel.',
      )
      .optional(),
  }),
  run: (
    doc,
    { id, edgeIndices = [], edgesNear = [], edgeNames, radius, radiusEnd, edges, mode = 'radius', profile, corners, partial },
    ctx,
  ): CommandResult => {
    const target = validateSolidTarget(doc, 'fillet_edge', id);
    if ('summary' in target) return target;
    const refused = refusePartial(doc, id, partial);
    if (refused !== null) return refused;
    if (edges !== undefined || mode === 'chord' || radiusEnd !== undefined || profile !== undefined || corners !== undefined)
      return filletEach(doc, ctx, { id, mode, edges, edgeIndices, edgesNear, radius, radiusEnd, edgeNames, profile, corners });
    if (radius === undefined) return noop(doc, 'fillet_edge: give radius (or edges with one size per edge); document unchanged.');
    return modifyEdges(doc, ctx, {
      command: 'fillet_edge',
      pastTense: 'filleted',
      amountName: 'radius',
      amount: radius,
      id,
      edges: edgeIndices,
      near: edgesNear,
      names: edgeNames,
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
 * @invariant target must be a 3D solid; distance > 0; geometry kernel must be injected; distance2 / angleDeg (exactly one) need side1Near or side1Name; distanceEnd (variable chamfer) is symmetric, needs listed edges and is built only by the native kernel
 * @failure missing id, 2D kind, distance ≤ 0, kernel absent, or kernel null → no-op, affected:[]; BLD_CHAMFER_PARAMS, BLD_CHAMFER_ANGLE_RANGE, BLD_ASYMMETRIC_SIDE_MISSING → coded rejection; distanceEnd with distance2 / angleDeg, <= 0 or without listed edges → BLD_CHAMFER_VARIABLE_PARAMS; a variable chamfer the kernel cannot build → BLD_CHAMFER_FAILED with the reason
 */
export const chamferEdge = defineCommand({
  name: 'chamfer_edge',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  description:
    'Bevel (chamfer) exact B-rep edges of a 3D solid entity and replace it with a new mesh entity ' +
    'that keeps the exact construction (its brep recipe). The source entity is consumed. ' +
    'Select edges with edgeIndices (indices from inspect_topology) and/or edgesNear (points near the edges, ' +
    'robust to parametric edits); with neither, ALL edges are chamfered. ' +
    'distance alone is a symmetric chamfer (equal legs on both faces). Asymmetric: add distance2 (second leg, document units) OR angleDeg ' +
    '(degrees, 0..90 exclusive, measured on the side1 face between that face and the chamfer; on a right-angle edge the second leg is distance * tan(angle)), together with side1Near (a point on the ' +
    'face that carries distance) or side1Name (persistent face name); for each selected edge the one of its two faces nearest to the point is side 1. ' +
    'distanceEnd makes the distance vary linearly from distance at the edge start to distanceEnd at its end (a variable chamfer: listed edges that share no vertex, flat square ends, not a closed edge; the exact native kernel builds it as a loft of the sections: a ruled one on a straight edge between planes, a smooth one on a curved edge, an arc or a B-spline between any two faces, with the legs measured on each face from the edge in the plane perpendicular to it). ' +
    'Asymmetric and variable: add distance2 (the leg on the other face at the edge start) and distance2End (at its end) with side1Near / side1Name, so the leg on side 1 runs distance -> distanceEnd and the other leg distance2 -> distance2End (angleDeg is for a constant chamfer). Edges that meet at a vertex need constant distances (a variable chamfer has no corner patch: BLD_CHAMFER_FAILED names it). ' +
    `Needs the exact kernel (check kernel_info): ${OCC_KERNEL_HINT}; ` +
    'with the mesh kernel it no-ops. ' +
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
      .array(vec3('A point [x, y, z] in document units near the edge to chamfer (e.g. its mid point from inspect_topology).'))
      .describe(
        'Select edges by location: each point picks the roundable edge nearest to it (distance to the edge curve, so any point on an edge, e.g. its visible corner on a drawing, selects it). ' +
          'Prefer this in parametric models: the feature history keeps the points, so the same edge is ' +
          're-selected after an upstream edit renumbers edges. Combines with edgeIndices.',
      )
      .optional(),
    edgeNames: z
      .array(z.string().min(1))
      .describe(
        'Persistent edge names (inspect_topology lists them on the native kernel): recorded automatically from the first pick and used on regeneration, so the same ' +
          'edge is rounded after an upstream edit; a name that is gone or split refuses the step (REF_LOST / REF_SPLIT). Wins over edgeIndices / edgesNear.',
      )
      .optional(),
    distance: z
      .number()
      .describe(
        'Chamfer distance in document units. Must be > 0. With distance2 or angleDeg it is the leg on the side1 face; alone it is the leg on both faces.',
      ),
    distance2: z
      .number()
      .describe(
        'Second leg in document units (> 0), on the face that is not side 1 (distance-distance chamfer). Needs side1Near or side1Name. Exclusive with angleDeg.',
      )
      .optional(),
    angleDeg: z
      .number()
      .describe(
        'Chamfer angle in degrees, strictly between 0 and 90, measured on the side1 face from that face to the chamfer (distance-angle chamfer). Needs side1Near or side1Name. Exclusive with distance2.',
      )
      .optional(),
    side1Near: vec3(
      'A point [x, y, z] in document units on the face that carries distance (side 1) when distance2 or angleDeg is given.',
    ).optional(),
    side1Name: z
      .string()
      .min(1)
      .describe('Persistent face name of side 1 (inspect_topology lists face names on the native kernel); alternative to side1Near.')
      .optional(),
    distance2End: z
      .number()
      .describe(
        'Variable asymmetric chamfer: the second leg (on the face that is not side 1) at the END of each selected edge (> 0, document units); it runs linearly from distance2 at the edge start. Needs distanceEnd, distance2 and side1Near / side1Name; not with angleDeg.',
      )
      .optional(),
    distanceEnd: z
      .number()
      .describe(
        'Variable chamfer: the distance (the leg on side 1 when distance2 is given) at the END of each selected edge (> 0, document units); the distance runs linearly from distance at the edge start to distanceEnd (the removed volume of a right-angle edge is 1/2 x integral of d1(s) d2(s) ds). ' +
          'The start of an edge is its own start point (inspect_topology lists start and end of every edge). The edges must be listed (edgeIndices / edgesNear / edgeNames), straight or curved (an arc, a B-spline) between any two faces, not closed, ending on flat faces square to the edge; edges that meet at a vertex (the corner of a box with three edges) may be listed together when all are convex or all concave: the chamfer faces then meet along the mitre lines of their surfaces, without a separate corner face; with distance2 give distance2End too, not angleDeg. Omit for a constant chamfer. Chamfers that need other shapes are BLD_CHAMFER_FAILED with the reason.',
      )
      .optional(),
  }),
  run: (
    doc,
    { id, edgeIndices = [], edgesNear = [], edgeNames, distance, distance2, angleDeg, side1Near, side1Name, distanceEnd, distance2End },
    ctx,
  ): CommandResult => {
    const sided = distance2 !== undefined || angleDeg !== undefined;
    if (distance2 !== undefined && angleDeg !== undefined)
      return blendRejection(doc, 'chamfer_edge', 'BLD_CHAMFER_PARAMS', 'give distance2 or angleDeg, not both', [id], ['angleDeg']);
    if (!sided && (side1Near !== undefined || side1Name !== undefined))
      return blendRejection(
        doc,
        'chamfer_edge',
        'BLD_CHAMFER_PARAMS',
        'side1Near / side1Name apply only with distance2 or angleDeg',
        [id],
        ['side1Near'],
      );
    if (distanceEnd !== undefined || distance2End !== undefined) {
      const unlisted = edgeIndices.length + edgesNear.length + (edgeNames?.length ?? 0) === 0;
      const found: readonly [string, string] | null =
        distanceEnd === undefined
          ? ['distance2End', 'distance2End needs distanceEnd (a variable chamfer runs from distance to distanceEnd)']
          : angleDeg !== undefined
            ? ['angleDeg', 'a variable chamfer takes distance2 and distance2End for its second leg, not angleDeg']
            : distance2 !== undefined && distance2End === undefined
              ? ['distance2End', 'a variable chamfer with distance2 needs distance2End (the second leg at the end of the edge)']
              : distance2 === undefined && distance2End !== undefined
                ? ['distance2End', 'distance2End needs distance2 (the second leg at the start of the edge)']
                : !(distanceEnd > 0)
                  ? ['distanceEnd', `distanceEnd must be > 0 (got ${distanceEnd})`]
                  : distance2End !== undefined && !(distance2End > 0)
                    ? ['distance2End', `distance2End must be > 0 (got ${distance2End})`]
                    : unlisted
                      ? [
                          'edgeIndices',
                          'a variable chamfer needs its edges listed (edgeIndices, edgesNear or edgeNames), not every edge of the solid',
                        ]
                      : null;
      if (found !== null) return blendRejection(doc, 'chamfer_edge', 'BLD_CHAMFER_VARIABLE_PARAMS', found[1], [id], [found[0]]);
    }
    if (angleDeg !== undefined && !(angleDeg > 0 && angleDeg < 90))
      return blendRejection(
        doc,
        'chamfer_edge',
        'BLD_CHAMFER_ANGLE_RANGE',
        `angleDeg must be strictly between 0 and 90 (got ${angleDeg})`,
        [id],
        ['angleDeg'],
      );
    if (distance2 !== undefined && !(distance2 > 0))
      return blendRejection(doc, 'chamfer_edge', 'BLD_CHAMFER_PARAMS', `distance2 must be > 0 (got ${distance2})`, [id], ['distance2']);
    if (sided && side1Near === undefined && side1Name === undefined)
      return blendRejection(
        doc,
        'chamfer_edge',
        'BLD_ASYMMETRIC_SIDE_MISSING',
        'distance2 / angleDeg need to know which face carries distance',
        [id],
        ['side1Near'],
      );
    return modifyEdges(doc, ctx, {
      command: 'chamfer_edge',
      pastTense: 'chamfered',
      amountName: 'distance',
      amount: distance,
      id,
      edges: edgeIndices,
      near: edgesNear,
      names: edgeNames,
      recipe: (source, edges, near, exact) => {
        const base = {
          op: 'chamfer' as const,
          source,
          edges: [...edges],
          size: distance,
          ...(distanceEnd === undefined ? {} : { sizeEnd: distanceEnd }),
          ...(distance2End === undefined ? {} : { size2End: distance2End }),
          ...(near.length > 0 ? { near } : {}),
        };
        if (!sided) return base;
        const faces =
          exact.topology === null
            ? {
                code: 'BLD_ASYMMETRIC_SIDE_MISSING' as const,
                message: 'this kernel has no exact topology to tell the faces of an edge apart',
              }
            : sideFaces(exact.kernel, exact.shape, exact.topology, edges, { near: side1Near, name: side1Name });
        if (isSideProblem(faces)) return { ...faces, path: side1Name === undefined ? 'side1Near' : 'side1Name' };
        return {
          ...base,
          faces: [...faces],
          ...(distance2 === undefined ? (angleDeg === undefined ? {} : { angleDeg }) : { size2: distance2 }),
        };
      },
    });
  },
});

/**
 * @affects removes source entity; creates 1 hollow mesh entity with walls of the given thickness
 * @invariant target must be a closed 3D solid; thickness > 0; geometry kernel must be injected
 * @failure missing id, 2D kind, thickness <= 0, kernel absent, or kernel null -> no-op, affected:[]
 */
export const shellSolid = defineCommand({
  name: 'shell_solid',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
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
