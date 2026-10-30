/** render_view `overlay` = "cage" | "net" (04 DIR FR-DIR-40, AF-22): the subdivision cage and the NURBS control nets drawn over the picture, so an agent sees what it edits. */

import { type Entity, type Vec3 } from '../../model/types';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { escapeXml } from '../../lib/escapeXml';
import { type Projector, makeProjector } from './camera';
import { appendBeforeClose, svgDot, svgLine } from './svg';
import { OVERLAY_KINDS, type OverlayKind, type OverlayStats } from './overlayTypes';
import type { RenderViewData } from './types';

const CAGE_COLOR = '#ffd24a';
const NET_COLOR = '#44ddff';

interface Layer {
  readonly svg: string[];
  readonly stats: OverlayStats;
}

function cageLayer(entities: ReadonlyArray<Entity>, project: Projector): Layer {
  const svg: string[] = [];
  const ids: string[] = [];
  let [lines, points] = [0, 0];
  for (const entity of entities) {
    if (entity.kind !== 'subdivision') continue;
    const screen = entity.vertices.map((p) => project(entityLocalToWorld(entity, p)));
    const seen = new Set<string>();
    const body: string[] = [];
    for (const face of entity.faces)
      face.forEach((a, i) => {
        const b = face[(i + 1) % face.length] as number;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (seen.has(key)) return;
        seen.add(key);
        body.push(`    ${svgLine(screen[a] as [number, number], screen[b] as [number, number])}`);
      });
    for (const p of screen) body.push(`    ${svgDot(p, `fill="${CAGE_COLOR}" stroke="#1a1a2e" stroke-width="1"`)}`);
    svg.push(
      `  <g class="cage-overlay" data-entity="${escapeXml(entity.id)}" stroke="${CAGE_COLOR}" stroke-width="1.2" stroke-linecap="round" opacity="0.9">`,
      ...body,
      '  </g>',
    );
    ids.push(entity.id);
    lines += seen.size;
    points += screen.length;
  }
  return { svg, stats: { entities: ids, lines, points } };
}

function netLayer(entities: ReadonlyArray<Entity>, project: Projector): Layer {
  const svg: string[] = [];
  const ids: string[] = [];
  let [lines, points] = [0, 0];
  for (const entity of entities) {
    const grid: Vec3[][] | null =
      entity.kind === 'nurbs_surface'
        ? entity.surface.poles.map((row) => row.map((p) => entityLocalToWorld(entity, p)))
        : entity.kind === 'nurbs_curve'
          ? [entity.curve.poles.map((p) => entityLocalToWorld(entity, p))]
          : null;
    if (grid === null) continue;
    const screen = grid.map((row) => row.map((p) => project(p)));
    const body: string[] = [];
    let drawn = 0;
    const segment = (a: [number, number], b: [number, number]): void => {
      body.push(`    ${svgLine(a, b)}`);
      drawn++;
    };
    screen.forEach((row, i) =>
      row.forEach((p, j) => {
        if (j + 1 < row.length) segment(p, row[j + 1] as [number, number]);
        const below = screen[i + 1]?.[j];
        if (entity.kind === 'nurbs_surface' && below !== undefined) segment(p, below);
      }),
    );
    for (const p of screen.flat()) body.push(`    ${svgDot(p, `fill="${NET_COLOR}" stroke="#1a1a2e" stroke-width="1"`)}`);
    svg.push(
      `  <g class="net-overlay" data-entity="${escapeXml(entity.id)}" stroke="${NET_COLOR}" stroke-width="1" stroke-dasharray="4 3" stroke-linecap="round" opacity="0.9">`,
      ...body,
      '  </g>',
    );
    ids.push(entity.id);
    lines += drawn;
    points += screen.flat().length;
  }
  return { svg, stats: { entities: ids, lines, points } };
}

/**
 * `svg` with the requested overlays drawn on top, projected with the camera of `data` (orthographic renders only; the picture is not occluded: the cage and the net are
 * drawn over the surface). `only` limits them to those entity ids (an isolated render).
 * @invariant a cage edge is drawn once however many faces share it; every vertex and pole is one dot; an entity of another kind is not drawn
 */
export function appendCageNetOverlays(
  svg: string,
  data: RenderViewData,
  entities: ReadonlyArray<Entity>,
  kinds: ReadonlyArray<OverlayKind>,
  only?: ReadonlyArray<string>,
): { svg: string; stats: Partial<Record<OverlayKind, OverlayStats>> } {
  const project = makeProjector(data.camera, data.orthoHalf, data.width, data.height);
  const shown = only === undefined ? entities : entities.filter((entity) => only.includes(entity.id));
  const stats: Partial<Record<OverlayKind, OverlayStats>> = {};
  const layers: string[] = [];
  for (const kind of OVERLAY_KINDS) {
    if (!kinds.includes(kind)) continue;
    const layer = kind === 'cage' ? cageLayer(shown, project) : netLayer(shown, project);
    stats[kind] = layer.stats;
    if (layer.svg.length > 0) layers.push(`  <!-- ${kind} overlay -->`, ...layer.svg);
  }
  return { svg: layers.length === 0 ? svg : appendBeforeClose(svg, layers.join('\n')), stats };
}
