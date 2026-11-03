// The active P&ID sheet in 2D (symbols, lines with flow arrows, tags) from `buildPidDrawing`, the model `export_pid_svg` draws; the picked item is redrawn on top in the highlight colour.

import React, { useCallback, useMemo } from 'react';
import { fromMm } from '@core/model/units';
import { useStore } from '@ui/store';
import { usePidViewStore } from '@ui/store/pidViewStore';
import { useThemeStore } from '@ui/store/themeStore';
import { DrawingPrimitives2D } from './DrawingPrimitives2D';
import type { DrawingScale } from './drawingGeometry';
import { PID_HIGHLIGHT, PID_PALETTE_DARK, PID_PALETTE_LIGHT, pidSheetItems } from './pidSheetItems';

export function PidSheet2D(): React.ReactElement | null {
  const pid = useStore((s) => s.document.plant?.pid);
  const units = useStore((s) => s.document.units);
  const layers = useStore((s) => s.document.layers);
  const theme = useThemeStore((s) => s.theme);
  const activeSheetId = usePidViewStore((s) => s.activeSheetId);
  const pickedId = usePidViewStore((s) => s.picked?.id);
  const isLayerVisible = useCallback((layer: string): boolean => layers[`layer-${layer}`]?.visible !== false, [layers]);
  const palette = theme === 'dark' ? PID_PALETTE_DARK : PID_PALETTE_LIGHT;
  const items = useMemo(() => pidSheetItems(pid, palette, isLayerVisible, activeSheetId), [pid, palette, isLayerVisible, activeSheetId]);
  const highlight = useMemo(
    () =>
      pickedId === undefined
        ? []
        : pidSheetItems(pid, palette, isLayerVisible, activeSheetId, { itemId: pickedId, color: PID_HIGHLIGHT[theme] }),
    [pid, palette, isLayerVisible, activeSheetId, pickedId, theme],
  );
  const scale = useMemo((): DrawingScale => ({ patternUnit: fromMm({ units }, 75), hatchSpacing: fromMm({ units }, 150) }), [units]);
  return (
    <>
      <DrawingPrimitives2D name="pid-sheet-2d" items={items} scale={scale} fillColor="#5f646e" />
      <group position={[0, 0, 0.001]}>
        <DrawingPrimitives2D name="pid-pick-2d" items={highlight} scale={scale} fillColor="#5f646e" />
      </group>
    </>
  );
}
