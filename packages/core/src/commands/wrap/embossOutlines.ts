import type { Vec2 } from '../../model/types';
import { selfIntersects } from '../../lib/polygon';
import { sampleSegment, type PlaneSegment } from '../../geometry/planeSegments';
import type { CommandResult } from '../types';
import { repeatOnGrid } from './embossGrid';
import type { EmbossCall } from './embossRequest';
import { strokeOutlines } from './embossStrokes';
import { isRejection } from './faceSession';
import { isSketchFailure, sketchOutline, type ChartRegion, type SketchOutline } from './sketchProfiles';

const CROSS_CHECK_SAMPLES = 12;

export interface PreparedOutlines {
  readonly outlines: SketchOutline[];
  readonly regions: ChartRegion[];
  readonly unverified: boolean;
  readonly font: SketchOutline['font'];
  readonly strokeLength: number | null;
}

const polygonOf = (chain: readonly PlaneSegment[]): Vec2[] =>
  chain.flatMap((piece) => sampleSegment(piece, piece.kind === 'line' ? 2 : CROSS_CHECK_SAMPLES).slice(0, -1));

function collectOutlines(call: EmbossCall): SketchOutline[] | CommandResult {
  const { doc, params, fail, engrave, scribe } = call;
  const outlines: SketchOutline[] = [];
  for (const [index, profileId] of params.profileIds.entries()) {
    const outline = sketchOutline(doc, profileId);
    if (isSketchFailure(outline)) return fail(outline.code, outline.message, [`profileIds.${index}`], [profileId]);
    const closedOnly = !engrave && (outline.open.length > 0 || outline.regions.length === 0);
    if (closedOnly || (engrave && outline.open.length === 0 && outline.regions.length === 0))
      return fail(
        'WRP_PROFILE_OPEN',
        `profile '${profileId}' (${outline.kind}) is not a closed shape; ${scribe ? 'scribe of open curves is not built yet' : 'close it, use mode scribe, or mode engrave to cut a groove along it'}`,
        [`profileIds.${index}`],
        [profileId],
      );
    for (const region of outline.regions)
      for (const chain of [region.outer, ...region.holes])
        if (!engrave && selfIntersects(polygonOf(chain)))
          return fail('WRP_PROFILE_SELF_INTERSECT', `profile '${profileId}' crosses itself`, [`profileIds.${index}`], [profileId]);
    outlines.push(outline);
  }
  return outlines;
}

export function prepareOutlines(call: EmbossCall): PreparedOutlines | CommandResult {
  const { doc, params, fail, engrave } = call;
  const collected = collectOutlines(call);
  if (!Array.isArray(collected)) return collected;
  const unverified = collected.some((outline) => outline.unverified);
  const font = collected.find((outline) => outline.font !== null)?.font ?? null;
  let outlines: SketchOutline[] = collected;
  let regions: ChartRegion[] = outlines.flatMap((outline) => outline.regions);
  let strokeLength: number | null = null;
  if (engrave) {
    const stroked = strokeOutlines(outlines, params, fail);
    if (isRejection(stroked)) return stroked;
    ({ outlines, regions, strokeLength } = stroked);
  }
  if (params.grid !== undefined) {
    const gridded = repeatOnGrid(doc, params.grid, outlines, regions, fail);
    if (isRejection(gridded)) return gridded;
    ({ outlines, regions } = gridded);
  }
  return { outlines, regions, unverified, font, strokeLength };
}
