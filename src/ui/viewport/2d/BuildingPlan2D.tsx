/**
 * BuildingPlan2D — draws the active level's floor plan (walls cut at 1.2 m and hatched, glazing, door
 * swings, columns, beams dashed, stairs, room tags, grid bubbles, dimensions) in the 2D drafting
 * view. Pure presentation of `buildPlanDrawing` (the same plan the DXF / sheet exporters use)
 * through the shared technical-drawing renderer; the BIM entities themselves are hidden in 2D
 * (Entities2D) so each level reads as one plan.
 */

import React, { useMemo } from 'react';
import { buildPlanDrawing, CATEGORY_LAYER } from '@aec/index';
import { fromMm } from '@core/model/units';
import { useStore } from '@ui/store';
import { useThemeStore } from '@ui/store/themeStore';
import { DrawingPrimitives2D } from './DrawingPrimitives2D';
import type { DrawingScale, StyledPrimitive } from './drawingGeometry';

const DIMENSION_COLOR = '#d6a243';

const LAYER_COLORS: ReadonlyMap<string, string> = new Map(Object.values(CATEGORY_LAYER).map(({ name, color }) => [name, color]));

function strokeColor(layer: string, wallStroke: string): string {
  if (layer === 'A-WALL' || layer === 'S-COLS') return wallStroke;
  return LAYER_COLORS.get(layer) ?? DIMENSION_COLOR;
}

export function BuildingPlan2D(): React.ReactElement | null {
  const building = useStore((s) => s.document.building);
  const units = useStore((s) => s.document.units);
  const layers = useStore((s) => s.document.layers);
  const theme = useThemeStore((s) => s.theme);

  const plan = useMemo(() => (building ? buildPlanDrawing({ building, units }, undefined) : null), [building, units]);
  const [wallFill, wallStroke] = theme === 'dark' ? ['#5f646e', '#d7dae0'] : ['#5a5d63', '#1f2125'];
  const items = useMemo((): StyledPrimitive[] => {
    if (!plan) return [];
    const visibleLayer = (layer: string): boolean => layers[`layer-${layer}`]?.visible !== false;
    return plan.primitives
      .filter((primitive) => visibleLayer(primitive.layer))
      .map((primitive) => ({ primitive, color: strokeColor(primitive.layer, wallStroke) }));
  }, [plan, layers, wallStroke]);
  const scale = useMemo(
    (): DrawingScale => ({
      patternUnit: fromMm({ units }, 75),
      hatchSpacing: fromMm({ units }, 150),
    }),
    [units],
  );

  return <DrawingPrimitives2D name="building-plan-2d" items={items} scale={scale} fillColor={wallFill} />;
}
