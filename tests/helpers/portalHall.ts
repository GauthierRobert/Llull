import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

/** `add_portal_frame_building` applied to `base` (default: an empty document). */
export function portalHall(
  params: Record<string, unknown>,
  base: CadDocument = createEmptyDocument(),
): CadDocument {
  return execute(base, 'add_portal_frame_building', params).document;
}
