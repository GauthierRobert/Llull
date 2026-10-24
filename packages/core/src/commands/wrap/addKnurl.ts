/** add_knurl — a knurl on a cylindrical face: the tooth count that closes round the circumference, as a cosmetic note (M4) or as cut grooves (M5, straight pattern). */

import type { KnurlPmi } from '../../model/pmi';
import { pmiText } from '../../geometry/pmiText';
import { nextId } from '../../lib/id';
import { dot3, sub3 } from '../../lib/vec3';
import { changed } from '../noop';
import { featureOf, isRefusal, placementFor, resolveOn, solidTarget } from '../pmi/featureOps';
import { REVIEW_REQUIRED, withItem } from '../pmi/pmiOps';
import { defineCommand, z } from '../schema';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { namedDefault, wrapData } from './conventions';
import { isRejection, openFace } from './faceSession';
import { faceRefField } from './schemas';
import { kernelVolume } from './embossRun';
import { DEFAULT_LAND_RATIO, DEFAULT_TOOTH_ANGLE_DEG, depthForLand, freeEnds, grooveArea, knurlRecipe, landFor } from './knurlGeometry';

/** Helix angle of a diagonal or diamond knurl when none is given: a named default of the pack (D-WRP-8), not a standard. */
const DEFAULT_HELIX_DEG = 30;
const MIN_TEETH = 3;
/** Most teeth a knurl may have (as many instances as pattern_on_face allows): each is a tool solid of the boolean. */
const MAX_TEETH = 2000;
/** Relative difference between the measured volume change of the grooves and their closed form that is refused: the exact kernel integrates the quadrics to about 1e-6 (VC-WRP-39). */
const KNURL_VOLUME_RESOLUTION = 1e-4;

/**
 * @affects model cosmetic: adds 1 KnurlPmi (review required), affected = [pmiId]; model geometry: replaces the solid by the grooved result (a new mesh entity carrying the exact recipe)
 * @invariant teeth = round(pi d / pitch) closes round the circumference, so pitch used = pi d / teeth and differs from the request unless it divides pi d; cosmetic: no geometry changes; geometry:
 *   N V-grooves of depth h removing exactly N L A (data.expectedVolumeDelta), a land of landRatio x pitch between them unless depth is given
 * @failure unknown id / not a solid / no exact kernel / face not a cylinder / a bore / pitch <= 0 or coarser than 3 teeth / helix angle outside (0, 90) / geometry of a diagonal or diamond pattern / depth with
 *   overlapping grooves or beyond half the radius / kernel failure -> coded no-op
 */
export const addKnurl = defineCommand({
  name: 'add_knurl',
  description:
    'Mark a cylindrical face of a solid as knurled (cosmetic, like a cosmetic thread: a PMI note, no geometry): pattern straight (axial teeth), diagonal (one helix direction) or diamond ' +
    '(crossed helices), with the circular `pitch` you ask for in document units. The teeth must close round the circumference, so the count is round(pi d / pitch) and the pitch ' +
    'actually used is pi d / teeth; when that differs from your request the result carries the warning WRP_KNURL_PITCH_ADJUSTED (data.warnings, the pitch used is data.pitch). ' +
    'Diagonal and diamond patterns take `helixAngleDeg` from the axis (default 30, a named default, not a standard: no DIN 82 / ISO 13444 table is shipped). Returns data { knurlId, ' +
    'teeth, pitch, requestedPitch, diameter, pattern, helixAngleDeg?, pitchAdjusted, warnings, reviewRequired: true }. The note is review-required PMI (drawings and STEP AP242 carry it). ' +
    "With model 'geometry' (straight pattern only) the grooves are CUT: the solid is replaced by one with N V-grooves along the axis (tooth angle `toothAngleDeg`, default 90 included; " +
    'depth `depth`, default the one that leaves a flat land of 10 % of the pitch between grooves; both named defaults, not standards); data.expectedVolumeDelta is the closed-form volume removed ' +
    '(N x length x groove area) and no PMI note is added (add_pmi_note if the drawing needs one). Diagonal and diamond geometry refuses with WRP_KNURL_GEOMETRY_UNSUPPORTED (helical grooves are not built: use the ' +
    'cosmetic model). A face that is not a cylinder refuses with WRP_KNURL_FACE_NOT_CYLINDER. Needs the exact (native) kernel. Next: check_pmi, accept_pmi_review, mass_properties, render_view.',
  params: z.object({
    id: z.string().describe('Id of the solid.'),
    face: faceRefField,
    pattern: z
      .enum(['straight', 'diagonal', 'diamond'])
      .describe('straight: teeth parallel to the axis; diagonal: one helix; diamond: two crossed helices.'),
    pitch: z
      .number()
      .describe(
        'Circular pitch asked for, document units, > 0. The pitch used is adjusted so a whole number of teeth closes (data.pitch).',
      ),
    helixAngleDeg: z
      .number()
      .optional()
      .describe('Helix angle from the axis, degrees in (0, 90), for diagonal and diamond patterns. Default 30 (named default).'),
    model: z
      .enum(['cosmetic', 'geometry'])
      .optional()
      .describe('cosmetic (default): a PMI note only. geometry: cut V-grooves into the solid (straight pattern only).'),
    depth: z
      .number()
      .optional()
      .describe(
        'geometry only: groove depth below the surface, document units, > 0. Default: the depth that leaves a flat land of 10 % of the pitch.',
      ),
    toothAngleDeg: z
      .number()
      .optional()
      .describe('geometry only: included angle of the V groove, degrees in (0, 180). Default 90 (named default).'),
  }),
  annotations: { requiresKernel: true },
  run: (doc, params, ctx): CommandResult => {
    const session = openFace(doc, ctx, 'add_knurl', params.id, params.face);
    if (isRejection(session)) return session;
    const fail = (code: string, message: string, path: string): CommandResult =>
      wrapRejection(doc, 'add_knurl', code, message, [params.id], [path]);
    if (session.surface.type !== 'cylinder')
      return fail(
        'WRP_KNURL_FACE_NOT_CYLINDER',
        `face ${session.face} of '${params.id}' is ${session.surface.type}, not a cylinder`,
        'face',
      );
    if (!(Number.isFinite(params.pitch) && params.pitch > 0))
      return fail('WRP_PARAM_INVALID', `pitch must be > 0 (got ${params.pitch})`, 'pitch');
    if (params.helixAngleDeg !== undefined && !(params.helixAngleDeg > 0 && params.helixAngleDeg < 90))
      return fail('WRP_PARAM_INVALID', `helixAngleDeg must be in (0, 90) (got ${params.helixAngleDeg})`, 'helixAngleDeg');
    if (params.pattern === 'straight' && params.helixAngleDeg !== undefined)
      return fail('WRP_PARAM_INVALID', 'helixAngleDeg goes with the diagonal and diamond patterns, not straight', 'helixAngleDeg');
    const diameter = 2 * session.surface.radius;
    const teeth = Math.round((Math.PI * diameter) / params.pitch);
    if (!Number.isFinite(teeth) || teeth > MAX_TEETH)
      return fail(
        'WRP_PARAM_INVALID',
        `pitch ${params.pitch} gives ${teeth} teeth on diameter ${diameter} (at most ${MAX_TEETH})`,
        'pitch',
      );
    if (teeth < MIN_TEETH)
      return fail(
        'WRP_PARAM_INVALID',
        `pitch ${params.pitch} is too coarse for diameter ${diameter}: fewer than ${MIN_TEETH} teeth`,
        'pitch',
      );
    const pitch = (Math.PI * diameter) / teeth;
    const adjusted = Math.abs(pitch - params.pitch) > 1e-9 * params.pitch;
    const helix = params.pattern === 'straight' ? undefined : (params.helixAngleDeg ?? DEFAULT_HELIX_DEG);
    if (params.model === 'geometry') return cutGrooves(doc, params, session, { teeth, pitch, diameter, adjusted });
    const target = solidTarget(doc, 'add_knurl', params.id, ctx);
    if (isRefusal(target)) return target;
    const onFace = params.face.faceNear ?? session.query.faceDetails(session.shape, { samples: 1 })?.[session.face]?.samples[0];
    if (onFace === undefined) return fail('WRP_FACE_NOT_FOUND', `face ${session.face} has no point to attach the note to`, 'face');
    const resolved = resolveOn(doc, 'add_knurl', target, [onFace], 'face');
    if (isRefusal(resolved)) return resolved;
    const id = nextId('pmi');
    const item: KnurlPmi = {
      id,
      kind: 'knurl',
      pattern: params.pattern,
      pitch,
      requestedPitch: params.pitch,
      teeth,
      diameter,
      ...(helix === undefined ? {} : { helixAngleDeg: helix }),
      feature: featureOf(params.id, [onFace], resolved),
      placement: placementFor(doc, resolved.faces[0], resolved.diagonal, undefined),
      review: REVIEW_REQUIRED,
    };
    const warnings = adjusted
      ? [
          {
            code: 'WRP_KNURL_PITCH_ADJUSTED',
            message: `pitch ${params.pitch} does not close round the circumference; ${teeth} teeth at pitch ${pitch} do`,
          },
        ]
      : [];
    const data = wrapData(
      doc,
      {
        knurlId: id,
        pattern: params.pattern,
        teeth,
        pitch,
        requestedPitch: params.pitch,
        diameter,
        ...(helix === undefined ? {} : { helixAngleDeg: helix }),
        pitchAdjusted: adjusted,
        warnings,
        reviewRequired: true,
        face: session.face,
      },
      {
        unverified: false,
        provenance: {
          method: 'teeth = round(pi d / pitch), pitch used = pi d / teeth',
          inputs: { id: params.id, face: session.face, pattern: params.pattern },
        },
        defaults:
          helix !== undefined && params.helixAngleDeg === undefined
            ? [namedDefault('helixAngleDeg', DEFAULT_HELIX_DEG, 'deg', 'llull WRP default (D-WRP-8): not a standard value')]
            : [],
      },
    );
    return {
      ...changed(
        withItem(doc, item),
        `add_knurl: ${pmiText(item)} (${id}) on cylinder face ${session.face} of '${params.id}' (d ${diameter} ${doc.units})${adjusted ? `; WRP_KNURL_PITCH_ADJUSTED: asked ${params.pitch}, used ${pitch.toPrecision(9)}` : ''}; review required.`,
        [id],
      ),
      data,
    };
  },
});

interface GeometryKnurl {
  readonly teeth: number;
  readonly pitch: number;
  readonly diameter: number;
  readonly adjusted: boolean;
}

/** model geometry: the grooves cut into the solid. */
function cutGrooves(
  doc: Parameters<typeof wrapData>[0],
  params: {
    id: string;
    face: { faceNear?: readonly number[] | undefined };
    pattern: string;
    pitch: number;
    depth?: number | undefined;
    toothAngleDeg?: number | undefined;
  },
  session: Extract<ReturnType<typeof openFace>, { face: number }>,
  knurl: GeometryKnurl,
): CommandResult {
  const fail = (code: string, message: string, path: string): CommandResult =>
    wrapRejection(doc, 'add_knurl', code, message, [params.id], [path]);
  const { surface } = session;
  if (surface.type !== 'cylinder') return fail('WRP_KNURL_FACE_NOT_CYLINDER', 'not a cylinder', 'face');
  if (params.pattern !== 'straight')
    return fail(
      'WRP_KNURL_GEOMETRY_UNSUPPORTED',
      `only the straight pattern is modeled as geometry (${params.pattern} needs helical grooves): use the cosmetic model`,
      'pattern',
    );
  const angle = params.toothAngleDeg ?? DEFAULT_TOOTH_ANGLE_DEG;
  if (!(angle > 0 && angle < 180)) return fail('WRP_PARAM_INVALID', `toothAngleDeg must be in (0, 180) (got ${angle})`, 'toothAngleDeg');
  if (params.depth !== undefined && !(params.depth > 0))
    return fail('WRP_PARAM_INVALID', `depth must be > 0 (got ${params.depth})`, 'depth');
  const depth = params.depth ?? depthForLand(knurl.pitch, angle, DEFAULT_LAND_RATIO);
  const land = landFor(knurl.pitch, angle, depth);
  if (land < 0.02 * knurl.pitch)
    return fail(
      'WRP_KNURL_DEPTH_INVALID',
      `depth ${depth} leaves a land of ${land} between grooves (needs at least 2 % of the pitch ${knurl.pitch}): the grooves would meet`,
      'depth',
    );
  if (depth >= 0.5 * surface.radius)
    return fail('WRP_DEPTH_EXCEEDS_SOLID', `depth ${depth} reaches half the radius ${surface.radius}`, 'depth');
  const [[, from], [, to]] = session.uvBounds;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from))
    return fail('WRP_FACE_NOT_FOUND', 'the face has no axial extent', 'face');
  const sample = session.query.faceDetails(session.shape, { samples: 1 })?.[session.face]?.samples[0];
  const hit = sample === undefined ? null : (session.query.projectOnFace(session.shape, session.face, [sample])?.[0] ?? null);
  if (hit === null || dot3(hit.normal, sub3(hit.point, surface.origin)) <= 0)
    return fail(
      'WRP_KNURL_FACE_NOT_CYLINDER',
      `face ${session.face} is a bore (material outside it): only an outside cylinder is knurled`,
      'face',
    );
  const shape = { teeth: knurl.teeth, radius: surface.radius, depth, toothAngleDeg: angle };
  const [pastFrom, pastTo] = freeEnds(
    session.query.faceGraph(session.shape),
    session.face,
    { origin: surface.origin, dir: surface.axis },
    [from, to],
    1e-6 * session.diagonal,
  );
  const recipe = knurlRecipe(
    session.source,
    shape,
    { origin: surface.origin, axis: surface.axis, from, to, pastFrom, pastTo },
    nextId('mesh'),
    session.entity.color,
  );
  if (recipe === null) return fail('WRP_KERNEL_BUILD_FAILED', 'the cylinder axis is degenerate', 'face');
  const built = evaluateRecipe(session.kernel, recipe);
  if (typeof built === 'string')
    return fail('WRP_KERNEL_BUILD_FAILED', `the exact kernel could not cut ${knurl.teeth} grooves (${built})`, 'face');
  const health = session.kernel.analyze?.(built.shape) ?? null;
  if (health !== null && !(health.valid && health.closed))
    return fail('WRP_KERNEL_BUILD_FAILED', `the grooved solid is not valid and closed (${health.status}); refused`, 'face');
  const before = kernelVolume(session, session.shape);
  const after = kernelVolume(session, built.shape);
  const volumeDelta = before !== null && after !== null ? after - before : null;
  if (volumeDelta !== null && volumeDelta >= 0)
    return fail('WRP_KERNEL_BUILD_FAILED', `the grooves removed no material (volume change ${volumeDelta}); refused`, 'face');
  const expected = -knurl.teeth * (to - from) * grooveArea(shape);
  if (volumeDelta !== null && Math.abs(volumeDelta - expected) > KNURL_VOLUME_RESOLUTION * Math.abs(expected))
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the grooves changed the volume by ${volumeDelta} where the ${knurl.teeth} grooves along the face remove ${expected} (more than ${KNURL_VOLUME_RESOLUTION} apart): the tool reaches beyond the face; refused`,
      'face',
    );
  const data = wrapData(
    doc,
    {
      model: 'geometry',
      pattern: 'straight',
      teeth: knurl.teeth,
      pitch: knurl.pitch,
      requestedPitch: params.pitch,
      diameter: knurl.diameter,
      depth,
      toothAngleDeg: angle,
      land,
      pitchAdjusted: knurl.adjusted,
      warnings: knurl.adjusted ? [{ code: 'WRP_KNURL_PITCH_ADJUSTED', message: `${knurl.teeth} teeth close at pitch ${knurl.pitch}` }] : [],
      volumeDelta,
      expectedVolumeDelta: expected,
      length: to - from,
    },
    {
      unverified: false,
      provenance: {
        method: 'V-grooves cut by one boolean subtract of the united prisms',
        inputs: { id: params.id, face: session.face, pitch: params.pitch },
      },
      defaults: [
        ...(params.toothAngleDeg === undefined
          ? [namedDefault('toothAngleDeg', DEFAULT_TOOTH_ANGLE_DEG, 'deg', 'llull WRP default (D-WRP-8): not a standard value')]
          : []),
        ...(params.depth === undefined
          ? [namedDefault('landRatio', DEFAULT_LAND_RATIO, '1', 'llull WRP default (D-WRP-8): land = 10 % of the pitch')]
          : []),
      ],
    },
  );
  const committed = commitKernelResult(
    doc,
    session.kernel,
    built,
    [session.entity],
    (newId, triangles) =>
      `add_knurl: ${knurl.teeth} V-grooves (pitch ${knurl.pitch.toPrecision(8)}, depth ${depth.toPrecision(6)}, land ${land.toPrecision(5)} ${doc.units}) on cylinder face ${session.face} of '${params.id}' → mesh '${newId}' (${triangles} triangles)${
        volumeDelta === null ? '' : `, volume ${volumeDelta.toPrecision(9)} ${doc.units}^3`
      }${knurl.adjusted ? `; WRP_KNURL_PITCH_ADJUSTED: asked ${params.pitch}` : ''}. Source solid consumed.`,
  );
  return { ...committed, data };
}
