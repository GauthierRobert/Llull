/**
 * add_knurl model geometry for the diagonal and diamond patterns (03 WRP M5): open the face, check the groove form, build the helical grooves of `knurlHelix.ts` as one exact recipe,
 * evaluate it on the native kernel and compare the measured volume with the closed form (diagonal) or the numeric union (diamond).
 * @failure not a cylinder outside, a depth that overlaps the grooves or reaches half the radius, a cut over the measured kernel-time envelope, a missing free end cap, a kernel that cannot sweep or
 *   cut, a volume that differs from the expected one -> coded no-op
 */

import { nextId } from '../../lib/id';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { namedDefault, wrapData } from './conventions';
import { kernelVolume } from './embossRun';
import type { FaceSession } from './faceSession';
import type { HelicalPlan } from './knurlGeometryPlan';
import { DEFAULT_LAND_RATIO, DEFAULT_TOOTH_ANGLE_DEG } from './knurlGeometry';
import { helicalKnurlRecipe, helicalRemovedVolume, leadOf } from './knurlHelix';

/** Relative difference between the measured volume change and the expected one that is refused: the closed form agrees to 1e-6 on the native kernel, the numeric union of a diamond to 1.4e-5 (measured). */
const DIAGONAL_RESOLUTION = 1e-4;
const DIAMOND_RESOLUTION = 1e-3;

export interface HelicalRequest {
  readonly id: string;
  readonly pattern: 'diagonal' | 'diamond';
  readonly pitch: number;
  readonly helixAngleDeg: number;
  readonly depth?: number | undefined;
  readonly toothAngleDeg?: number | undefined;
  readonly hand?: 'right' | 'left' | undefined;
  readonly requestedHelix: boolean;
}

/** See the module comment. */
export function cutHelicalGrooves(
  doc: CadDocument,
  params: HelicalRequest,
  session: FaceSession,
  knurl: {
    readonly teeth: number;
    readonly pitch: number;
    readonly diameter: number;
    readonly adjusted: boolean;
    readonly requestedPitch: number;
  },
  plan: HelicalPlan,
): CommandResult {
  const fail = (code: string, message: string, path: string): CommandResult =>
    wrapRejection(doc, 'add_knurl', code, message, [params.id], [path]);
  const { origin, axis, depth, land, toothAngleDeg, from, to, shape, span, grooves, faceTurns, seconds, diamond } = plan;
  const recipe = helicalKnurlRecipe(session.source, shape, { origin, axis, span }, nextId('mesh'), session.entity.color);
  if (typeof recipe === 'string') return fail('WRP_KERNEL_BUILD_FAILED', recipe, 'face');
  const built = evaluateRecipe(session.kernel, recipe);
  if (typeof built === 'string')
    return fail('WRP_KERNEL_BUILD_FAILED', `the exact kernel could not cut ${grooves} helical grooves (${built})`, 'face');
  const health = session.kernel.analyze?.(built.shape) ?? null;
  if (health !== null && !(health.valid && health.closed))
    return fail('WRP_KERNEL_BUILD_FAILED', `the grooved solid is not valid and closed (${health.status}); refused`, 'face');
  const before = kernelVolume(session, session.shape);
  const after = kernelVolume(session, built.shape);
  const volumeDelta = before !== null && after !== null ? after - before : null;
  if (volumeDelta !== null && volumeDelta >= 0)
    return fail('WRP_KERNEL_BUILD_FAILED', `the grooves removed no material (volume change ${volumeDelta}); refused`, 'face');
  const expected = -helicalRemovedVolume(shape, to - from);
  const resolution = diamond ? DIAMOND_RESOLUTION : DIAGONAL_RESOLUTION;
  if (volumeDelta !== null && Math.abs(volumeDelta - expected) > resolution * Math.abs(expected))
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the grooves changed the volume by ${volumeDelta} where the ${grooves} helical grooves remove ${expected} (more than ${resolution} apart); refused`,
      'face',
    );
  const lead = leadOf(shape);
  const data = wrapData(
    doc,
    {
      model: 'geometry',
      pattern: params.pattern,
      teeth: knurl.teeth,
      grooves,
      hands: diamond ? ['right', 'left'] : [shape.left ? 'left' : 'right'],
      pitch: knurl.pitch,
      requestedPitch: knurl.requestedPitch,
      diameter: knurl.diameter,
      helixAngleDeg: params.helixAngleDeg,
      lead,
      grooveLength: (to - from) / Math.cos((params.helixAngleDeg * Math.PI) / 180),
      depth,
      toothAngleDeg,
      land,
      pitchAdjusted: knurl.adjusted,
      warnings: knurl.adjusted ? [{ code: 'WRP_KNURL_PITCH_ADJUSTED', message: `${knurl.teeth} teeth close at pitch ${knurl.pitch}` }] : [],
      volumeDelta,
      expectedVolumeDelta: expected,
      expectedMethod: diamond ? 'numeric union of the two hands over the transverse sections' : 'closed form teeth x length x A_t',
      length: to - from,
      turns: faceTurns,
      estimatedKernelSeconds: seconds,
    },
    {
      unverified: false,
      provenance: {
        method: 'helical V-grooves: one exact screw sweep per tooth (and per hand), united and subtracted in one boolean',
        inputs: { id: params.id, face: session.face, pitch: knurl.requestedPitch, helixAngleDeg: params.helixAngleDeg },
      },
      defaults: [
        ...(params.toothAngleDeg === undefined
          ? [namedDefault('toothAngleDeg', DEFAULT_TOOTH_ANGLE_DEG, 'deg', 'llull WRP default (D-WRP-8): not a standard value')]
          : []),
        ...(params.depth === undefined
          ? [namedDefault('landRatio', DEFAULT_LAND_RATIO, '1', 'llull WRP default (D-WRP-8): land = 10 % of the pitch')]
          : []),
        ...(params.requestedHelix
          ? []
          : [namedDefault('helixAngleDeg', params.helixAngleDeg, 'deg', 'llull WRP default (D-WRP-8): not a standard value')]),
      ],
    },
  );
  const committed = commitKernelResult(
    doc,
    session.kernel,
    built,
    [session.entity],
    (newId, triangles) =>
      `add_knurl: ${grooves} helical V-grooves (${params.pattern}, ${knurl.teeth} teeth, helix ${params.helixAngleDeg} deg, pitch ${knurl.pitch.toPrecision(8)}, depth ${depth.toPrecision(6)}, land ${land.toPrecision(5)} ${doc.units}) on cylinder face ${session.face} of '${params.id}' → mesh '${newId}' (${triangles} triangles)${
        volumeDelta === null ? '' : `, volume ${volumeDelta.toPrecision(9)} ${doc.units}^3`
      }${knurl.adjusted ? `; WRP_KNURL_PITCH_ADJUSTED: asked ${knurl.requestedPitch}` : ''}. Source solid consumed.`,
  );
  return { ...committed, data };
}
