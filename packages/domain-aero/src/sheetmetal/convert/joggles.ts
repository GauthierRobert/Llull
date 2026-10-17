/** Recognises joggles in a converted graph: two reverse bends of equal angle and radius around one short inclined flat. */

import type { SheetNode } from '@core/model/sheetMetal';

type Bend = Extract<SheetNode, { type: 'bend' }>;

/** Joggle records for every inclined flat that joins two opposite, equal bends. */
export function recogniseJoggles(nodes: readonly SheetNode[], thickness: number): SheetNode[] {
  const bends = nodes.filter((node): node is Bend => node.type === 'bend');
  const flats = new Map(nodes.flatMap((node) => (node.type === 'flat' ? [[node.id, node] as const] : [])));
  const found: SheetNode[] = [];
  for (const first of bends) {
    const second = bends.find((bend) => bend.from === first.to);
    const incline = flats.get(first.to);
    const children = bends.filter((bend) => bend.from === first.to);
    if (second === undefined || incline === undefined || children.length !== 1) continue;
    const phi = Math.abs(first.angle);
    const opposite = Math.abs(first.angle + second.angle) < 1e-6 && phi <= Math.PI / 2 + 1e-9;
    if (!opposite || Math.abs(first.insideRadius - second.insideRadius) > 1e-6 * Math.max(1, thickness)) continue;
    const straight = Math.max(...incline.outline.map((point) => point[1]));
    const rm = first.insideRadius + thickness / 2;
    found.push({
      id: `j${found.length + 1}`,
      type: 'joggle',
      on: first.from,
      bends: [first.id, second.id],
      incline: incline.id,
      after: second.to,
      line: first.lineInFrom,
      offset: 2 * rm * (1 - Math.cos(phi)) + straight * Math.sin(phi),
      angle: phi,
      insideRadius: first.insideRadius,
    });
  }
  return found;
}
