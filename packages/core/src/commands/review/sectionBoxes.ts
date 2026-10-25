/** Section boxes (plant 09 VIS §4, §5.4): set, delete and classify. A section box is review data; the viewport and render_view clip with the active one. metaHistory. */

import type { SectionBox } from '../../model/review';
import { classifyAgainstSection, normalizeSectionPlanes, sectionBoxProblem } from '../../geometry/sectionBox';
import { entityBoundsInDoc } from '../../geometry/bounds';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { changed, report } from '../noop';
import { mintReviewId, reviewOf, reviewRejection } from './reviewModel';

const planeParam = z.object({
  normal: vec3('Plane normal [x, y, z], pointing to the REMOVED side (BCF ClippingPlane). Any non-zero length; normalised on save.'),
  offset: z.number().describe('Plane offset along the unit normal in document units: points with normal·p > offset are removed.'),
});

/**
 * @affects adds doc.review.sectionBoxes[id] (affected: [id], id `sb-<n>`), or replaces the box named by `id`; with activate also sets doc.review.activeSectionBoxId; metaHistory
 * @invariant exactly one form: min < max (+ rotationZ) or 1..6 planes; unit plane normals
 * @failure invalid box -> VIS_SECTION_BOX_INVALID; unknown id -> VIS_SECTION_BOX_NOT_FOUND
 */
export const setSectionBox = defineCommand({
  name: 'set_section_box',
  description:
    'Create (or, with id, replace) a review section box that cuts the model away: give `min` and `max` corners ([x, y, z], document units, min below max on ' +
    'every axis; everything outside is removed) and optional `rotationZ` radians about the box centre, OR 1..6 `planes` (half-spaces, normals point to the ' +
    'removed side), not both. `activate` makes it the active section box (the one the viewport and render_view clip with). Returns the id (sb-<n>) in ' +
    'affected[0] and data { id }. Save it with a viewpoint (save_viewpoint sectionBoxId); classify entities with section_box_report. Does not add a feature step. ' +
    'Errors: VIS_SECTION_BOX_INVALID, VIS_SECTION_BOX_NOT_FOUND.',
  annotations: { metaHistory: true },
  params: z.object({
    name: z.string().describe('Box name, e.g. "Pump skid".'),
    min: vec3('Lower corner [x, y, z] of the box in document units.').optional(),
    max: vec3('Upper corner [x, y, z] of the box in document units.').optional(),
    rotationZ: z.number().optional().describe('Radians about the box centre (Z axis). Default 0. Only with min / max.'),
    planes: z.array(planeParam).optional().describe('1..6 clipping half-spaces instead of min / max.'),
    id: z.string().optional().describe('Existing section box id (sb-<n>) to replace. Omit to create a new one.'),
    activate: z.boolean().optional().describe('true: make this the active section box. Default false.'),
  }),
  run: (doc, params): CommandResult => {
    const review = reviewOf(doc);
    if (params.id !== undefined && review.sectionBoxes[params.id] === undefined)
      return reviewRejection(doc, 'set_section_box', 'VIS_SECTION_BOX_NOT_FOUND', `no section box '${params.id}'`, [params.id], ['id']);
    const problem = sectionBoxProblem(params);
    if (problem !== null) return reviewRejection(doc, 'set_section_box', 'VIS_SECTION_BOX_INVALID', problem, [], ['min', 'max', 'planes']);
    const [id, next] = params.id === undefined ? mintReviewId(review, 'sb') : [params.id, review];
    const box: SectionBox = {
      id,
      name: params.name,
      ...(params.planes === undefined
        ? {
            ...(params.min === undefined ? {} : { min: params.min }),
            ...(params.max === undefined ? {} : { max: params.max }),
            ...(params.rotationZ !== undefined && params.rotationZ !== 0 ? { rotationZ: params.rotationZ } : {}),
          }
        : { planes: normalizeSectionPlanes(params.planes) }),
    };
    const sectionBoxes = { ...next.sectionBoxes, [id]: box };
    const activeSectionBoxId = params.activate === true ? id : next.activeSectionBoxId;
    const document = { ...doc, review: { ...next, sectionBoxes, ...(activeSectionBoxId === undefined ? {} : { activeSectionBoxId }) } };
    const form = box.planes === undefined ? 'box' : `${box.planes.length} plane(s)`;
    const result = changed(document, `${params.id === undefined ? 'Created' : 'Replaced'} section box ${id} "${box.name}" (${form}).`, [
      id,
    ]);
    return { ...result, data: { id } };
  },
});

/**
 * @affects removes doc.review.sectionBoxes[id] (affected: [id]); metaHistory
 * @failure unknown id -> VIS_SECTION_BOX_NOT_FOUND; referenced by a viewpoint -> VIS_SECTION_BOX_IN_USE
 */
export const deleteSectionBox = defineCommand({
  name: 'delete_section_box',
  description:
    'Delete a section box (sb-<n>). Refused while a saved viewpoint references it (VIS_SECTION_BOX_IN_USE: update_viewpoint / delete_viewpoint first). ' +
    'Deleting the active box clears the active section box. Unknown id: VIS_SECTION_BOX_NOT_FOUND. Does not add a feature step.',
  annotations: { metaHistory: true, destructive: true },
  params: z.object({ id: z.string().describe('Section box id, e.g. "sb-2".') }),
  run: (doc, { id }): CommandResult => {
    const review = reviewOf(doc);
    if (review.sectionBoxes[id] === undefined)
      return reviewRejection(doc, 'delete_section_box', 'VIS_SECTION_BOX_NOT_FOUND', `no section box '${id}'`, [id]);
    const users = review.viewpointOrder.filter((viewpointId) => review.viewpoints[viewpointId]?.sectionBoxId === id);
    if (users.length > 0)
      return reviewRejection(
        doc,
        'delete_section_box',
        'VIS_SECTION_BOX_IN_USE',
        `section box '${id}' is used by ${users.join(', ')}`,
        users,
      );
    const { activeSectionBoxId, ...rest } = review;
    const sectionBoxes = Object.fromEntries(Object.entries(review.sectionBoxes).filter(([key]) => key !== id));
    const keepActive = activeSectionBoxId !== undefined && activeSectionBoxId !== id;
    return changed(
      { ...doc, review: { ...rest, sectionBoxes, ...(keepActive ? { activeSectionBoxId } : {}) } },
      `Deleted section box ${id}.`,
      [id],
    );
  },
});

/** @affects nothing — read-only; data { inside, crossing, outside, counts, warnings } in document order */
export const sectionBoxReport = defineCommand({
  name: 'section_box_report',
  description:
    'Classify every entity against a section box (sb-<n>) by its world bounding box: `inside` (box contained), `crossing` (cut by the box, or touching it) and ' +
    '`outside` (removed). A rotated box is tested in its own frame (conservative for rotated parts). data: { inside[], crossing[], outside[], counts, warnings[] } ' +
    'in document order; warning VIS_SECTION_BOX_EMPTY when nothing is inside or crossing. Read-only. Error: VIS_SECTION_BOX_NOT_FOUND.',
  annotations: { readOnly: true },
  params: z.object({ id: z.string().describe('Section box id, e.g. "sb-1".') }),
  run: (doc, { id }): CommandResult => {
    const box = reviewOf(doc).sectionBoxes[id];
    if (box === undefined) return reviewRejection(doc, 'section_box_report', 'VIS_SECTION_BOX_NOT_FOUND', `no section box '${id}'`, [id]);
    const groups: Record<'inside' | 'crossing' | 'outside', string[]> = { inside: [], crossing: [], outside: [] };
    for (const entityId of doc.order) {
      const entity = doc.entities[entityId];
      if (entity !== undefined) groups[classifyAgainstSection(box, entityBoundsInDoc(doc, entity))].push(entityId);
    }
    const counts = { inside: groups.inside.length, crossing: groups.crossing.length, outside: groups.outside.length };
    const warnings =
      counts.inside + counts.crossing === 0
        ? [{ code: 'VIS_SECTION_BOX_EMPTY', message: `section box ${id} contains and cuts nothing`, remediation: 'enlarge the box' }]
        : [];
    return report(
      doc,
      `Section box ${id}: ${counts.inside} inside, ${counts.crossing} crossing, ${counts.outside} outside${warnings.length > 0 ? ' (empty)' : ''}.`,
      { id, ...groups, counts, warnings },
    );
  },
});
