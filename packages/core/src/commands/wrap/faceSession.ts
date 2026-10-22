/**
 * The shared front half of the face commands of 03 WRP (`unwrap_face`, `wrap_to_face`, `project_to_face`, `emboss_on_face`): open the solid's exact
 * shape, pick exactly one face (index, point or persistent name), read its surface, and turn a placement into the face chart.
 * @failure unknown id / not a solid / no kernel / no exact face queries / unbuildable solid / no or several faces picked / REF_LOST / non-developable face / unbuilt
 *   chart method / anchor off the face -> a coded rejection (the document is returned unchanged)
 */

import type { CadDocument, Entity, ShapeRecipe, Vec2, Vec3 } from '../../model/types';
import type { GeometryKernel, ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import type { FaceQueryPort, SurfaceParams } from '../../geometry/kernelPorts';
import { meshDiagonal } from '../../geometry/meshExtent';
import { operandRecipe } from '../../geometry/operandRecipe';
import { buildFaceChart, type FaceChart } from '../../geometry/wrapChart';
import { dot3 } from '../../lib/vec3';
import { is3D } from '../../model/types';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { commandError, noop, rejection } from '../noop';
import { pickFaces } from '../brep/faceReferences';
import type { CommandResult, ExecutionContext } from '../types';
import { DEFAULT_FIT_RATIO, MIN_FIT_TOLERANCE } from './constants';
import { wrapRejection } from './codes';

export interface FaceRefInput {
  readonly faceIndex?: number | undefined;
  readonly faceNear?: Vec3 | undefined;
  readonly faceName?: string | undefined;
}

export interface FaceSession {
  readonly command: string;
  readonly entity: Entity;
  readonly kernel: GeometryKernel;
  readonly query: FaceQueryPort;
  readonly source: ShapeRecipe;
  readonly shape: ShapeHandle;
  readonly topology: ShapeTopology | null;
  readonly face: number;
  /** Persistent name of the picked face when the kernel keeps history. */
  readonly faceName: string | undefined;
  readonly surface: SurfaceParams;
  readonly uvBounds: readonly [Vec2, Vec2];
  /** Diagonal of the solid's bounding box, document units. */
  readonly diagonal: number;
  readonly note: string;
}

export const isRejection = (value: FaceSession | CommandResult): value is CommandResult => 'summary' in value;

/** The context's kernel with exact face queries, else the reason it cannot work. */
export function exactKernel(
  doc: CadDocument,
  command: string,
  ctx: ExecutionContext | undefined,
): { kernel: GeometryKernel; query: FaceQueryPort } | CommandResult {
  const kernel = (ctx ?? currentContext()).kernel;
  if (kernel === null) return noop(doc, kernelUnavailable(command));
  if (kernel.faceQuery === undefined)
    return rejection(
      doc,
      `${command}: CMD_KERNEL_UNAVAILABLE — this kernel keeps no exact B-rep faces; use the native kernel (desktop default, LLULL_KERNEL=occt-native); no-op.`,
      commandError(
        'CMD_KERNEL_UNAVAILABLE',
        'Run in the desktop app or the llull CLI with the native kernel; the Manifold mesh kernel has no exact faces.',
      ),
    );
  return { kernel, query: kernel.faceQuery };
}

/** 1e-6 x the diagonal (>= 1e-7): the named default of D-WRP-4, in document units. */
export const defaultFitTolerance = (diagonal: number): number => Math.max(DEFAULT_FIT_RATIO * diagonal, MIN_FIT_TOLERANCE);

/** See the module comment. */
export function openFace(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  command: string,
  id: string,
  ref: FaceRefInput,
): FaceSession | CommandResult {
  const fail = (code: string, message: string, paths: string[] = [], ids: string[] = []): CommandResult =>
    wrapRejection(doc, command, code, message, ids, paths);
  const entity = doc.entities[id];
  if (entity === undefined) return fail('WRP_ENTITY_NOT_FOUND', `entity '${id}' not found`, ['id'], [id]);
  if (!is3D(entity) || entity.kind === 'instance')
    return fail('WRP_NOT_A_SOLID', `entity '${id}' (${entity.kind}) is not a 3D solid`, ['id'], [id]);
  const exact = exactKernel(doc, command, ctx);
  if ('summary' in exact) return exact;
  const { kernel, query } = exact;
  const source = operandRecipe(kernel, entity);
  const shape = kernel.evaluate(source);
  if (shape === null) return fail('WRP_KERNEL_BUILD_FAILED', `the kernel could not build '${id}' (kind '${entity.kind}')`, ['id'], [id]);
  const topology = kernel.topology(shape);
  if (ref.faceIndex === undefined && ref.faceNear === undefined && ref.faceName === undefined)
    return fail('WRP_FACE_NOT_FOUND', 'give face.faceNear (a point on the face), face.faceIndex or face.faceName', ['face']);
  const pick = pickFaces(kernel, shape, topology, {
    indices: ref.faceIndex === undefined ? [] : [ref.faceIndex],
    near: ref.faceNear === undefined ? [] : [ref.faceNear],
    names: ref.faceName === undefined ? undefined : [ref.faceName],
  });
  if ('problem' in pick) {
    if (pick.error !== undefined) return rejection(doc, `${command}: ${pick.error.code} — ${pick.problem} on '${id}'; no-op.`, pick.error);
    return fail('WRP_FACE_NOT_FOUND', `${pick.problem} on '${id}'`, ['face'], [id]);
  }
  let picked = pick.faces;
  if (picked.some((index) => index < 0) && ref.faceNear !== undefined) {
    // a point on an edge, a seam or a pole belongs to no single face: take the lowest-numbered face that contains it
    const near = ref.faceNear;
    const containing = Array.from({ length: topology?.faces.length ?? 0 }, (_, k) => k).filter(
      (k) => query.faceContains(shape, k, near, 1e-6 * Math.max(1, ...near.map(Math.abs))) === true,
    );
    if (containing[0] !== undefined) picked = [containing[0]];
  }
  if (picked.length !== 1 || (picked[0] as number) < 0)
    return fail('WRP_FACE_NOT_FOUND', `face must pick exactly one face (got ${picked.length})`, ['face'], [id]);
  const face = picked[0] as number;
  const geometry = query.faceGeometry(shape, face);
  if (geometry === null) return fail('WRP_FACE_NOT_FOUND', `face ${face} of '${id}' has no exact geometry`, ['face'], [id]);
  const mesh = kernel.tessellate(shape);
  const diagonal = mesh === null ? 1 : meshDiagonal(mesh);
  return {
    command,
    entity,
    kernel,
    query,
    source,
    shape,
    topology,
    face,
    faceName: pick.record?.[0] ?? (ref.faceName !== undefined ? ref.faceName : topology?.faces[face]?.name),
    surface: geometry.surface,
    uvBounds: geometry.uvBounds,
    diagonal,
    note: pick.note,
  };
}

export interface ResolvedChart {
  readonly chart: FaceChart;
  /** The anchor on the face (projected onto it). */
  readonly anchorOn: Vec3;
  readonly anchorChart: Vec2;
  /** Outward unit normal of the solid at the anchor. */
  readonly outward: Vec3;
  /** +1 when the outward normal agrees with the surface's Su x Sv at the anchor, -1 when it opposes it (a bore). */
  readonly orientation: 1 | -1;
  readonly method: 'develop';
}

export interface PlacementInput {
  readonly method?: 'develop' | 'geodesic' | 'parametric' | 'project' | undefined;
  readonly anchor?: { readonly chart?: Vec2 | undefined; readonly on?: Vec3 | undefined } | undefined;
  readonly angleDeg?: number | undefined;
  readonly mirror?: boolean | undefined;
}

/** True for a plane, cylinder or cone face. */
export const isDevelopableSurface = (surface: SurfaceParams): boolean =>
  surface.type === 'plane' || surface.type === 'cylinder' || surface.type === 'cone';

/**
 * The chart for `placement` on the session's face.
 * @failure non-developable face with develop -> WRP_FACE_NOT_DEVELOPABLE; any other method -> WRP_METHOD_UNAVAILABLE; anchor farther than 1e-3 x the solid diagonal from
 *   the face -> WRP_ANCHOR_OFF_FACE
 */
export function resolveChart(
  doc: CadDocument,
  session: FaceSession,
  placement: PlacementInput | undefined,
  nearHint: Vec3 | undefined,
): ResolvedChart | CommandResult {
  const { command, id } = { command: session.command, id: session.entity.id };
  const fail = (code: string, message: string, path: string): CommandResult => wrapRejection(doc, command, code, message, [id], [path]);
  const method = placement?.method ?? 'develop';
  if (!isDevelopableSurface(session.surface)) {
    return method === 'develop'
      ? fail(
          'WRP_FACE_NOT_DEVELOPABLE',
          `face ${session.face} is ${session.surface.type} (Gaussian curvature != 0): it cannot be developed without stretch`,
          'placement.method',
        )
      : fail('WRP_METHOD_UNAVAILABLE', `method '${method}' is not built yet`, 'placement.method');
  }
  if (method !== 'develop')
    return fail(
      'WRP_METHOD_UNAVAILABLE',
      `method '${method}' is not built yet; a plane, cylinder or cone develops exactly`,
      'placement.method',
    );
  const wanted = placement?.anchor?.on ?? nearHint;
  let probe: Vec3;
  if (wanted !== undefined) probe = wanted;
  else {
    const details = session.query.faceDetails(session.shape, { samples: 0 });
    probe = details?.[session.face]?.centroid ?? ([0, 0, 0] as Vec3);
  }
  const projected = session.query.projectOnFace(session.shape, session.face, [probe]);
  const hit = projected?.[0] ?? null;
  if (hit === null) return fail('WRP_ANCHOR_OFF_FACE', 'the anchor point could not be projected onto the face', 'placement.anchor.on');
  const tolerance = 1e-3 * session.diagonal;
  if (placement?.anchor?.on !== undefined && hit.distance > tolerance)
    return fail(
      'WRP_ANCHOR_OFF_FACE',
      `placement.anchor.on is ${hit.distance} ${doc.units} from the face (limit ${tolerance})`,
      'placement.anchor.on',
    );
  const anchorChart: Vec2 = placement?.anchor?.chart ?? [0, 0];
  const built = buildFaceChart(session.surface, {
    anchorChart,
    anchorOn: hit.point,
    angleDeg: placement?.angleDeg ?? 0,
    mirror: placement?.mirror ?? false,
  });
  if ('error' in built) return fail('WRP_ANCHOR_OFF_FACE', built.error, 'placement.anchor.on');
  const orientation = dot3(hit.normal, built.normalAt(built.anchorUv)) >= 0 ? 1 : -1;
  return { chart: built, anchorOn: hit.point, anchorChart, outward: hit.normal, orientation, method: 'develop' };
}
