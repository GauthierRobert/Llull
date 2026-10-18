/** render_view drawing of `dimension` and `text` entities: dimension lines as depth-tested strokes, values and text as SVG text on top. */

import type { CadDocument, Entity, Vec3 } from '../../model/types';
import { dimensionDrawing, dimensionText, DEFAULT_DIMENSION_OFFSET } from '../../geometry/dimensionAnnotation';
import { planeToWorld } from '../../geometry/workPlane';
import { escapeXml } from '../../lib/escapeXml';
import { clamp } from '../../lib/clamp';
import type { Projector } from './camera';
import { appendBeforeClose, r2 } from './svg';
import { type LabelBox, type PlacementRequest, placeLabels, textBox, triadBox } from './labelPlacement';
import type { PreDepthPolygon } from './types';

/** Arrowhead length in screen pixels. */
const ARROW_PX = 7;
/** Dimension value text size in pixels. */
const DIMENSION_FONT_PX = 12;
const MIN_TEXT_PX = 9;
const MAX_TEXT_PX = 48;
/** Replacement ink for dark annotation colours on a dark background. */
const LIGHT_INK = '#e4e4f0';

const references = (doc: CadDocument, ids: readonly string[]): Array<Entity | undefined> =>
  ids.map((id) => (Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined));

function luminance(color: string): number | null {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color)?.[1];
  if (hex === undefined) return null;
  const channel = (i: number): number => parseInt(hex.substring(i, i + 2), 16) / 255;
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Annotation colours default to dark grey (made for a white sheet): lift them on a dark background so they stay readable. */
export function annotationInk(color: string, background: string | null | undefined): string {
  const backgroundLight = background != null && (luminance(background) ?? 0) > 0.5;
  return !backgroundLight && (luminance(color) ?? 1) < 0.35 ? LIGHT_INK : color;
}

/** Strokes of one dimension entity (extension lines, dimension line, arrowheads) in world space; `worldPerPx` sizes the arrowheads. */
export function dimensionStrokes(
  doc: CadDocument,
  e: Entity,
  worldPerPx: number,
  background: string | null | undefined,
): PreDepthPolygon[] {
  if (e.kind !== 'dimension') return [];
  const drawing = dimensionDrawing(
    e.dimensionKind,
    references(doc, e.entityIds),
    e.offset ?? DEFAULT_DIMENSION_OFFSET,
    ARROW_PX * worldPerPx,
  );
  if (!drawing) return [];
  const color = annotationInk(e.color, background);
  return drawing.segments.map(
    ([from, to]): PreDepthPolygon => ({
      verts: [
        [from[0], from[1], drawing.z],
        [to[0], to[1], drawing.z],
      ],
      color,
      normal: [0, 0, 1],
      stroke: true,
    }),
  );
}

interface Label {
  readonly id: string;
  readonly kind: 'text' | 'dimension';
  readonly anchor: Vec3;
  readonly lines: readonly string[];
  readonly fontPx: number;
  readonly color: string;
  readonly textAnchor: 'start' | 'middle' | 'end';
  /** Direction of the text baseline in the world (null = screen horizontal). */
  readonly baseline: Vec3 | null;
  /** World direction of the dimension line the label sits on; null for plain text (never moved). */
  readonly direction: Vec3 | null;
}

function labelOf(doc: CadDocument, e: Entity, worldPerPx: number): Label | null {
  if (e.kind === 'text') {
    const baseline = planeToWorld(e.position, e.rotation, [1, 0]);
    const textAnchor = e.anchor === 'center' ? 'middle' : e.anchor === 'right' ? 'end' : 'start';
    return {
      id: e.id,
      kind: 'text',
      anchor: e.position,
      lines: e.content.split('\n'),
      fontPx: clamp(e.height / worldPerPx, MIN_TEXT_PX, MAX_TEXT_PX),
      color: e.color,
      textAnchor,
      baseline: [baseline[0] - e.position[0], baseline[1] - e.position[1], baseline[2] - e.position[2]],
      direction: null,
    };
  }
  if (e.kind !== 'dimension') return null;
  const offset = e.offset ?? DEFAULT_DIMENSION_OFFSET;
  const drawing = dimensionDrawing(e.dimensionKind, references(doc, e.entityIds), offset);
  if (!drawing) return null;
  return {
    id: e.id,
    kind: 'dimension',
    anchor: [drawing.textAt[0], drawing.textAt[1], drawing.z],
    lines: [dimensionText(e, drawing.value, doc.displayPrecision)],
    fontPx: DIMENSION_FONT_PX,
    color: e.color,
    textAnchor: 'middle',
    baseline: null,
    direction: [drawing.direction[0], drawing.direction[1], 0],
  };
}

/** Screen rotation (degrees, SVG sense) of a world baseline direction; 0 when it is edge-on. */
function screenAngle(project: Projector, from: Vec3, direction: Vec3 | null): number {
  if (direction === null) return 0;
  const a = project(from);
  const b = project([from[0] + direction[0], from[1] + direction[1], from[2] + direction[2]]);
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return 0;
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
}

/** Canvas size from the root `<svg width height>` tag (annotation text is appended to an already built SVG). */
function canvasSize(svg: string): { width: number; height: number } {
  const tag = /<svg[^>]*>/.exec(svg)?.[0] ?? '';
  const read = (name: string): number => Number(new RegExp(`\\s${name}="([\\d.]+)"`).exec(tag)?.[1] ?? 0);
  return { width: read('width'), height: read('height') };
}

/** Unit screen direction of a world direction at `from` (screen horizontal when it is edge-on). */
function screenDirection(project: Projector, from: Vec3, direction: Vec3): [number, number] {
  const a = project(from);
  const b = project([from[0] + direction[0], from[1] + direction[1], from[2] + direction[2]]);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return length < 1e-6 ? [1, 0] : [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
}

/** Moved further than this many font sizes, a dimension value keeps a thin leader to its own dimension line. */
const LEADER_FONT_SIZES = 2;

/**
 * `svg` with every text entity and dimension value of `entities` drawn on top (projected like the scene). Dimension values that would
 * overlap a text entity, the world triad or an earlier dimension value slide along their dimension line until clear (see labelPlacement).
 */
export function appendAnnotationText(
  svg: string,
  doc: CadDocument,
  entities: readonly Entity[],
  project: Projector,
  worldPerPx: number,
  background: string | null | undefined,
): string {
  const halo = background != null && (luminance(background) ?? 0) > 0.5 ? '#ffffff' : '#0d0d1a';
  const placed = entities.flatMap((e) => {
    const label = labelOf(doc, e, worldPerPx);
    if (label === null) return [];
    const [x, y] = project(label.anchor);
    const angle = screenAngle(project, label.anchor, label.baseline);
    const box = textBox(x, y, label.lines, label.fontPx, label.kind === 'dimension' ? -0.3 : 0.35, label.textAnchor, angle);
    return [{ label, x, y, angle, box, shift: [0, 0] as [number, number] }];
  });
  const { width, height } = canvasSize(svg);
  const orthoHalf = worldPerPx * 0.9 * (Math.min(width, height) / 2);
  const reach = Math.max(orthoHalf * 0.2, 0.5);
  const triad = triadBox(
    { origin: project([0, 0, 0]), tips: [project([reach, 0, 0]), project([0, reach, 0]), project([0, 0, reach])] },
    width,
    height,
  );
  const fixed: LabelBox[] = [...(triad === null ? [] : [triad]), ...placed.filter((p) => p.label.direction === null).map((p) => p.box)];
  const movable = placed.filter((p) => p.label.direction !== null);
  const requests = movable.map(
    (p): PlacementRequest => ({
      box: p.box,
      along: screenDirection(project, p.label.anchor, p.label.direction ?? [1, 0, 0]),
      fontPx: p.label.fontPx,
    }),
  );
  placeLabels(requests, fixed).forEach((shift, i) => {
    const item = movable[i];
    if (item !== undefined) item.shift = shift;
  });
  const lines = placed.flatMap(({ label, x: anchorX, y: anchorY, angle, shift }) => {
    const [x, y] = [anchorX + shift[0], anchorY + shift[1]];
    const ink = annotationInk(label.color, background);
    const rotate = angle === 0 ? '' : ` transform="rotate(${r2(angle)} ${r2(x)} ${r2(y)})"`;
    const spans = label.lines.map(
      (line, i) =>
        `<tspan x="${r2(x)}" dy="${i > 0 ? '1.2em' : label.kind === 'dimension' ? '-0.3em' : '0.35em'}">${escapeXml(line)}</tspan>`,
    );
    const leader =
      Math.hypot(shift[0], shift[1]) > LEADER_FONT_SIZES * label.fontPx
        ? [
            `  <line data-entity-id="${escapeXml(label.id)}" data-kind="leader" x1="${r2(anchorX)}" y1="${r2(anchorY)}" x2="${r2(x)}" y2="${r2(y)}" ` +
              `stroke="${ink}" stroke-width="0.75" stroke-opacity="0.7"/>`,
          ]
        : [];
    return [
      ...leader,
      `  <text data-entity-id="${escapeXml(label.id)}" data-kind="${label.kind}" x="${r2(x)}" y="${r2(y)}" font-family="monospace" ` +
        `font-size="${r2(label.fontPx)}" fill="${ink}" stroke="${halo}" stroke-width="2.5" ` +
        `paint-order="stroke" text-anchor="${label.textAnchor}"${rotate}>${spans.join('')}</text>`,
    ];
  });
  return lines.length === 0 ? svg : appendBeforeClose(svg, ['  <!-- annotations -->', ...lines].join('\n'));
}
