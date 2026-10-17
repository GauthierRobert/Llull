/** Recomputes the world frames of every flat from the root frame and the bends (frames are derived data of the graph). */

import type { SheetMetalPart, SheetNode } from '@core/model/sheetMetal';
import { bendGeometry, bottomOffset } from './frames';
import { childBends, flatOf } from './graph';

export function relayout(part: SheetMetalPart, thickness: number): SheetMetalPart {
  const bottom = bottomOffset(part.side, thickness);
  const nodes: Record<string, SheetNode> = { ...part.nodes };
  const visit = (flatId: string): void => {
    const parent = nodes[flatId];
    if (parent?.type !== 'flat') return;
    for (const bend of childBends(part, flatId)) {
      const child = flatOf(part, bend.to);
      if (child === undefined) continue;
      const geometry = bendGeometry(parent.frame, bend.lineInFrom, bend.angle, bend.insideRadius, thickness, bottom);
      nodes[child.id] = { ...child, frame: geometry.child };
      visit(child.id);
    }
  };
  visit(part.root);
  return { ...part, nodes };
}
