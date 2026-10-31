/** The checks and the numbers shared by add_knurl and its preview: the cylinder face, the teeth that close round it, the pitch used and the helix angle (03 WRP M4). */

import type { CadDocument } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { wrapRejection } from './codes';
import { isRejection, openFace, type FaceRefInput, type FaceSession } from './faceSession';

/** Helix angle of a diagonal or diamond knurl when none is given: a named default of the pack (D-WRP-8), not a standard. */
export const DEFAULT_HELIX_DEG = 30;
const MIN_TEETH = 3;
/** Most teeth a knurl may have (as many instances as pattern_on_face allows): each is a tool solid of the boolean. */
const MAX_TEETH = 2000;

export interface KnurlRequest {
  readonly id: string;
  readonly face: FaceRefInput;
  readonly pattern: 'straight' | 'diagonal' | 'diamond';
  readonly pitch: number;
  readonly helixAngleDeg?: number | undefined;
  readonly model?: 'cosmetic' | 'geometry' | undefined;
  readonly hand?: 'right' | 'left' | undefined;
}

export interface KnurlPlan {
  readonly session: FaceSession & { readonly surface: Extract<FaceSession['surface'], { type: 'cylinder' }> };
  readonly teeth: number;
  readonly pitch: number;
  readonly diameter: number;
  readonly adjusted: boolean;
  /** Helix angle from the axis in degrees (diagonal and diamond), undefined for a straight pattern. */
  readonly helix: number | undefined;
}

/**
 * The face session and the closing tooth count of a knurl request.
 * @failure not a cylinder, pitch <= 0, a helix angle outside (0, 90) or with a straight pattern, hand without a diagonal geometry knurl, fewer than 3 or more than 2000 teeth -> coded rejection
 */
export function planKnurl(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  command: string,
  params: KnurlRequest,
): KnurlPlan | CommandResult {
  const session = openFace(doc, ctx, command, params.id, params.face);
  if (isRejection(session)) return session;
  const fail = (code: string, message: string, path: string): CommandResult =>
    wrapRejection(doc, command, code, message, [params.id], [path]);
  if (session.surface.type !== 'cylinder')
    return fail('WRP_KNURL_FACE_NOT_CYLINDER', `face ${session.face} of '${params.id}' is ${session.surface.type}, not a cylinder`, 'face');
  if (!(Number.isFinite(params.pitch) && params.pitch > 0))
    return fail('WRP_PARAM_INVALID', `pitch must be > 0 (got ${params.pitch})`, 'pitch');
  if (params.helixAngleDeg !== undefined && !(params.helixAngleDeg > 0 && params.helixAngleDeg < 90))
    return fail('WRP_PARAM_INVALID', `helixAngleDeg must be in (0, 90) (got ${params.helixAngleDeg})`, 'helixAngleDeg');
  if (params.pattern === 'straight' && params.helixAngleDeg !== undefined)
    return fail('WRP_PARAM_INVALID', 'helixAngleDeg goes with the diagonal and diamond patterns, not straight', 'helixAngleDeg');
  if (params.hand !== undefined && !(params.pattern === 'diagonal' && params.model === 'geometry'))
    return fail(
      'WRP_PARAM_INVALID',
      'hand goes with the diagonal pattern and model geometry (a diamond has both hands, the others no helix)',
      'hand',
    );
  const diameter = 2 * session.surface.radius;
  const teeth = Math.round((Math.PI * diameter) / params.pitch);
  if (!Number.isFinite(teeth) || teeth > MAX_TEETH)
    return fail('WRP_PARAM_INVALID', `pitch ${params.pitch} gives ${teeth} teeth on diameter ${diameter} (at most ${MAX_TEETH})`, 'pitch');
  if (teeth < MIN_TEETH)
    return fail(
      'WRP_PARAM_INVALID',
      `pitch ${params.pitch} is too coarse for diameter ${diameter}: fewer than ${MIN_TEETH} teeth`,
      'pitch',
    );
  const pitch = (Math.PI * diameter) / teeth;
  const adjusted = Math.abs(pitch - params.pitch) > 1e-9 * params.pitch;
  const helix = params.pattern === 'straight' ? undefined : (params.helixAngleDeg ?? DEFAULT_HELIX_DEG);

  return { session: session as KnurlPlan['session'], teeth, pitch, diameter, adjusted, helix };
}
