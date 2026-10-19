import type { Compiled } from './compileContext';
import { lineOf, type Layout } from './layout';
import { at } from './linalg';

/**
 * Equations that keep the size of the given curves as they are now: line length, circle/arc radius, arc sweep. The solver first tries to
 * satisfy the constraints with these added, so an orientation or position constraint moves a curve instead of stretching it; when the
 * extra equations contradict a dimension, it falls back to the plain system.
 */
export function sizePreservation(layout: Layout, entityIds: Iterable<string>): Compiled[] {
  const rows: Compiled[] = [];
  const x0 = layout.x0;
  for (const id of entityIds) {
    const block = layout.blocks.get(id);
    if (!block) continue;
    const o = block.offset;
    if (block.kind === 'line') {
      const length = (x: Float64Array): number => {
        const line = lineOf(layout, x, id);
        return line ? Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]) : 0;
      };
      const original = length(x0);
      rows.push({ id, entities: [id], rows: 1, evaluate: (x, out, row) => void (out[row] = length(x) - original) });
    } else if (block.kind === 'circle' || block.kind === 'arc') {
      const sweep0 = block.kind === 'arc' ? at(x0, o + 4) - at(x0, o + 3) : 0;
      rows.push({
        id,
        entities: [id],
        rows: block.kind === 'arc' ? 2 : 1,
        evaluate: (x, out, row) => {
          out[row] = Math.abs(at(x, o + 2)) - Math.abs(at(x0, o + 2));
          if (block.kind === 'arc') out[row + 1] = at(x, o + 4) - at(x, o + 3) - sweep0;
        },
      });
    }
  }
  return rows;
}
