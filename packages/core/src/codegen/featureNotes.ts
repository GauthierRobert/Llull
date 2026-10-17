/** Comment lines that accompany a lowered hole / pocket in generated code: the CadQuery idiom it stands for, drill point, thread (07 FTR §6). */

import type { HoleSpec } from '../model/features';
import type { FeatureRecipe } from '../geometry/featureLowering';
import { formatNumber } from './format';

const numbers = (values: readonly number[]): string => values.map(formatNumber).join(', ');

/** The CadQuery workplane call of one hole kind (`depth` omitted = through). */
function cadqueryCall(hole: HoleSpec, depth: string): string {
  if (hole.kind === 'countersink') return `.cskHole(${numbers([hole.diameter, hole.cskDiameter ?? 0, hole.cskAngle ?? 0])}${depth})`;
  if (hole.kind === 'counterbore') return `.cboreHole(${numbers([hole.diameter, hole.cboreDiameter ?? 0, hole.cboreDepth ?? 0])}${depth})`;
  if (hole.kind === 'counterdrill')
    return `.cboreHole(${numbers([hole.diameter, hole.cboreDiameter ?? 0, hole.cboreDepth ?? 0])}${depth}) + countersink Ø${numbers([hole.cskDiameter ?? 0])} ${numbers([hole.cskAngle ?? 0])}°`;
  return `.hole(${formatNumber(hole.diameter)}${depth})`;
}

/** Notes for a feature node, emitted before the executable boolean lowering. */
export function featureNotes(node: FeatureRecipe): string[] {
  const normal = `[${numbers(node.frame.normal)}]`;
  if (node.feature === 'rib') {
    const { path, thickness, height, symmetric } = node.rib;
    return [
      `add_rib: ${path.length}-point path thickened ${formatNumber(thickness)}${symmetric ? ' (centred)' : ''}, height ${formatNumber(height)}; ` +
        `face normal ${normal}; extruded fuse below`,
    ];
  }
  if (node.feature === 'pocket') {
    const { cornerRadius, floorFillet, depth, outline, islands = [] } = node.pocket;
    const size = depth === 'through' ? 'through' : `depth ${formatNumber(depth)}`;
    const posts = islands.length === 0 ? '' : `, ${islands.length} island${islands.length === 1 ? '' : 's'}`;
    return [
      `add_pocket: ${outline.length}-vertex outline${posts}, ${size}, cornerRadius ${formatNumber(cornerRadius)}, floorFillet ${formatNumber(floorFillet)}; ` +
        `face normal ${normal}; extruded cut below`,
    ];
  }
  const { hole, extent, points } = node;
  const depth = extent.kind === 'through_all' ? '' : `, ${formatNumber(extent.depth)}`;
  const where = points.map(([u, v]) => `(${numbers([u, v])})`).join(', ');
  const lines = [
    `add_hole: CadQuery .workplane().pushPoints([${where}])${cadqueryCall(hole, depth)} on the face with normal ${normal}; revolved cut below`,
  ];
  if (extent.kind === 'blind' && extent.drillPointAngle !== undefined)
    lines.push(`drill point ${formatNumber(extent.drillPointAngle)} deg: an extra cone cut, included in the cut below`);
  if (hole.thread !== undefined)
    lines.push(
      `thread ${hole.thread.designation} (${hole.thread.modelled === true ? 'modelled helical groove in the llull model; not emitted here' : 'cosmetic, no geometry'})`,
    );
  return lines;
}
