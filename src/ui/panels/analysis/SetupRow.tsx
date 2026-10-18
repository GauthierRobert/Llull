// One clickable row of the Analysis panel: swatch == the glyph colour on the model, value + unit in the meta, click highlights it there.

import React from 'react';
import { ListRow } from '@ui/panels/PanelParts';
import { useIsFocused } from '@ui/store/focusStore';
import type { SetupItem } from './analysisItems';
import { useFocusSetupItem } from './useFocusSetupItem';

interface SetupRowProps {
  item: SetupItem;
  /** Value + unit shown right of the name. */
  meta: string;
  /** Recorded set-up in words (second line). */
  detail?: string;
  testId?: string;
}

export function SetupRow({ item, meta, detail, testId }: SetupRowProps): React.ReactElement {
  const focused = useIsFocused(item.key);
  const focus = useFocusSetupItem();
  return (
    <ListRow
      swatch={item.color}
      selected={focused}
      pressed={focused}
      label={`Show ${item.name} on the model`}
      {...(testId !== undefined ? { testId } : {})}
      onSelect={() => focus(item)}
    >
      <span className="panel__row-main">{item.name}</span>
      <span className="panel__row-meta">{meta}</span>
      {detail !== undefined && <span className="analysis__item-detail">{detail}</span>}
    </ListRow>
  );
}
