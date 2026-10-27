/**
 * Linked sketch geometry (SC-S3): edges of a solid projected onto a sketch plane (`project`) or the points where they cross it
 * (`intersect`), kept linked by persistent edge names (SC-N1). Regeneration re-projects the named edges, so the sketch follows an
 * upstream edit; a name that is gone fails the step with REF_LOST and check_model reports the lost link. break_sketch_link freezes the
 * current geometry into the step, which then no longer depends on the solid.
 */

import type { CadDocument, Entity, Vec2, Vec3 } from '../../model/types';
import type { PlaneFrame, SketchLink } from '../../model/sketchPlanes';
import type { ShapeEdge } from '../../geometry/kernel';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { currentContext } from '../context';
import { changed, noop } from '../noop';
import { nextId } from '../../lib/id';
import { dot3, lerp3, sub3 } from '../../lib/vec3';
import { isRecord } from '../../lib/isRecord';
import { kernelUnavailable } from '../kernelRefusal';
import { newEntity } from '../entity/newEntity';
import { withEntities } from '../entity/entityOps';
import { operandRecipe } from '../../geometry/operandRecipe';
import { validateSolidTarget } from '../brep/modifyTarget';
import { pickEdges } from '../brep/edgeReferences';
import { fromPlane, placementOf, toPlane } from './sketchPlanes';
import { execute } from '../execute';

const LINK_COLOR = '#c08a2a';

type Mode = 'project' | 'intersect';

const pathOf = (edge: ShapeEdge): readonly Vec3[] => edge.samples ?? [edge.start, edge.end];

/** The plane-local outline of `edge` (project) or the points where it crosses the plane (intersect). @pure */
function sketchOf(frame: PlaneFrame, edge: ShapeEdge, mode: Mode): Vec2[] {
  const path = pathOf(edge);
  if (mode === 'project') return path.map((point) => toPlane(frame, point));
  const height = (point: Vec3): number => dot3(sub3(point, frame.origin), frame.normal);
  const crossings: Vec2[] = [];
  for (let k = 1; k < path.length; k++) {
    const [a, b] = [path[k - 1], path[k]];
    if (a === undefined || b === undefined) continue;
    const [ha, hb] = [height(a), height(b)];
    if (ha === hb || ha * hb > 0 || (hb === 0 && k < path.length - 1)) continue;
    crossings.push(toPlane(frame, lerp3(a, b, ha / (ha - hb))));
  }
  return crossings;
}

/** One 2D entity per projected edge (an open polyline) or per crossing point, placed on the plane. */
function entitiesOf(frame: PlaneFrame, sketches: readonly Vec2[][], mode: Mode): Entity[] {
  const { position, rotation } = placementOf(frame);
  if (mode === 'project')
    return sketches
      .filter((points) => points.length >= 2)
      .map((points) => newEntity('polyline', nextId('poly'), { points, closed: false }, position, LINK_COLOR, { rotation }));
  return sketches.flat().map((point) => newEntity('point', nextId('pt'), {}, fromPlane(frame, point), LINK_COLOR, { rotation }));
}

interface ProjectRequest {
  readonly plane: string;
  readonly id: string;
  readonly mode: Mode;
  readonly edgeIndices: readonly number[];
  readonly edgesNear: readonly Vec3[];
  readonly edgeNames: readonly string[] | undefined;
  readonly frozen: readonly Vec2[][] | undefined;
}

function project(doc: CadDocument, ctx: ExecutionContext | undefined, request: ProjectRequest): CommandResult {
  const fail = (why: string): CommandResult => noop(doc, `project_edges_to_sketch: ${why}; document unchanged.`);
  const plane = doc.sketchPlanes?.[request.plane];
  if (plane === undefined) return fail(`no sketch plane '${request.plane}'`);
  if (request.frozen !== undefined) {
    const created = entitiesOf(
      plane.frame,
      request.frozen.map((points) => [...points]),
      request.mode,
    );
    return created.length === 0
      ? fail('frozen geometry is empty')
      : changed(
          withEntities(doc, created),
          `project_edges_to_sketch: ${created.length} frozen (unlinked) sketch entit${created.length === 1 ? 'y' : 'ies'} on '${plane.name}'.`,
          created.map((entity) => entity.id),
        );
  }
  const validation = validateSolidTarget(doc, 'project_edges_to_sketch', request.id);
  if ('summary' in validation) return validation;
  const kernel = (ctx ?? currentContext()).kernel;
  if (!kernel) return noop(doc, kernelUnavailable('project_edges_to_sketch'));
  const shape = kernel.evaluate(operandRecipe(kernel, validation.entity));
  const topology = shape === null ? null : kernel.topology(shape);
  if (topology === null) return fail('projecting edges needs the exact B-rep edges of the native kernel');
  const pick = pickEdges(topology, { indices: request.edgeIndices, near: request.edgesNear, names: request.edgeNames });
  if ('problem' in pick) return pick.error === undefined ? fail(pick.problem) : { ...fail(pick.problem), error: pick.error };
  const edges = (pick.edges.length === 0 ? topology.edges.map((edge) => edge.index) : pick.edges).flatMap((index) => {
    const edge = topology.edges[index];
    return edge === undefined || edge.degenerate ? [] : [edge];
  });
  const created = entitiesOf(
    plane.frame,
    edges.map((edge) => sketchOf(plane.frame, edge, request.mode)),
    request.mode,
  );
  if (created.length === 0) return fail(request.mode === 'intersect' ? 'no picked edge crosses the plane' : 'no edge to project');
  const names = request.edgeNames ?? pick.record ?? [];
  const links = Object.fromEntries(
    created.map((entity): [string, SketchLink] => [
      entity.id,
      { id: entity.id, planeId: plane.id, source: { entityId: request.id, edgeNames: names }, mode: request.mode },
    ]),
  );
  const document = { ...withEntities(doc, created), sketchLinks: { ...(doc.sketchLinks ?? {}), ...links } };
  const verb = request.mode === 'project' ? 'projected' : 'cut';
  const result = changed(
    document,
    `project_edges_to_sketch: ${verb} ${edges.length} edge(s) of '${request.id}' into ${created.length} linked entit${created.length === 1 ? 'y' : 'ies'} on '${plane.name}'.${pick.note}`,
    created.map((entity) => entity.id),
  );
  return pick.record === null || request.edgeNames !== undefined ? result : { ...result, recordExtras: { edgeNames: pick.record } };
}

/**
 * @affects creates linked 2D entities on the sketch plane (doc.sketchLinks)
 * @failure unknown plane, non-solid source, no exact kernel, lost / split edge name (REF_LOST / REF_SPLIT), nothing to draw -> no-op
 */
export const projectEdgesToSketch = defineCommand({
  name: 'project_edges_to_sketch',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  description:
    'Bring edges of a 3D solid into a sketch plane as LINKED 2D geometry: mode "project" draws each edge projected onto the plane (an open ' +
    'polyline), mode "intersect" puts a point where each edge crosses the plane. Pick edges by edgeIndices / edgesNear / edgeNames (none = all). ' +
    'The link follows the edges by their persistent names on regeneration; a lost edge fails the step (REF_LOST) and check_model reports ' +
    'sketch_link_lost. break_sketch_link freezes the geometry. Needs the native kernel.',
  params: z.object({
    plane: z.string().describe('Sketch plane id (create_sketch_plane).'),
    id: z.string().describe('Id of the 3D solid whose edges are used.').optional(),
    mode: z
      .enum(['project', 'intersect'])
      .describe('"project" (default): edges projected onto the plane; "intersect": their crossing points.')
      .optional(),
    edgeIndices: z.array(z.number().int().nonnegative()).describe('0-based edge indices (inspect_topology).').optional(),
    edgesNear: z.array(vec3('A point [x, y, z] near the edge.')).describe('Edges picked by location.').optional(),
    edgeNames: z.array(z.string().min(1)).describe('Persistent edge names (recorded automatically).').optional(),
    frozen: z
      .array(z.array(z.array(z.number()).length(2)))
      .describe('Set by break_sketch_link: plane-local geometry drawn as is, with no link to a solid.')
      .optional(),
  }),
  run: (doc, { plane, id = '', mode = 'project', edgeIndices = [], edgesNear = [], edgeNames, frozen }, ctx): CommandResult =>
    project(doc, ctx, { plane, id, mode, edgeIndices, edgesNear, edgeNames, frozen: frozen as Vec2[][] | undefined }),
});

/**
 * @affects rewrites the project_edges_to_sketch step that made `id` with its current geometry frozen, removes its links, regenerates
 * @failure `id` not a linked sketch entity, its step not found -> no-op
 */
export const breakSketchLink = defineCommand({
  name: 'break_sketch_link',
  annotations: { metaHistory: true },
  description:
    'Break the link of projected sketch geometry: the project_edges_to_sketch step that made the entity is rewritten with its current ' +
    'plane-local geometry frozen, so later edits of the solid no longer move or fail it. All entities of that step are unlinked.',
  params: z.object({ id: z.string().describe('Id of a linked sketch entity (doc.sketchLinks).') }),
  run: (doc, { id }, ctx): CommandResult => {
    const link = doc.sketchLinks?.[id];
    if (link === undefined) return noop(doc, `break_sketch_link: '${id}' is not linked sketch geometry; document unchanged.`);
    const step = doc.featureHistory.find((entry) => entry.name === 'project_edges_to_sketch' && entry.affected?.includes(id));
    if (step === undefined || !isRecord(step.params))
      return noop(doc, `break_sketch_link: the step that made '${id}' is not in the history; document unchanged.`);
    const frozen = (step.affected ?? []).map((entityId) => {
      const entity = doc.entities[entityId];
      if (entity?.kind === 'polyline') return entity.points.map(([x, y]): Vec2 => [x, y]);
      const plane = doc.sketchPlanes?.[link.planeId];
      return entity?.kind === 'point' && plane !== undefined ? [toPlane(plane.frame, entity.position)] : [];
    });
    const params = {
      plane: step.params['plane'],
      mode: step.params['mode'] ?? 'project',
      frozen: link.mode === 'intersect' ? [frozen.flat()] : frozen,
    };
    const edited = execute(doc, 'edit_step_params', { stepId: step.id, params }, ctx ?? currentContext());
    if (edited.document === doc) return edited;
    const remaining = Object.fromEntries(
      Object.entries(edited.document.sketchLinks ?? {}).filter(([key]) => !(step.affected ?? []).includes(key)),
    );
    return changed(
      { ...edited.document, sketchLinks: remaining },
      `break_sketch_link: froze ${frozen.length} entit${frozen.length === 1 ? 'y' : 'ies'} of ${step.id}; no longer linked to '${link.source.entityId}'.`,
      [...(step.affected ?? [])],
    );
  },
});
