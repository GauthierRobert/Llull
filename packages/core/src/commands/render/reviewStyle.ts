/**
 * Review styling of render_view / visible_entity_ids (plant 09 VIS-M4): which colour profile, section box, viewpoint visibility and
 * highlighted entities a render uses (parameter, else the viewpoint, else the active one), and the styled scene. Pure.
 * @invariant the scene given is never modified; styling returns a copy whose recoloured entities carry no material override
 */

import { is2D, type CadDocument, type Entity, type Vec3 } from '../../model/types';
import type { ColourProfile } from '../../model/display';
import type { SectionBox, ViewpointVisibility } from '../../model/review';
import { z } from '../schema';
import { orderedEntities } from '../entity/entityOps';
import { dot3 } from '../../lib/vec3';
import type { ExecutionContext } from '../types';
import { materialClassColour, recolouredEntity } from '../../geometry/materialClasses';
import { evaluateProfile } from '../display/displayModel';
import { hexRgb } from './frames';
import type { CutSpec } from './types';

export const reviewParams = {
  colourProfileId: z
    .string()
    .optional()
    .describe(
      'Colour the entities by this display profile (define_colour_profile): the first matching rule sets the colour (hidden rules remove the entity). ' +
        "Default: the viewpoint's profile, else the active profile (set_active_colour_profile). Unknown id: VIS_PROFILE_NOT_FOUND. data.legend lists the rules used.",
    ),
  sectionBoxId: z
    .string()
    .optional()
    .describe(
      "Clip the 3D solids to this section box (set_section_box), cut faces capped like `cut`. Default: the viewpoint's box, else the active box. " +
        'Cannot be combined with `cut` (VIS_RENDER_INVALID); with `cut` alone the viewpoint / active box is ignored. Unknown id: VIS_SECTION_BOX_NOT_FOUND.',
    ),
  shading: z
    .enum(['flat', 'review'])
    .optional()
    .describe(
      '"flat" (default): entity colours as they are. "review": the selection (viewpoint `selection`, the entities of `issueId`, `highlightEntityIds`) keeps its colour, ' +
        'every other entity is dimmed toward the background; with nothing to highlight the picture stays flat and the summary says so. Shadows and ambient occlusion are not drawn yet.',
    ),
  issueId: z
    .string()
    .optional()
    .describe('With shading "review": also highlight the entities of this review issue. Unknown id: VIS_ISSUE_NOT_FOUND.'),
  highlightEntityIds: z
    .array(z.string())
    .optional()
    .describe('With shading "review": entity ids to highlight (ids that do not exist are ignored and named in the summary).'),
};

export interface ReviewRequest {
  readonly viewpointId?: string | undefined;
  readonly colourProfileId?: string | undefined;
  readonly sectionBoxId?: string | undefined;
  readonly shading?: 'flat' | 'review' | undefined;
  readonly issueId?: string | undefined;
  readonly highlightEntityIds?: readonly string[] | undefined;
  readonly cut?: unknown;
}

export interface ReviewStyle {
  readonly profile: ColourProfile | null;
  readonly box: SectionBox | null;
  readonly visibility: ViewpointVisibility | null;
  /** Entity ids kept at full colour by `shading: 'review'`; null = flat shading. */
  readonly highlight: ReadonlySet<string> | null;
  /** Sentences for the summary (what was ignored or empty). */
  readonly notes: readonly string[];
}

export type ReviewStyleResult =
  | { readonly style: ReviewStyle }
  | { readonly code: string; readonly message: string; readonly paths: readonly string[] };

const own = <T>(record: Readonly<Record<string, T>> | undefined, id: string | undefined): T | undefined =>
  record === undefined || id === undefined || !Object.hasOwn(record, id) ? undefined : record[id];

function resolveHighlight(doc: CadDocument, request: ReviewRequest, selection: readonly string[], notes: string[]): Set<string> | string {
  const highlight = new Set(selection);
  if (request.issueId !== undefined) {
    const issue = own(doc.review?.issues, request.issueId);
    if (issue === undefined) return `no review issue '${request.issueId}'`;
    for (const id of issue.entityIds) highlight.add(id);
  }
  const unknown: string[] = [];
  for (const id of request.highlightEntityIds ?? []) {
    if (Object.hasOwn(doc.entities, id)) highlight.add(id);
    else unknown.push(id);
  }
  if (unknown.length > 0) notes.push(`Ignored ${unknown.length} unknown highlight id(s): ${unknown.slice(0, 5).join(', ')}.`);
  for (const id of [...highlight]) if (!Object.hasOwn(doc.entities, id)) highlight.delete(id);
  return highlight;
}

/**
 * Resolve the profile, section box, visibility and highlight of a render.
 * @failure unknown profile / section box / issue, section box together with cut -> code
 */
export function resolveReviewStyle(doc: CadDocument, request: ReviewRequest): ReviewStyleResult {
  const review = doc.review;
  const viewpoint = own(review?.viewpoints, request.viewpointId);
  const notes: string[] = [];
  const profileId = request.colourProfileId ?? viewpoint?.colourProfileId ?? doc.display?.activeProfileId;
  const profile = own(doc.display?.colourProfiles, profileId);
  if (
    profile === undefined &&
    profileId !== undefined &&
    (request.colourProfileId !== undefined || profileId !== doc.display?.activeProfileId)
  )
    return { code: 'VIS_PROFILE_NOT_FOUND', message: `no colour profile '${profileId}'`, paths: ['colourProfileId'] };
  if (request.sectionBoxId !== undefined && request.cut !== undefined)
    return { code: 'VIS_RENDER_INVALID', message: 'sectionBoxId cannot be combined with cut', paths: ['sectionBoxId'] };
  const boxId = request.sectionBoxId ?? viewpoint?.sectionBoxId ?? review?.activeSectionBoxId;
  let box: SectionBox | undefined;
  if (request.cut !== undefined) {
    if (boxId !== undefined) notes.push('The viewpoint / active section box is ignored: `cut` is given.');
  } else {
    box = own(review?.sectionBoxes, boxId);
    if (box === undefined && boxId !== undefined && boxId !== review?.activeSectionBoxId)
      return {
        code: 'VIS_SECTION_BOX_NOT_FOUND',
        message: `no section box '${boxId}'`,
        paths: [request.sectionBoxId !== undefined ? 'sectionBoxId' : 'viewpointId'],
      };
  }
  let highlight: Set<string> | null = null;
  if (request.shading === 'review') {
    const resolved = resolveHighlight(doc, request, viewpoint?.selection ?? [], notes);
    if (typeof resolved === 'string') return { code: 'VIS_ISSUE_NOT_FOUND', message: resolved, paths: ['issueId'] };
    if (resolved.size > 0) highlight = resolved;
    else notes.push('Review shading: nothing to highlight (no viewpoint selection, issue entities or highlightEntityIds); drawn flat.');
  } else if (request.issueId !== undefined || request.highlightEntityIds !== undefined)
    notes.push('issueId / highlightEntityIds are used with shading "review" only.');
  return { style: { profile: profile ?? null, box: box ?? null, visibility: viewpoint?.visibility ?? null, highlight, notes } };
}

/** A section box as a `cut` of mode union (any plane removes its outward side). */
export function sectionBoxCut(box: SectionBox): CutSpec {
  if (box.planes !== undefined) return { planes: box.planes.map(({ normal, offset }) => ({ normal, offset })), mode: 'union' };
  const min: Vec3 = box.min ?? [0, 0, 0];
  const max: Vec3 = box.max ?? [0, 0, 0];
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const half = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  const angle = box.rotationZ ?? 0;
  const axes: Vec3[] = [
    [Math.cos(angle), Math.sin(angle), 0],
    [-Math.sin(angle), Math.cos(angle), 0],
    [0, 0, 1],
  ];
  const planes = axes.flatMap((axis, index) =>
    ([1, -1] as const).map((sign) => {
      const normal: Vec3 = [axis[0] * sign, axis[1] * sign, axis[2] * sign];
      return { normal, offset: dot3(normal, centre) + (half[index] ?? 0) };
    }),
  );
  return { planes, mode: 'union' };
}

export interface LegendEntry {
  readonly ruleId: string;
  readonly legend: string;
  readonly colour: string;
  readonly count: number;
}

export interface StyledScene {
  readonly scene: CadDocument;
  /** One entry per rule of the profile, in rule order (count 0 when nothing matched). */
  readonly legend: LegendEntry[];
  /** Ids removed by viewpoint visibility or `hidden` profile rules. */
  readonly hiddenIds: string[];
  readonly summary: string;
}

const DEFAULT_BACKGROUND_RGB: readonly number[] = [0x1a, 0x1a, 0x2e];
const DIM_KEEP = 0.3;

function dimmed(colour: string, background: readonly number[]): string {
  const rgb = hexRgb(colour) ?? [176, 176, 176];
  return `#${rgb
    .map((c, i) =>
      Math.round(c * DIM_KEEP + (background[i] ?? 0) * (1 - DIM_KEEP))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * `scene` with viewpoint visibility and hidden rules applied, the profile colours set and (review shading) the non-selected entities dimmed.
 * @invariant instance children keep their own colours (the profile colours the instance entity only); a profile default colour applies to 3D entities only;
 *   precedence: a matching rule, then the assigned material class colour, then the profile default colour, then the entity colour
 */
export function applyReviewStyle(
  scene: CadDocument,
  style: ReviewStyle,
  ctx: ExecutionContext | undefined,
  background: string | undefined,
): StyledScene {
  const { profile, visibility, highlight } = style;
  const exceptions = new Set(visibility?.exceptions ?? []);
  const all = orderedEntities(scene).map((e) => e.id);
  const shown = visibility === null ? all : all.filter((id) => exceptions.has(id) !== visibility.defaultVisible);
  const shownSet = new Set(shown);
  const hidden = new Set(all.filter((id) => !shownSet.has(id)));
  const rules = new Map((profile === null ? [] : evaluateProfile(scene, ctx, profile, shown)).map((row) => [row.id, row.rule]));
  const counts = new Map<string, number>();
  const entities: Record<string, Entity> = {};
  const order: string[] = [];
  const backgroundRgb = hexRgb(background ?? '') ?? DEFAULT_BACKGROUND_RGB;
  for (const id of shown) {
    let entity = scene.entities[id] as Entity;
    const rule = rules.get(id) ?? null;
    const classColour = materialClassColour(scene, entity);
    if (rule?.appearance.hidden === true) {
      hidden.add(id);
      continue;
    }
    if (rule !== null) {
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
      entity = recolouredEntity(entity, rule.appearance.colour);
    } else if (classColour !== null) entity = recolouredEntity(entity, classColour);
    else if (profile !== null && profile.defaultColour !== 'entity' && !is2D(entity))
      entity = recolouredEntity(entity, profile.defaultColour);
    if (highlight !== null && !highlight.has(id)) entity = recolouredEntity(entity, dimmed(entity.color, backgroundRgb));
    entities[id] = entity;
    order.push(id);
  }
  const hiddenIds = all.filter((id) => hidden.has(id));
  const legend = (profile?.rules ?? []).map((rule) => ({
    ruleId: rule.id,
    legend: rule.legend,
    colour: rule.appearance.colour,
    count: counts.get(rule.id) ?? 0,
  }));
  const parts: string[] = [];
  if (profile !== null) parts.push(`profile ${profile.id}: ${[...counts.values()].reduce((a, b) => a + b, 0)} coloured`);
  if (hiddenIds.length > 0) parts.push(`${hiddenIds.length} hidden`);
  if (highlight !== null) parts.push(`${highlight.size} highlighted`);
  return { scene: { ...scene, entities, order }, legend, hiddenIds, summary: parts.length === 0 ? '' : `Display: ${parts.join(', ')}.` };
}
