import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

/** The 24 m × 30 m portal-frame hall shared by the steel design tests. */
export const HALL = { span: 24000, length: 30000 };

export function hall(params: Record<string, unknown> = {}): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', { ...HALL, ...params }).document;
}
