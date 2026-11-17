/**
 * The body of emboss_on_face and pattern_on_face (03 WRP M3 - M5): open the face, chart the sketch, check it (profile closed, no self-crossing, one turn at most, on the face, within the
 * distortion limit), build the `emboss` recipe, evaluate it on the exact kernel and report.
 * Modes: emboss / deboss / scribe on closed profiles; engrave sweeps a flat tool of `toolWidth` along the outline paths (open strokes, single-line text, contours) and cuts that area
 * as a deboss; a `grid` repeats the seed profiles on a rectangular lattice of the sketch.
 */

import type { CadDocument, ShapeRecipe } from '../../model/types';
import { evaluateRecipe } from '../kernelShape';
import type { CommandResult, ExecutionContext } from '../types';
import { wrapRejection } from './codes';
import { runEmbossChain } from './embossChain';
import { checkDepthLimits } from './embossDepthLimit';
import { mapAndCheck, type Mapped } from './embossMapping';
import { prepareOutlines, type PreparedOutlines } from './embossOutlines';
import { buildEmbossRecipe } from './embossRecipe';
import { commitEmboss, previewEmboss } from './embossReport';
import type { EmbossCall, EmbossFail, EmbossRequest } from './embossRequest';
import { checkEmbossRequest, checkFreeformMode } from './embossRequestChecks';
import { defaultFitTolerance, isRejection, openFace, resolveChart, type FaceSession } from './faceSession';

/** Volume of the exact solid and of its source: the kernel's exact mass properties, else its analysis. */
export function kernelVolume(
  session: Pick<FaceSession, 'kernel'>,
  shape: Parameters<NonNullable<FaceSession['kernel']['massProperties']>>[0],
): number | null {
  const mass = session.kernel.massProperties?.(shape) ?? null;
  if (mass !== null) return mass.volume;
  return session.kernel.analyze?.(shape)?.volume ?? null;
}

function handOffToChain(call: EmbossCall, ctx: ExecutionContext | undefined, prepared: PreparedOutlines, preview: boolean): CommandResult {
  const { doc, command, params, session, resolved, fail, engrave, scribe, depth, tolerance } = call;
  if (engrave || params.grid !== undefined)
    return fail('WRP_PARAM_INVALID', 'chain works with emboss, deboss and scribe, not with engrave or a grid', ['chain']);
  if (preview)
    return fail(
      'WRP_PARAM_INVALID',
      'the preview draws a footprint on one face: leave out chain (the chain is built face by face by emboss_on_face)',
      ['chain'],
    );
  return runEmbossChain({
    doc,
    ctx,
    command,
    params,
    session,
    resolved,
    regions: prepared.regions,
    unverified: prepared.unverified,
    tolerance,
    depth: scribe ? 0 : depth,
    volumeOf: (shape) => kernelVolume(session, shape),
  });
}

function buildSolid(
  call: EmbossCall,
  mapped: Mapped,
  recipe: ShapeRecipe,
): { readonly built: Exclude<ReturnType<typeof evaluateRecipe>, string>; readonly volumeDelta: number | null } | CommandResult {
  const { doc, params, session, fail, scribe, cutting } = call;
  const built = evaluateRecipe(session.kernel, recipe);
  if (typeof built === 'string')
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the exact kernel could not ${params.mode} ${mapped.regions.length} region(s) on face ${session.face} (${built}); try a smaller depth or profile`,
      ['profileIds'],
      params.profileIds,
    );
  const health = session.kernel.analyze?.(built.shape) ?? null;
  if (health !== null && !(health.valid && health.closed))
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the ${params.mode} is not a valid closed solid (${health.status}); refused`,
      ['profileIds'],
      params.profileIds,
    );
  const before = kernelVolume(session, session.shape);
  const after = kernelVolume(session, built.shape);
  const volumeDelta = before !== null && after !== null ? after - before : null;
  if (volumeDelta !== null && !scribe && (cutting ? volumeDelta >= 0 : volumeDelta <= 0))
    return fail(
      'WRP_KERNEL_BUILD_FAILED',
      `the ${params.mode} changed the volume by ${volumeDelta} ${doc.units}^3, the wrong way (${cutting ? 'a cut must remove' : 'an emboss must add'} material); refused`,
      ['profileIds'],
      params.profileIds,
    );
  return { built, volumeDelta };
}

/**
 * @failure see emboss_on_face and pattern_on_face: every refusal is coded, the document comes back unchanged
 */
export function runEmboss(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  command: string,
  params: EmbossRequest,
  options: { readonly preview?: boolean } = {},
): CommandResult {
  const session = openFace(doc, ctx, command, params.id, params.face);
  if (isRejection(session)) return session;
  const fail: EmbossFail = (code, message, paths, ids = [params.id]) => wrapRejection(doc, command, code, message, [...ids], paths);
  const refused = checkEmbossRequest(params, fail);
  if (refused !== null) return refused;
  const resolved = resolveChart(doc, session, params.placement, params.face.faceNear);
  if (isRejection(resolved)) return resolved;
  const freeformRefused = checkFreeformMode(resolved.chart.kind === 'freeform', params, fail);
  if (freeformRefused !== null) return freeformRefused;
  const scribe = params.mode === 'scribe';
  const call: EmbossCall = {
    doc,
    command,
    params,
    session,
    resolved,
    fail,
    engrave: params.mode === 'engrave',
    scribe,
    pulled: params.walls === 'pull',
    cutting: params.mode === 'deboss' || params.mode === 'engrave',
    depth: scribe ? 0 : (params.depth as number),
    tolerance: params.fitTolerance ?? defaultFitTolerance(session.diagonal),
  };
  const prepared = prepareOutlines(call);
  if (isRejection(prepared)) return prepared;
  if (params.chain !== undefined && params.chain.length > 0) return handOffToChain(call, ctx, prepared, options.preview === true);
  const mapped = mapAndCheck(call, prepared.regions, prepared.outlines);
  if (isRejection(mapped)) return mapped;
  const recipe = buildEmbossRecipe(call, prepared.regions, mapped.mapped, options.preview === true);
  if (isRejection(recipe)) return recipe;
  const tooDeep = checkDepthLimits(call, mapped.mapped, recipe);
  if (tooDeep !== null) return tooDeep;
  if (options.preview === true) return previewEmboss(call, mapped, recipe);
  const solid = buildSolid(call, mapped.mapped, recipe.recipe);
  if (isRejection(solid)) return solid;
  return commitEmboss(call, { mapped, recipe, ...prepared, ...solid });
}
