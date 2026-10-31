/**
 * The checks and the numbers of a modeled knurl (model geometry, 03 WRP M5) before the kernel is asked, shared by add_knurl (straight: knurlGeometry.ts, diagonal / diamond: knurlHelixCut.ts) and by its read-only
 * preview: the groove form (tooth angle, depth, land), the face (axial extent, outside cylinder), the free end caps and, for helical grooves, the kernel-time envelope.
 * @invariant a request that passes here is one the command builds up to the kernel call: the preview and the command cannot disagree on a refusal
 * @failure toothAngleDeg outside (0, 180), depth <= 0, a land under 2 % of the pitch, depth reaching half the radius, a face without axial extent, more grooves than the kernel envelope allows, a bore, a helical groove without a free
 *   end cap at both ends, hand with a diamond -> coded rejection of `command`
 */

import type { CadDocument, Vec3 } from '../../model/types';
import { dot3, sub3 } from '../../lib/vec3';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import type { FaceSession } from './faceSession';
import { DEFAULT_LAND_RATIO, DEFAULT_TOOTH_ANGLE_DEG, depthForLand, freeEnds, landFor, type KnurlShape } from './knurlGeometry';
import {
  estimatedKernelSeconds,
  grooveSpan,
  helicalDepthForLand,
  helicalLand,
  leadOf,
  MAX_KERNEL_SECONDS,
  type HelicalKnurl,
} from './knurlHelix';

export interface GeometryRequest {
  readonly id: string;
  readonly pattern: 'straight' | 'diagonal' | 'diamond';
  readonly depth?: number | undefined;
  readonly toothAngleDeg?: number | undefined;
  readonly hand?: 'right' | 'left' | undefined;
  /** Helix angle from the axis, degrees (diagonal and diamond; the default already applied). */
  readonly helixAngleDeg?: number | undefined;
}

interface PlanBase {
  readonly depth: number;
  readonly land: number;
  readonly toothAngleDeg: number;
  /** Axial extent of the face from the axis origin. */
  readonly from: number;
  readonly to: number;
  /** The cylinder axis (a point and the direction). */
  readonly origin: Vec3;
  readonly axis: Vec3;
}

export interface StraightPlan extends PlanBase {
  readonly kind: 'straight';
  readonly shape: KnurlShape;
  readonly pastFrom: boolean;
  readonly pastTo: boolean;
}

export interface HelicalPlan extends PlanBase {
  readonly kind: 'helical';
  readonly shape: HelicalKnurl;
  readonly span: ReturnType<typeof grooveSpan>;
  readonly grooves: number;
  readonly faceTurns: number;
  readonly seconds: number;
  readonly diamond: boolean;
}

/** An outside cylinder: the normal at a point of the face looks away from the axis. */
function isOutside(session: FaceSession): boolean {
  if (session.surface.type !== 'cylinder') return false;
  const sample = session.query.faceDetails(session.shape, { samples: 1 })?.[session.face]?.samples[0];
  const hit = sample === undefined ? null : (session.query.projectOnFace(session.shape, session.face, [sample])?.[0] ?? null);
  return hit !== null && dot3(hit.normal, sub3(hit.point, session.surface.origin)) > 0;
}

/** See the module comment. */
export function planKnurlGeometry(
  doc: CadDocument,
  command: string,
  params: GeometryRequest,
  session: FaceSession,
  knurl: { readonly teeth: number; readonly pitch: number },
): StraightPlan | HelicalPlan | CommandResult {
  const fail = (code: string, message: string, path: string): CommandResult =>
    wrapRejection(doc, command, code, message, [params.id], [path]);
  const { surface } = session;
  if (surface.type !== 'cylinder') return fail('WRP_KNURL_FACE_NOT_CYLINDER', 'not a cylinder', 'face');
  const helical = params.pattern !== 'straight';
  const diamond = params.pattern === 'diamond';
  const helix = params.helixAngleDeg ?? 0;
  if (diamond && params.hand !== undefined)
    return fail('WRP_PARAM_INVALID', 'hand goes with the diagonal pattern; a diamond has both hands', 'hand');
  const toothAngleDeg = params.toothAngleDeg ?? DEFAULT_TOOTH_ANGLE_DEG;
  if (!(toothAngleDeg > 0 && toothAngleDeg < 180))
    return fail('WRP_PARAM_INVALID', `toothAngleDeg must be in (0, 180) (got ${toothAngleDeg})`, 'toothAngleDeg');
  if (params.depth !== undefined && !(params.depth > 0))
    return fail('WRP_PARAM_INVALID', `depth must be > 0 (got ${params.depth})`, 'depth');
  const depth =
    params.depth ??
    (helical
      ? helicalDepthForLand(knurl.pitch, toothAngleDeg, helix, DEFAULT_LAND_RATIO)
      : depthForLand(knurl.pitch, toothAngleDeg, DEFAULT_LAND_RATIO));
  const land = helical ? helicalLand(knurl.pitch, { depth, toothAngleDeg, helixDeg: helix }) : landFor(knurl.pitch, toothAngleDeg, depth);
  if (land < 0.02 * knurl.pitch)
    return fail(
      'WRP_KNURL_DEPTH_INVALID',
      `depth ${depth} leaves a land of ${land} between ${helical ? 'the grooves of one hand' : 'grooves'} (needs at least 2 % of the pitch ${knurl.pitch}): the grooves would meet`,
      'depth',
    );
  if (depth >= 0.5 * surface.radius)
    return fail('WRP_DEPTH_EXCEEDS_SOLID', `depth ${depth} reaches half the radius ${surface.radius}`, 'depth');
  const [[, from], [, to]] = session.uvBounds;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from))
    return fail('WRP_FACE_NOT_FOUND', 'the face has no axial extent', 'face');
  const base = { depth, land, toothAngleDeg, from, to, origin: surface.origin, axis: surface.axis };
  const hands = diamond ? 2 : 1;
  const shape: HelicalKnurl = {
    teeth: knurl.teeth,
    radius: surface.radius,
    depth,
    toothAngleDeg,
    helixDeg: helix,
    hands,
    left: params.hand === 'left',
  };
  const grooves = knurl.teeth * hands;
  const span = helical ? grooveSpan(shape, from, to) : undefined;
  const faceTurns = helical ? (to - from) / leadOf(shape) : 0;
  const seconds = helical ? estimatedKernelSeconds(grooves, faceTurns) : 0;
  if (helical && seconds > MAX_KERNEL_SECONDS)
    return fail(
      'WRP_KNURL_TOO_MANY_GROOVES',
      `${grooves} helical grooves (${knurl.teeth} teeth${diamond ? ' x 2 hands' : ''}) of ${faceTurns.toFixed(2)} turns along the face each would take the exact kernel about ${seconds.toFixed(0)} s (limit ${MAX_KERNEL_SECONDS} s, one kernel call is cut at 60 s): use a coarser pitch, a smaller helix angle (fewer turns), or the cosmetic model`,
      'pitch',
    );
  if (!isOutside(session))
    return fail(
      'WRP_KNURL_FACE_NOT_CYLINDER',
      `face ${session.face} is a bore (material outside it): only an outside cylinder is knurled`,
      'face',
    );
  const [pastFrom, pastTo] = freeEnds(
    session.query.faceGraph(session.shape),
    session.face,
    { origin: surface.origin, dir: surface.axis },
    [from, to],
    1e-6 * session.diagonal,
  );
  if (!helical)
    return { kind: 'straight', ...base, shape: { teeth: knurl.teeth, radius: surface.radius, depth, toothAngleDeg }, pastFrom, pastTo };
  if (!pastFrom || !pastTo)
    return fail(
      'WRP_KNURL_GEOMETRY_UNSUPPORTED',
      `a helical groove runs past both ends of the face, so each end must be a free cap: the ${!pastFrom ? 'start' : 'end'} of face ${session.face} meets a shoulder or a ring-shaped face (use the cosmetic model, or a straight pattern)`,
      'face',
    );
  return { kind: 'helical', ...base, shape, span: span as ReturnType<typeof grooveSpan>, grooves, faceTurns, seconds, diamond };
}
