// Pure builder of the model highlight for the Manufacturing panel: the checked part is selected and a beacon sits on it carrying the
// finding (code, value against limit) or the part name. Findings carry the part id, not a point, so the beacon marks the part.

import type { CadDocument } from '@core/model/types';
import { boundsCenter, entityBoundsInDoc } from '@core/geometry/bounds';
import type { PanelFocus } from '@ui/store/focusStore';

export const FINDING_COLORS = { fail: '#ff4d4f', warn: '#ffb300', info: '#40c4ff' } as const;
const PART_COLOR = '#40c4ff';

export function partFocus(doc: CadDocument, partId: string, key: string, label: string, color: string = PART_COLOR): PanelFocus {
  const entity = doc.entities[partId];
  return {
    key: `manufacturing:${key}`,
    label,
    color,
    entityIds: entity === undefined ? [] : [partId],
    markers: entity === undefined ? [] : [{ position: boundsCenter(entityBoundsInDoc(doc, entity)), label }],
  };
}
