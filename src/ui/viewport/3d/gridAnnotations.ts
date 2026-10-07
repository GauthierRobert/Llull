/**
 * @layer ui/viewport/3d
 * Pure helper: structural-grid entities (line axes, circle bubbles, text labels on layer S-GRID) →
 * 3D annotation primitives sized relative to the grid extent so they stay readable at building
 * scale. No React / three.js.
 */

import type { Entity } from '@core/model/types';

export const GRID_LAYER_NAME = 'S-GRID';

/** Bubble radius floor, as a fraction of the grid's largest plan dimension. */
const MIN_BUBBLE_FRACTION = 0.012;

type Point3 = readonly [number, number, number];

export interface GridAxis {
  readonly id: string;
  readonly start: Point3;
  readonly end: Point3;
  readonly color: string;
}

export interface GridBubble {
  readonly id: string;
  readonly center: Point3;
  readonly radius: number;
  readonly label: string;
  readonly color: string;
}

export interface GridAnnotations {
  readonly axes: readonly GridAxis[];
  readonly bubbles: readonly GridBubble[];
}

function nearestLabel(
  center: readonly [number, number],
  texts: readonly Extract<Entity, { kind: 'text' }>[],
  within: number,
): string {
  let best = '';
  let bestDistance = within;
  for (const text of texts) {
    const distance = Math.hypot(text.position[0] - center[0], text.position[1] - center[1]);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = text.content;
    }
  }
  return best;
}

export function collectGridAnnotations(gridEntities: readonly Entity[]): GridAnnotations {
  const axes: GridAxis[] = [];
  const circles: Extract<Entity, { kind: 'circle' }>[] = [];
  const texts: Extract<Entity, { kind: 'text' }>[] = [];
  for (const entity of gridEntities) {
    if (entity.kind === 'line') {
      const [px, py, pz] = entity.position;
      axes.push({
        id: entity.id,
        start: [px + entity.start[0], py + entity.start[1], pz],
        end: [px + entity.end[0], py + entity.end[1], pz],
        color: entity.color,
      });
    } else if (entity.kind === 'circle') circles.push(entity);
    else if (entity.kind === 'text') texts.push(entity);
  }

  let extent = 0;
  for (const axis of axes) {
    extent = Math.max(
      extent,
      Math.abs(axis.end[0] - axis.start[0]),
      Math.abs(axis.end[1] - axis.start[1]),
    );
  }
  const minimumRadius = extent * MIN_BUBBLE_FRACTION;

  const bubbles = circles.map((circle): GridBubble => {
    const center: Point3 = [
      circle.position[0] + circle.center[0],
      circle.position[1] + circle.center[1],
      circle.position[2],
    ];
    return {
      id: circle.id,
      center,
      radius: Math.max(circle.radius, minimumRadius),
      label: nearestLabel([center[0], center[1]], texts, circle.radius * 2),
      color: circle.color,
    };
  });
  return { axes, bubbles };
}
