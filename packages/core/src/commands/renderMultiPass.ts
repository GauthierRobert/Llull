/**
 * @layer core/commands
 * Multi-pass render_view compositions: turntable strip, isolate, section. Each re-renders
 * partial / transformed copies of the document; the input document is never mutated.
 */

import type { CadDocument } from '../model/types';
import { escapeXml } from '../lib/escapeXml';
import { r2 } from './renderMath';
import { type ViewName, makeProjector, computeOrthoHalf } from './renderCamera';
import { renderDocument } from './renderScene';
import { extractSvgInner } from './renderSvg';
import { computeSceneSnapshot } from './scene';

const BACKGROUND = '#1a1a2e';

/** Wrap layers in a `width`×`height` SVG with the standard dark background. */
function svgDocument(width: number, height: number, layers: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <rect width="${width}" height="${height}" fill="${BACKGROUND}"/>`,
    ...layers,
    '</svg>',
  ].join('\n');
}

/** Copy of `doc` holding only the entities whose id satisfies `keep` (order preserved). */
function subDocument(doc: CadDocument, keep: (id: string) => boolean): CadDocument {
  const order = doc.order.filter((id) => keep(id) && doc.entities[id] !== undefined);
  const entities: CadDocument['entities'] = {};
  for (const id of order) entities[id] = doc.entities[id] as CadDocument['entities'][string];
  return { ...doc, entities, order };
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
      rotation: [entity.rotation[0], entity.rotation[1], entity.rotation[2] + angleRad],
    };
  }
  return { ...doc, entities };
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
): { svg: string; width: number } {
  const bounds = computeSceneSnapshot(doc).bounds;
  const cx = bounds ? (bounds.min[0] + bounds.max[0]) / 2 : 0;
  const cy = bounds ? (bounds.min[1] + bounds.max[1]) / 2 : 0;
  const layers: string[] = [];
  const angleLabels: string[] = [];
  for (let i = 0; i < frames; i++) {
    const frame = renderDocument(
      rotateAroundZ(doc, cx, cy, (2 * Math.PI * i) / frames),
      view,
      width,
      height,
    );
    layers.push(`  <g transform="translate(${i * width}, 0)">${extractSvgInner(frame.svg)}</g>`);
    angleLabels.push(
      `  <text x="${r2(i * width + 4)}" y="32" font-family="monospace" font-size="13" fill="#aaaacc">${Math.round((360 * i) / frames)}°</text>`,
    );
  }
  const totalWidth = width * frames;
  return { svg: svgDocument(totalWidth, height, [...layers, ...angleLabels]), width: totalWidth };
}

/** Highlighted entities at full color over the rest at low opacity, with an ISOLATED caption. */
export function buildIsolateSvg(
  doc: CadDocument,
  highlightIds: readonly string[],
  view: ViewName,
  width: number,
  height: number,
): string {
  const highlighted = new Set(highlightIds);
  const dim = renderDocument(
    subDocument(doc, (id) => !highlighted.has(id)),
    view,
    width,
    height,
  );
  const lit = renderDocument(
    subDocument(doc, (id) => highlighted.has(id)),
    view,
    width,
    height,
  );
  const caption = highlightIds.slice(0, 3).join(', ') + (highlightIds.length > 3 ? '…' : '');
  return svgDocument(width, height, [
    `  <g opacity="0.15">${extractSvgInner(dim.svg)}</g>`,
    `  <g>${extractSvgInner(lit.svg)}</g>`,
    `  <text x="8" y="${height - 10}" font-family="monospace" font-size="11" fill="#ffdd44">ISOLATED: ${escapeXml(caption)}</text>`,
  ]);
}

/** Entities at or beyond the plane at full color, the rest dimmed, plus a dashed cut line. */
export function buildSectionSvg(
  doc: CadDocument,
  axis: 'x' | 'y' | 'z',
  offset: number,
  view: ViewName,
  width: number,
  height: number,
): string {
  const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const onKeptSide = (id: string): boolean =>
    (doc.entities[id]?.position[axisIndex] ?? 0) >= offset;
  const kept = renderDocument(subDocument(doc, onKeptSide), view, width, height);
  const cut = renderDocument(
    subDocument(doc, (id) => !onKeptSide(id)),
    view,
    width,
    height,
  );
  return svgDocument(width, height, [
    `  <g opacity="0.25">${extractSvgInner(cut.svg)}</g>`,
    `  <g>${extractSvgInner(kept.svg)}</g>`,
    sectionPlaneLine(kept, axis, offset),
    `  <text x="8" y="${height - 10}" font-family="monospace" font-size="11" fill="#ff8844">SECTION ${axis.toUpperCase()}=${offset}</text>`,
  ]);
}

function sectionPlaneLine(
  data: ReturnType<typeof renderDocument>,
  axis: 'x' | 'y' | 'z',
  offset: number,
): string {
  const { bounds } = data;
  const ext = bounds
    ? Math.max(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ) * 1.5
    : 10;
  const cx = bounds ? (bounds.min[0] + bounds.max[0]) / 2 : 0;
  const cy = bounds ? (bounds.min[1] + bounds.max[1]) / 2 : 0;
  const cz = bounds ? (bounds.min[2] + bounds.max[2]) / 2 : 0;
  const [p0, p1]: [[number, number, number], [number, number, number]] =
    axis === 'z'
      ? [
          [cx - ext, cy, offset],
          [cx + ext, cy, offset],
        ]
      : axis === 'y'
        ? [
            [cx - ext, offset, cz],
            [cx + ext, offset, cz],
          ]
        : [
            [offset, cy - ext, cz],
            [offset, cy + ext, cz],
          ];
  const project = makeProjector(data.camera, computeOrthoHalf(data), data.width, data.height);
  const s0 = project(p0);
  const s1 = project(p1);
  return [
    `  <g id="section-plane">`,
    `    <line x1="${r2(s0[0])}" y1="${r2(s0[1])}" x2="${r2(s1[0])}" y2="${r2(s1[1])}"`,
    `          stroke="#ff8844" stroke-width="2" stroke-dasharray="8 4" opacity="0.9"/>`,
    `  </g>`,
  ].join('\n');
}
