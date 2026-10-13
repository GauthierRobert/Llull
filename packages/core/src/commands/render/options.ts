/**
 * Semantic validation of render_view's camera / cut / budget parameters and the summary notes
 * that report what the renderer reduced.
 */

import type { CadDocument, Vec3 } from '../../model/types';
import { isValidCut } from './clip';
import { MAX_POLYGONS } from './budget';
import type { CutSpec, RenderOptions, RenderViewData } from './types';
import { clamp } from '../../lib/clamp';

const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|(rgb|hsl)a?\([0-9.,%\s/-]+\))$/;
const MAX_CUT_PLANES = 6;

interface RenderParams {
  zoom?: number | undefined;
  direction?: Vec3 | undefined;
  target?: Vec3 | undefined;
  background?: string | undefined;
  maxPolygons?: number | undefined;
  cut?:
    | {
        planes: { normal: Vec3; offset: number }[];
        mode?: CutSpec['mode'] | undefined;
        entityIds?: string[] | undefined;
      }
    | undefined;
}

const finite = (v: Vec3): boolean => v.every(Number.isFinite);

function validateCut(doc: CadDocument, cut: NonNullable<RenderParams['cut']>): string | null {
  if (cut.planes.length < 1 || cut.planes.length > MAX_CUT_PLANES) {
    return `cut.planes needs 1..${MAX_CUT_PLANES} planes, got ${cut.planes.length}`;
  }
  if (!isValidCut({ planes: cut.planes, mode: 'intersection' })) {
    return 'cut.planes: every normal must be finite and non-zero, every offset finite';
  }
  if (cut.entityIds !== undefined) {
    if (cut.entityIds.length === 0) return 'cut.entityIds is empty: omit it to cut every solid';
    if (!cut.entityIds.some((id) => doc.entities[id] !== undefined)) {
      return `cut.entityIds matches no entity: ${cut.entityIds.slice(0, 5).join(', ')}`;
    }
  }
  return null;
}

/** Validated render options, or the reason they are invalid. @pure */
export function resolveRenderOptions(doc: CadDocument, params: RenderParams): { options: RenderOptions } | { error: string } {
  const options: RenderOptions = {};
  if (params.zoom !== undefined) {
    if (!Number.isFinite(params.zoom) || params.zoom <= 0) return { error: 'zoom must be > 0' };
    options.zoom = clamp(params.zoom, 0.1, 50);
  }
  if (params.direction !== undefined) {
    const [x, y, z] = params.direction;
    if (!finite(params.direction) || Math.hypot(x, y, z) < 1e-9) {
      return { error: 'direction must be a finite, non-zero [x, y, z] vector' };
    }
    options.direction = params.direction;
  }
  if (params.target !== undefined) {
    if (!finite(params.target)) return { error: 'target must be a finite [x, y, z] point' };
    options.target = params.target;
  }
  if (params.background !== undefined) {
    if (!COLOR_PATTERN.test(params.background.trim())) {
      return { error: `background "${params.background}" is not a CSS color` };
    }
    options.background = params.background.trim();
  }
  if (params.maxPolygons !== undefined && Number.isFinite(params.maxPolygons)) {
    options.maxPolygons = clamp(Math.round(params.maxPolygons), 500, 100000);
  }
  if (params.cut !== undefined) {
    const problem = validateCut(doc, params.cut);
    if (problem !== null) return { error: problem };
    options.cut = {
      planes: params.cut.planes,
      mode: params.cut.mode ?? 'intersection',
      ...(params.cut.entityIds ? { entityIds: params.cut.entityIds } : {}),
    };
  }
  return { options };
}

const listIds = (ids: readonly string[]): string => ids.slice(0, 8).join(', ') + (ids.length > 8 ? `, … (+${ids.length - 8})` : '');

/** Sentences describing simplification, skipped entities and cutaway outcome ('' when nothing). */
export function renderNotes(data: RenderViewData, cut: CutSpec | undefined): string {
  const notes: string[] = [];
  const budget = data.polygonBudget === MAX_POLYGONS ? '' : ` of ${data.polygonBudget}`;
  if (data.simplifiedEntityIds.length > 0) {
    notes.push(
      `Simplified ${data.simplifiedEntityIds.length} entity/entities to fit the polygon budget ` +
        `(${data.polygonCount} polygons drawn${budget}): ${listIds(data.simplifiedEntityIds)}. ` +
        'Raise maxPolygons for more detail.',
    );
  }
  if (data.skippedEntityIds.length > 0) {
    notes.push(`NOT drawn (budget smaller than the entity count): ${listIds(data.skippedEntityIds)}. Raise maxPolygons.`);
  }
  if (cut) {
    notes.push(
      data.cutEntityIds.length > 0
        ? `Cutaway (${cut.mode}, ${cut.planes.length} plane(s)) clipped ${data.cutEntityIds.length} entity/entities: ${listIds(data.cutEntityIds)}.`
        : 'Cutaway removed nothing: no selected solid crosses the cut region.',
    );
  }
  return notes.join(' ');
}
