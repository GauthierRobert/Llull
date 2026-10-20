/** Walkthroughs (plant 09 VIS §4): a timed path through saved viewpoints, rendered by render_walkthrough. metaHistory. */

import type { Walkthrough } from '../../model/review';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { mintReviewId, reviewOf, reviewRejection } from './reviewModel';

const MAX_KEYS = 500;

/**
 * @affects adds 1 walkthrough to doc.review (affected: [id], id `wt-<n>`); metaHistory
 * @invariant 2..500 keys, every viewpoint exists, one projection for all keys, seconds > 0
 * @failure otherwise -> VIS_WALKTHROUGH_INVALID / VIS_VIEWPOINT_NOT_FOUND
 */
export const createWalkthrough = defineCommand({
  name: 'create_walkthrough',
  description:
    'Create a walkthrough: an ordered list of saved viewpoints (save_viewpoint) with the seconds spent moving from each key to the next ' +
    "(the last key's seconds are ignored). The camera glides between keys (eye linear, direction / up spherical). All keys must share one " +
    'projection. Returns the id (wt-<n>) in affected[0] and data { id, durationS }. Render it with render_walkthrough. Does not add a ' +
    'feature step. Errors: VIS_WALKTHROUGH_INVALID, VIS_VIEWPOINT_NOT_FOUND.',
  annotations: { metaHistory: true },
  params: z.object({
    name: z.string().describe('Walkthrough name, e.g. "Pipe rack fly-through".'),
    keys: z
      .array(
        z.object({
          viewpointId: z.string().describe('Saved viewpoint id (vp-<n>).'),
          seconds: z.number().describe('Seconds from this key to the next, > 0.'),
        }),
      )
      .describe('2..500 keys in playing order.'),
  }),
  run: (doc, { name, keys }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = []): CommandResult =>
      reviewRejection(doc, 'create_walkthrough', code, message, ids, ['keys']);
    if (keys.length < 2 || keys.length > MAX_KEYS) return fail('VIS_WALKTHROUGH_INVALID', `needs 2..${MAX_KEYS} keys, got ${keys.length}`);
    const review = reviewOf(doc);
    const missing = keys.map((key) => key.viewpointId).filter((id) => review.viewpoints[id] === undefined);
    if (missing.length > 0) return fail('VIS_VIEWPOINT_NOT_FOUND', `unknown viewpoint(s) ${missing.join(', ')}`, missing);
    if (keys.some((key) => !(key.seconds > 0) || !Number.isFinite(key.seconds)))
      return fail('VIS_WALKTHROUGH_INVALID', 'every key needs finite seconds > 0');
    const projections = new Set(keys.map((key) => review.viewpoints[key.viewpointId]?.camera.projection));
    if (projections.size > 1) return fail('VIS_WALKTHROUGH_INVALID', 'keys mix perspective and orthographic viewpoints');
    const [id, next] = mintReviewId(review, 'wt');
    const walkthrough: Walkthrough = { id, name, keys: keys.map(({ viewpointId, seconds }) => ({ viewpointId, seconds })) };
    const durationS = keys.slice(0, -1).reduce((sum, key) => sum + key.seconds, 0);
    const document = { ...doc, review: { ...next, walkthroughs: { ...next.walkthroughs, [id]: walkthrough } } };
    const result = changed(document, `Created walkthrough ${id} "${name}": ${keys.length} keys, ${durationS} s.`, [id]);
    return { ...result, data: { id, durationS } };
  },
});

/**
 * @affects removes 1 walkthrough (affected: [id]); metaHistory
 * @failure unknown id -> VIS_WALKTHROUGH_NOT_FOUND
 */
export const deleteWalkthrough = defineCommand({
  name: 'delete_walkthrough',
  description: 'Delete a walkthrough (wt-<n>); its viewpoints stay. Unknown id: VIS_WALKTHROUGH_NOT_FOUND. Does not add a feature step.',
  annotations: { metaHistory: true, destructive: true },
  params: z.object({ id: z.string().describe('Walkthrough id, e.g. "wt-3".') }),
  run: (doc, { id }): CommandResult => {
    const review = reviewOf(doc);
    if (review.walkthroughs[id] === undefined)
      return reviewRejection(doc, 'delete_walkthrough', 'VIS_WALKTHROUGH_NOT_FOUND', `no walkthrough '${id}'`, [id]);
    const walkthroughs = Object.fromEntries(Object.entries(review.walkthroughs).filter(([key]) => key !== id));
    return changed({ ...doc, review: { ...review, walkthroughs } }, `Deleted walkthrough ${id}.`, [id]);
  },
});
