/** What a viewpoint carries besides its camera (plant 09 VIS §3.2): section box, colour profile, visibility and selection; the shared params and reference checks. */

import { findProfile } from '../../model/display';
import type { Viewpoint, ViewpointVisibility } from '../../model/review';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { z } from '../schema';
import { displayOf } from '../display/displayModel';
import { reviewOf, reviewRejection } from './reviewModel';

export const viewpointStateParams = {
  sectionBoxId: z.string().optional().describe('Section box (sb-<n>, from set_section_box) shown with this viewpoint.'),
  colourProfileId: z.string().optional().describe('Colour profile (define_colour_profile) shown with this viewpoint.'),
  visibility: z
    .object({
      defaultVisible: z.boolean().describe('true: everything is visible except `exceptions`; false: only `exceptions` are visible.'),
      exceptions: z.array(z.string()).describe('Entity ids that deviate from defaultVisible.'),
    })
    .optional()
    .describe('BCF Visibility: which entities the viewpoint shows.'),
  selection: z.array(z.string()).optional().describe('Entities selected (highlighted) in the viewpoint.'),
};

export interface ViewpointState {
  sectionBoxId?: string | undefined;
  colourProfileId?: string | undefined;
  visibility?: ViewpointVisibility | undefined;
  selection?: readonly string[] | undefined;
}

/** The rejection for the first dangling reference of `state` (section box, profile, entity ids), or null when all exist. */
export function viewpointStateRejection(doc: CadDocument, command: string, state: ViewpointState): CommandResult | null {
  const review = reviewOf(doc);
  if (state.sectionBoxId !== undefined && review.sectionBoxes[state.sectionBoxId] === undefined)
    return reviewRejection(
      doc,
      command,
      'VIS_SECTION_BOX_NOT_FOUND',
      `no section box '${state.sectionBoxId}'`,
      [state.sectionBoxId],
      ['sectionBoxId'],
    );
  if (state.colourProfileId !== undefined && findProfile(displayOf(doc), state.colourProfileId) === undefined)
    return reviewRejection(
      doc,
      command,
      'VIS_PROFILE_NOT_FOUND',
      `no colour profile '${state.colourProfileId}'`,
      [state.colourProfileId],
      ['colourProfileId'],
    );
  const missing = [...(state.selection ?? []), ...(state.visibility?.exceptions ?? [])].filter((id) => doc.entities[id] === undefined);
  if (missing.length > 0)
    return reviewRejection(doc, command, 'VIS_ENTITY_NOT_FOUND', `unknown entit(ies) ${[...new Set(missing)].join(', ')}`, [
      ...new Set(missing),
    ]);
  return null;
}

/** The optional viewpoint fields of `state`, deduplicated, without the undefined ones (exactOptionalPropertyTypes). */
export function viewpointStateFields(state: ViewpointState): Partial<Viewpoint> {
  return {
    ...(state.sectionBoxId === undefined ? {} : { sectionBoxId: state.sectionBoxId }),
    ...(state.colourProfileId === undefined ? {} : { colourProfileId: state.colourProfileId }),
    ...(state.visibility === undefined
      ? {}
      : { visibility: { defaultVisible: state.visibility.defaultVisible, exceptions: [...new Set(state.visibility.exceptions)] } }),
    ...(state.selection === undefined ? {} : { selection: [...new Set(state.selection)] }),
  };
}
