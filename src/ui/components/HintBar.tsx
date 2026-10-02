/**
 * @layer ui/components
 *
 * HintBar — a single-line overlay at the bottom of the viewport telling the user what they can
 * do right now (text from hintText). Presentation only.
 */

import React from 'react';
import { useStore, useToolStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { hintText } from './hintText';

export function HintBar(): React.ReactElement {
  const viewMode = useToolStore((s) => s.viewMode);
  const drawTool = useToolStore((s) => s.drawTool);
  const gizmoMode = useToolStore((s) => s.gizmoMode);
  const selectionCount = useStore((s) => s.document.selection.length);
  const entityCount = useStore((s) => s.document.order.length);
  const text = hintText({ viewMode, drawTool, gizmoMode, selectionCount, entityCount });
  return (
    <div className="hint-bar" role="status" aria-live="polite" aria-label="Hint">
      <Icon name="info" size={14} />
      <span>{text}</span>
    </div>
  );
}
