// One drag gesture on a feature handle: pointer rays in, handle values out. Holds only the drag's start state; no three.js, no store.

import { type Vec3, axisParamFromRay, draggedValue } from './manipulatorMath';

interface Ray {
  origin: Vec3;
  direction: Vec3;
}

export interface HandleDragConfig {
  /** Handle line in the SAME space as the rays. */
  origin: Vec3;
  axis: Vec3;
  step: number;
  minimum: number;
}

export interface HandleDrag {
  /** Grab the handle at `value`; false when the ray cannot resolve a position on the axis (looking straight down it). */
  begin(ray: Ray, value: number): boolean;
  /** New value for the pointer ray, or null when no drag is active / the ray is degenerate. */
  move(ray: Ray): number | null;
  /** Finish; true when the value moved away from where it was grabbed (a plain click commits nothing). */
  end(): boolean;
}

export function createHandleDrag(config: HandleDragConfig): HandleDrag {
  let start: { param: number; value: number } | null = null;
  let latest = 0;
  return {
    begin(ray, value): boolean {
      const param = axisParamFromRay(config.origin, config.axis, ray.origin, ray.direction);
      if (param === null) return false;
      start = { param, value };
      latest = value;
      return true;
    },
    move(ray): number | null {
      if (start === null) return null;
      const param = axisParamFromRay(config.origin, config.axis, ray.origin, ray.direction);
      if (param === null) return null;
      latest = draggedValue(start.value, start.param, param, config.step, config.minimum);
      return latest;
    },
    end(): boolean {
      const changed = start !== null && Math.abs(latest - start.value) > 1e-9;
      start = null;
      return changed;
    },
  };
}
