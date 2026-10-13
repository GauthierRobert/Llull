/**
 * Multi-pass render_view compositions: turntable strip, isolate, section. Each re-renders partial / transformed copies of the document; the
 * input document is never mutated.
 */

import type { CadDocument, Vec3 } from '../../model/types';
import { escapeXml } from '../../lib/escapeXml';
import { type ViewName, makeProjector } from './camera';
import { renderDocument } from './scene';
import type { CutSpec, RenderOptions, RenderViewData } from './types';
import { DEFAULT_BACKGROUND, extractSvgInner, r2, svgDocument } from './svg';
import { computeSceneSnapshot } from '../inspect/scene';
import { boundsCenter, boundsExtent } from '../../geometry/bounds';
import { ORIGIN, dot3 } from '../../lib/vec3';
import { rotateEulerAboutWorldZ } from '../../lib/eulerRotation';

/** Render only the entities of `doc` whose id satisfies `keep` (document order preserved). */
function renderSubset(
  doc: CadDocument,
  keep: (id: string) => boolean,
  view: ViewName,
  width: number,
  height: number,
  options: RenderOptions,
): RenderViewData {
  const order = doc.order.filter((id) => keep(id) && doc.entities[id] !== undefined);
  const entities: CadDocument['entities'] = {};
  for (const id of order) entities[id] = doc.entities[id] as CadDocument['entities'][string];
  return renderDocument({ ...doc, entities, order }, view, width, height, {
    ...options,
    frame: computeSceneSnapshot(doc).bounds,
    background: null,
  });
}

/** Copy of `doc` with every entity rotated by `angleRad` about the vertical axis through (cx, cy). */
function rotateAroundZ(doc: CadDocument, cx: number, cy: number, angleRad: number): CadDocument {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const entities: CadDocument['entities'] = {};
  for (const [id, entity] of Object.entries(doc.entities)) {
    const dx = entity.position[0] - cx;
    const dy = entity.position[1] - cy;
    entities[id] = {
      ...entity,
      position: [cx + cos * dx - sin * dy, cy + sin * dx + cos * dy, entity.position[2]],
      rotation: rotateEulerAboutWorldZ(entity.rotation, angleRad),
    };
  }
  return { ...doc, entities };
}

const backgroundOf = (options: RenderOptions): string | null =>
  options.background === undefined ? DEFAULT_BACKGROUND : options.background;

/** The cut planes turned with the model, so every turntable frame cuts the same part. */
function rotateCut(cut: CutSpec, cx: number, cy: number, angleRad: number): CutSpec {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    ...cut,
    planes: cut.planes.map(({ normal, offset }) => {
      const [nx, ny, nz] = normal;
      const turned: Vec3 = [cos * nx - sin * ny, sin * nx + cos * ny, nz];
      // Keep the plane through the same (turned) point: n'·(c + R(p − c)) with p = n·offset/|n|².
      const lengthSq = dot3(normal, normal);
      const pointOffset = offset / (lengthSq || 1);
      const p: Vec3 = [nx * pointOffset - cx, ny * pointOffset - cy, nz * pointOffset];
      const moved: Vec3 = [cx + cos * p[0] - sin * p[1], cy + sin * p[0] + cos * p[1], p[2]];
      return { normal: turned, offset: dot3(turned, moved) };
    }),
  };
}

/**
 * Horizontal strip of `frames` views, the scene rotated evenly about Z through its center.
 * @returns the strip SVG and its total pixel width (`width * frames`).
 */
export function buildTurntableSvg(
  doc: CadDocument,
  frames: number,
  view: ViewName,
  width: number,
  height: number,
  options: RenderOptions = {},
): { svg: string; width: number } {
  const bounds = computeSceneSnapshot(doc).bounds;
  const [cx, cy] = bounds ? boundsCenter(bounds) : ORIGIN;
  const layers: string[] = [];
  const angleLabels: string[] = [];
  for (let i = 0; i < frames; i++) {
    const angle = (2 * Math.PI * i) / frames;
    const frame = renderDocument(rotateAroundZ(doc, cx, cy, angle), view, width, height, {
      ...options,
      background: null,
      ...(options.cut ? { cut: rotateCut(options.cut, cx, cy, angle) } : {}),
    });
    layers.push(`  <g transform="translate(${i * width}, 0)">${extractSvgInner(frame.svg)}</g>`);
    angleLabels.push(
      `  <text x="${r2(i * width + 4)}" y="32" font-family="monospace" font-size="13" fill="#aaaacc">${Math.round((360 * i) / frames)}°</text>`,
    );
  }
  const totalWidth = width * frames;
  return { svg: svgDocument(totalWidth, height, [...layers, ...angleLabels], backgroundOf(options)), width: totalWidth };
}

/** Highlighted entities at full color over the rest at low opacity, with an ISOLATED caption. */
export function buildIsolateSvg(
  doc: CadDocument,
  highlightIds: readonly string[],
  view: ViewName,
  width: number,
  height: number,
  options: RenderOptions = {},
): string {
  const highlighted = new Set(highlightIds);
  const dim = renderSubset(doc, (id) => !highlighted.has(id), view, width, height, options);
  const lit = renderSubset(doc, (id) => highlighted.has(id), view, width, height, options);
  const caption = highlightIds.slice(0, 3).join(', ') + (highlightIds.length > 3 ? '…' : '');
  return svgDocument(
    width,
    height,
    [
      `  <g opacity="0.15">${extractSvgInner(dim.svg)}</g>`,
      `  <g>${extractSvgInner(lit.svg)}</g>`,
      `  <text x="8" y="${height - 10}" font-family="monospace" font-size="11" fill="#ffdd44">ISOLATED: ${escapeXml(caption)}</text>`,
    ],
    backgroundOf(options),
  );
}

/** Entities at or beyond the plane at full color, the rest dimmed, plus a dashed cut line. */
export function buildSectionSvg(
  doc: CadDocument,
  axis: 'x' | 'y' | 'z',
  offset: number,
  view: ViewName,
  width: number,
  height: number,
  options: RenderOptions = {},
): string {
  const axisIndex = 'xyz'.indexOf(axis);
  const onKeptSide = (id: string): boolean => (doc.entities[id]?.position[axisIndex] ?? 0) >= offset;
  const kept = renderSubset(doc, onKeptSide, view, width, height, options);
  const cut = renderSubset(doc, (id) => !onKeptSide(id), view, width, height, options);
  return svgDocument(
    width,
    height,
    [
      `  <g opacity="0.25">${extractSvgInner(cut.svg)}</g>`,
      `  <g>${extractSvgInner(kept.svg)}</g>`,
      sectionPlaneLine(kept, axis, offset),
      `  <text x="8" y="${height - 10}" font-family="monospace" font-size="11" fill="#ff8844">SECTION ${axis.toUpperCase()}=${offset}</text>`,
    ],
    backgroundOf(options),
  );
}

function sectionPlaneLine(data: RenderViewData, axis: 'x' | 'y' | 'z', offset: number): string {
  const { bounds } = data;
  const ext = bounds ? boundsExtent(bounds) * 1.5 : 10;
  const [cx, cy, cz] = bounds ? boundsCenter(bounds) : ORIGIN;
  const along = (t: number): Vec3 => (axis === 'z' ? [cx + t, cy, offset] : axis === 'y' ? [cx + t, offset, cz] : [offset, cy + t, cz]);
  const project = makeProjector(data.camera, data.orthoHalf, data.width, data.height);
  const s0 = project(along(-ext));
  const s1 = project(along(ext));
  return [
    `  <g id="section-plane">`,
    `    <line x1="${r2(s0[0])}" y1="${r2(s0[1])}" x2="${r2(s1[0])}" y2="${r2(s1[1])}"`,
    `          stroke="#ff8844" stroke-width="2" stroke-dasharray="8 4" opacity="0.9"/>`,
    `  </g>`,
  ].join('\n');
}
