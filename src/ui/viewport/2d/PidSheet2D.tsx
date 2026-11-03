// The first P&ID sheet in 2D (symbols, lines with flow arrows, tags) from `buildPidDrawing`, the model `export_pid_svg` draws.

import React, { useMemo } from 'react';
import { fromMm } from '@core/model/units';
import { useStore } from '@ui/store';
import { useThemeStore } from '@ui/store/themeStore';
import { DrawingPrimitives2D } from './DrawingPrimitives2D';
import type { DrawingScale } from './drawingGeometry';
import { PID_PALETTE_DARK, PID_PALETTE_LIGHT, pidSheetItems } from './pidSheetItems';

export function PidSheet2D(): React.ReactElement | null {
  const pid = useStore((s) => s.document.plant?.pid);
  const units = useStore((s) => s.document.units);
  const layers = useStore((s) => s.document.layers);
  const theme = useThemeStore((s) => s.theme);
  const items = useMemo(
    () =>
      pidSheetItems(pid, theme === 'dark' ? PID_PALETTE_DARK : PID_PALETTE_LIGHT, (layer) => layers[`layer-${layer}`]?.visible !== false),
    [pid, layers, theme],
  );
  const scale = useMemo((): DrawingScale => ({ patternUnit: fromMm({ units }, 75), hatchSpacing: fromMm({ units }, 150) }), [units]);
  return <DrawingPrimitives2D name="pid-sheet-2d" items={items} scale={scale} fillColor="#5f646e" />;
}
