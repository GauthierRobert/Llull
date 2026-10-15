// One-line viewport overlay while a tool is armed: what the user can do now (hintText).

import React from 'react';
import { useStore, useToolStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { hintText } from './hintText';

export function HintBar(): React.ReactElement | null {
  const viewMode = useToolStore((s) => s.viewMode);
  const drawTool = useToolStore((s) => s.drawTool);
  const modifyTool = useToolStore((s) => s.modifyTool);
  const gizmoMode = useToolStore((s) => s.gizmoMode);
  const selectionCount = useStore((s) => s.document.selection.length);
  const entityCount = useStore((s) => s.document.order.length);
  // On demand: guidance only while a draw or modify tool is in hand.
  if (drawTool === 'none' && modifyTool === 'none') return null;
  const text = hintText({ viewMode, drawTool, modifyTool, gizmoMode, selectionCount, entityCount });
  return (
    <div className="hint-bar" role="status" aria-live="polite" aria-label="Hint">
      <Icon name="info" size={14} />
      <span>{text}</span>
    </div>
  );
}
