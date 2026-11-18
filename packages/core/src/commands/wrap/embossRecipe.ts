import type { EmbossParams } from '../../model/wrap';
import type { ShapeRecipe, Vec2, Vec3 } from '../../model/types';
import { scale3 } from '../../lib/vec3';
import { embossClosedForm } from '../../geometry/embossVolume';
import type { CommandResult } from '../types';
import { SEWING_RATIO, MIN_FIT_TOLERANCE } from './constants';
import { buildFreeformRecipe, isFreeformFailure, type FreeformBuild } from './embossFreeform';
import type { Mapped } from './embossMapping';
import { buildPullRecipe, isPullFailure, type PullBuild } from './embossPull';
import type { EmbossCall } from './embossRequest';
import type { ChartRegion } from './sketchProfiles';

export interface EmbossRecipe {
  readonly recipe: ShapeRecipe;
  readonly recipeParams: EmbossParams;
  readonly freeform: FreeformBuild | null;
  readonly pull: PullBuild | null;
  readonly closed: ReturnType<typeof embossClosedForm> | null;
}

function pullBuildOf(call: EmbossCall, mapped: Mapped, preview: boolean): PullBuild | null | CommandResult {
  const { params, session, resolved, fail, cutting, depth, tolerance, pulled } = call;
  if (!pulled) return null;
  const built = buildPullRecipe({
    session,
    chart: resolved.chart,
    orientation: resolved.orientation,
    regions: mapped.regions,
    pieces: mapped.pieces,
    mode: cutting ? 'deboss' : 'emboss',
    depth,
    pull: params.pullDirection as Vec3,
    draftDeg: params.draftDeg ?? 0,
    anchorOn: resolved.anchorOn,
    tolerance,
    preview,
  });
  if (isPullFailure(built)) {
    const refused = fail(built.code, built.message, [built.path ?? 'pullDirection']);
    return built.data === undefined ? refused : { ...refused, data: built.data };
  }
  return built;
}

export function buildEmbossRecipe(
  call: EmbossCall,
  regions: ChartRegion[],
  mapped: Mapped,
  preview: boolean,
): EmbossRecipe | CommandResult {
  const { params, session, resolved, fail, cutting, depth, tolerance } = call;
  const { chart } = resolved;
  const freeform =
    chart.kind === 'freeform'
      ? buildFreeformRecipe({
          source: session.source,
          face: session.face,
          diagonal: session.diagonal,
          chart,
          orientation: resolved.orientation,
          outward: resolved.outward,
          holesPerRegion: regions.map((region) => region.holes.length),
          pieces: mapped.pieces,
          mode: cutting ? 'deboss' : 'emboss',
          depth,
          tolerance,
        })
      : null;
  if (freeform !== null && isFreeformFailure(freeform)) return fail(freeform.code, freeform.message, ['profileIds'], params.profileIds);
  const recipeParams: EmbossParams = {
    face: session.face,
    surface: chart.wire,
    regions: mapped.regions,
    mode: cutting ? 'deboss' : (params.mode as 'emboss' | 'scribe'),
    depth,
    direction: scale3(chart.normalAt(mapped.regions[0]?.outer.start as Vec2), resolved.orientation),
    // the construction tolerance of the recipe: sewing, and the fit of the pcurves (the kernel builds the 3D edges of a fitted pcurve to about that)
    tolerance: Math.max(SEWING_RATIO * session.diagonal, MIN_FIT_TOLERANCE, tolerance),
  };
  const pull = pullBuildOf(call, mapped, preview);
  if (pull !== null && 'summary' in pull) return pull;
  const recipe: ShapeRecipe =
    freeform !== null ? freeform.recipe : (pull?.recipe ?? { op: 'emboss', source: session.source, ...recipeParams });
  // walls along a pull: the closed form of the layer is known on a plane (A d); on curved faces the volume is the measured one
  const closed =
    freeform !== null
      ? null
      : pull === null || (session.surface.type === 'plane' && !((params.draftDeg ?? 0) > 0))
        ? embossClosedForm(recipeParams)
        : null;
  return { recipe, recipeParams, freeform, pull, closed };
}
