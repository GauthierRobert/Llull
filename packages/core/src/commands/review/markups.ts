/** Markups (plant 09 VIS §4): redlines drawn on a saved viewpoint, in screen space (the viewpoint image) or world space (BCF Lines). metaHistory. */

import { MARKUP_SHAPES, type Markup, type MarkupShape } from '../../model/review';
import type { Vec2, Vec3 } from '../../model/vectors';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { mintReviewId, reviewOf, reviewRejection } from './reviewModel';

const MAX_POINTS = 256;
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** Inclusive point-count range per shape. */
const POINT_RANGE: Readonly<Record<MarkupShape, readonly [number, number]>> = {
  line: [2, 2],
  polyline: [2, MAX_POINTS],
  arrow: [2, 2],
  cloud: [3, MAX_POINTS],
  ellipse: [2, 2],
  text: [1, 1],
};

/** The reason the points do not fit `shape` in `space`, or the typed points. */
function checkPoints(shape: MarkupShape, space: 'screen' | 'world', raw: readonly (readonly number[])[]): string | Array<Vec2 | Vec3> {
  const [low, high] = POINT_RANGE[shape];
  if (raw.length < low || raw.length > high)
    return `a ${shape} needs ${low === high ? low : `${low}..${high}`} point(s), got ${raw.length}`;
  const width = space === 'screen' ? 2 : 3;
  const bad = raw.find((point) => point.length !== width || !point.every(Number.isFinite));
  if (bad !== undefined) return `${space} points are finite [${width === 2 ? 'x, y' : 'x, y, z'}], got [${bad.join(', ')}]`;
  if (space === 'screen' && raw.some((point) => point.some((value) => value < 0 || value > 1)))
    return 'screen points must lie in [0, 1] x [0, 1] (normalised viewpoint image)';
  return raw.map((point) =>
    space === 'screen' ? ([point[0] ?? 0, point[1] ?? 0] as Vec2) : ([point[0] ?? 0, point[1] ?? 0, point[2] ?? 0] as Vec3),
  );
}

/**
 * @affects adds 1 markup to doc.review (affected: [id], id `mk-<n>`); metaHistory
 * @invariant screen points are in [0, 1]²; point count fits the shape; colour is #rrggbb (stored lower case)
 * @failure unknown viewpoint -> VIS_VIEWPOINT_NOT_FOUND; bad points / text -> VIS_MARKUP_INVALID; bad colour -> VIS_COLOUR_INVALID
 */
export const addMarkup = defineCommand({
  name: 'add_markup',
  description:
    'Draw a redline on a saved viewpoint (vp-<n>): `shape` line (2 points), polyline (2..256), arrow (2: tail, head), cloud (3..256 vertices), ellipse (2 opposite ' +
    'corners of its bounding box) or text (1 anchor point, needs `text`). `space` "screen": points are [x, y] in [0, 1] of the viewpoint image (origin top-left); ' +
    '"world": points are [x, y, z] in document units (BCF Lines). `colour` is #rrggbb. Returns the id (mk-<n>) in affected[0] and data { id }. ' +
    'Deleting the viewpoint deletes its markups. Does not add a feature step. Errors: VIS_VIEWPOINT_NOT_FOUND, VIS_MARKUP_INVALID, VIS_COLOUR_INVALID.',
  annotations: { metaHistory: true },
  params: z.object({
    viewpointId: z.string().describe('Saved viewpoint id (vp-<n>) the redline belongs to.'),
    shape: z.enum(MARKUP_SHAPES).describe('"line", "polyline", "arrow", "cloud", "ellipse" or "text".'),
    space: z.enum(['screen', 'world']).describe('"screen": [x, y] in [0, 1] of the viewpoint image; "world": [x, y, z] in document units.'),
    points: z.array(z.array(z.number())).describe('The points; their number depends on the shape (see the description).'),
    colour: z.string().describe('Line colour as #rrggbb, e.g. "#e03030".'),
    text: z.string().optional().describe('Label (required for shape "text", optional note on the other shapes).'),
    lineWidthPx: z.number().positive().optional().describe('Line width in pixels of the viewpoint image. Default 2.'),
    author: z
      .enum(['agent', 'human'])
      .optional()
      .describe('Who drew it, as a label only (not verified). Default "agent"; the UI sends "human".'),
  }),
  run: (doc, params): CommandResult => {
    const review = reviewOf(doc);
    if (review.viewpoints[params.viewpointId] === undefined)
      return reviewRejection(
        doc,
        'add_markup',
        'VIS_VIEWPOINT_NOT_FOUND',
        `no viewpoint '${params.viewpointId}'`,
        [params.viewpointId],
        ['viewpointId'],
      );
    if (!HEX_COLOUR.test(params.colour))
      return reviewRejection(doc, 'add_markup', 'VIS_COLOUR_INVALID', `'${params.colour}' is not #rrggbb`, [], ['colour']);
    const points = checkPoints(params.shape, params.space, params.points);
    if (typeof points === 'string') return reviewRejection(doc, 'add_markup', 'VIS_MARKUP_INVALID', points, [], ['points']);
    const text = params.text?.trim();
    if (params.shape === 'text' && (text === undefined || text.length === 0))
      return reviewRejection(doc, 'add_markup', 'VIS_MARKUP_INVALID', 'a text markup needs non-empty text', [], ['text']);
    const [id, next] = mintReviewId(review, 'mk');
    const markup: Markup = {
      id,
      viewpointId: params.viewpointId,
      shape: params.shape,
      space: params.space,
      points,
      colour: params.colour.toLowerCase(),
      ...(text === undefined || text.length === 0 ? {} : { text }),
      ...(params.lineWidthPx === undefined ? {} : { lineWidthPx: params.lineWidthPx }),
      author: params.author ?? 'agent',
    };
    const document = { ...doc, review: { ...next, markups: { ...next.markups, [id]: markup } } };
    const result = changed(
      document,
      `Added ${markup.shape} markup ${id} (${markup.space}, ${points.length} point(s)) to viewpoint ${markup.viewpointId}.`,
      [id],
    );
    return { ...result, data: { id } };
  },
});

/**
 * @affects removes 1 markup from doc.review (affected: [id]); metaHistory
 * @failure unknown id -> VIS_MARKUP_NOT_FOUND
 */
export const deleteMarkup = defineCommand({
  name: 'delete_markup',
  description: 'Delete a markup (mk-<n>) from its viewpoint. Unknown id: VIS_MARKUP_NOT_FOUND. Does not add a feature step.',
  annotations: { metaHistory: true, destructive: true },
  params: z.object({ id: z.string().describe('Markup id, e.g. "mk-3".') }),
  run: (doc, { id }): CommandResult => {
    const review = reviewOf(doc);
    if (review.markups[id] === undefined) return reviewRejection(doc, 'delete_markup', 'VIS_MARKUP_NOT_FOUND', `no markup '${id}'`, [id]);
    const markups = Object.fromEntries(Object.entries(review.markups).filter(([key]) => key !== id));
    return changed({ ...doc, review: { ...review, markups } }, `Deleted markup ${id}.`, [id]);
  },
});
