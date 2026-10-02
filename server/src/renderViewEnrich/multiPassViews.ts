/**
 * @layer server
 *
 * Multi-pass render_view enrichments: turntable frames, isolate, and section views.
 * Each re-renders partial / transformed copies of the document via the core
 * `render_view` command; the live document is never mutated.
 */

import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { RenderViewData } from '@core/commands/render';
import type { SectionParams } from './types';
import {
  cross3,
  dot3,
  escapeXml,
  extractSvgInner,
  normalize3,
  r2,
  sub3,
  toScreenCoords,
} from './svgHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract RenderViewData from an execute() result, or null on failure. */
function extractRenderData(
  doc: CadDocument,
  view: string,
  width: number,
  height: number,
): RenderViewData | null {
  const result = execute(doc, 'render_view', { view, width, height });
  if (!result.data || typeof result.data !== 'object') return null;
  const d = result.data as Record<string, unknown>;
  if (typeof d['svg'] !== 'string') return null;
  return result.data as RenderViewData;
}

// ---------------------------------------------------------------------------
// Turntable: N evenly-spaced rotations around Z axis
// ---------------------------------------------------------------------------

/**
 * Rotate all entities in a document around the scene center by `angleRad`
 * around the Z (up) axis. Applies to position (XY rotation) and rz (orientation).
 *
 * @pure — returns a new CadDocument, never mutates the input.
 */
function rotateDocumentAroundZ(
  doc: CadDocument,
  cx: number,
  cy: number,
  angleRad: number,
): CadDocument {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  const newEntities: Record<string, CadDocument['entities'][string]> = {};
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (!entity) continue;
    // Rotate position around (cx, cy) in XY
    const dx = entity.position[0] - cx;
    const dy = entity.position[1] - cy;
    const nx = cx + cos * dx - sin * dy;
    const ny = cy + sin * dx + cos * dy;
    // Adjust rz rotation to match the new orientation
    newEntities[id] = {
      ...entity,
      position: [nx, ny, entity.position[2]],
      rotation: [entity.rotation[0], entity.rotation[1], entity.rotation[2] + angleRad],
    };
  }

  return { ...doc, entities: newEntities };
}

/**
 * Produce N evenly-spaced horizontal-strip frames (one SVG per angle).
 * Uses the 'front' named view for all frames so we look horizontally at the scene.
 *
 * @returns array of SVG strings (one per frame) or null on failure
 */
export function buildTurntableFrames(
  doc: CadDocument,
  frames: number,
  view: string,
  width: number,
  height: number,
): string[] | null {
  const clampedFrames = Math.max(1, Math.min(12, Math.round(frames)));

  // Compute scene center from bounds
  const baseResult = execute(doc, 'describe_scene', {});
  const snapshot = baseResult.data as
    | { bounds: { min: [number, number, number]; max: [number, number, number] } | null }
    | undefined;
  const bounds = snapshot?.bounds;
  const cx = bounds ? (bounds.min[0] + bounds.max[0]) / 2 : 0;
  const cy = bounds ? (bounds.min[1] + bounds.max[1]) / 2 : 0;

  const svgs: string[] = [];
  for (let i = 0; i < clampedFrames; i++) {
    const angle = (2 * Math.PI * i) / clampedFrames;
    const rotatedDoc = rotateDocumentAroundZ(doc, cx, cy, angle);
    const data = extractRenderData(rotatedDoc, view, width, height);
    if (!data) return null;
    svgs.push(data.svg);
  }
  return svgs;
}

// ---------------------------------------------------------------------------
// Isolate: dim all entities not in the highlighted set
// ---------------------------------------------------------------------------

/**
 * Build two partial documents:
 *  1. `dimDoc` — only non-highlighted entities (will be rendered dimmed)
 *  2. `highlightDoc` — only highlighted entities (will be rendered at full brightness)
 *
 * Then compose the two rendered SVGs into a single SVG by:
 *  - Wrapping dimDoc SVG content in `<g opacity="0.15">` (desaturated appearance via opacity)
 *  - Rendering highlightDoc on top at full color
 *  - Adding a colored outline rect around the highlight group
 *
 * @pure — does not modify `doc`.
 */
export function buildIsolateSvg(
  doc: CadDocument,
  highlightIds: string[],
  view: string,
  width: number,
  height: number,
): string | null {
  const highlightSet = new Set(highlightIds);

  // Build dim doc — all entities except highlighted
  const dimEntities: Record<string, CadDocument['entities'][string]> = {};
  const highlightEntities: Record<string, CadDocument['entities'][string]> = {};
  const dimOrder: string[] = [];
  const highlightOrder: string[] = [];

  for (const id of doc.order) {
    const e = doc.entities[id];
    if (!e) continue;
    if (highlightSet.has(id)) {
      highlightEntities[id] = e;
      highlightOrder.push(id);
    } else {
      dimEntities[id] = e;
      dimOrder.push(id);
    }
  }

  const dimDoc: CadDocument = { ...doc, entities: dimEntities, order: dimOrder };
  const highlightDoc: CadDocument = { ...doc, entities: highlightEntities, order: highlightOrder };

  const dimData = extractRenderData(dimDoc, view, width, height);
  const highlightData = extractRenderData(highlightDoc, view, width, height);
  if (!dimData || !highlightData) return null;

  // Compose: extract inner content of each SVG (strip outer <svg> tags)
  const dimInner = extractSvgInner(dimData.svg);
  const highlightInner = extractSvgInner(highlightData.svg);

  // Build composed SVG
  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  // Background (from dim render)
  lines.push(`  <rect width="${width}" height="${height}" fill="#1a1a2e"/>`);
  // Dimmed layer (non-highlighted entities at low opacity)
  lines.push(`  <g opacity="0.15">${dimInner}</g>`);
  // Highlighted layer (full color on top)
  lines.push(`  <g>${highlightInner}</g>`);
  // Annotation: label the highlighted entity ids
  if (highlightIds.length > 0) {
    const label = highlightIds.slice(0, 3).join(', ') + (highlightIds.length > 3 ? '…' : '');
    lines.push(
      `  <text x="8" y="${height - 10}" font-family="monospace" font-size="11" fill="#ffdd44">ISOLATED: ${escapeXml(label)}</text>`,
    );
  }
  lines.push('</svg>');
  return lines.join('\n');
}
// ---------------------------------------------------------------------------
// Section: overlay a section plane indicator
// ---------------------------------------------------------------------------

/**
 * Compose a section-plane overlay onto an existing SVG.
 *
 * The section plane is rendered as a colored translucent band at the cut
 * location projected onto the screen. Entities on the negative side of the
 * plane are shown with reduced opacity (approximation — no true geometry cut).
 *
 * Implementation:
 *  - Re-render the scene split into two halves: positive side (normal) and
 *    negative side (dimmed).
 *  - Add a thin colored line at the projected section plane boundary.
 *
 * @pure — does not modify `doc`.
 */
export function buildSectionSvg(
  doc: CadDocument,
  section: SectionParams,
  view: string,
  width: number,
  height: number,
): string | null {
  const { axis, offset } = section;

  // Split doc into positive (kept) and negative (dimmed) entity sets
  const positiveEntities: Record<string, CadDocument['entities'][string]> = {};
  const negativeEntities: Record<string, CadDocument['entities'][string]> = {};
  const positiveOrder: string[] = [];
  const negativeOrder: string[] = [];

  for (const id of doc.order) {
    const e = doc.entities[id];
    if (!e) continue;
    const axisIdx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const pos = e.position[axisIdx];
    if (pos >= offset) {
      positiveEntities[id] = e;
      positiveOrder.push(id);
    } else {
      negativeEntities[id] = e;
      negativeOrder.push(id);
    }
  }

  const posDoc: CadDocument = { ...doc, entities: positiveEntities, order: positiveOrder };
  const negDoc: CadDocument = { ...doc, entities: negativeEntities, order: negativeOrder };

  const posData = extractRenderData(posDoc, view, width, height);
  const negData = extractRenderData(negDoc, view, width, height);
  if (!posData) return null;

  // Project the section plane as a line across the screen
  const sectionLineSvg = buildSectionPlaneOverlay(posData, axis, offset, width, height);

  // Compose SVG layers
  const posInner = extractSvgInner(posData.svg);
  const negInner = negData ? extractSvgInner(negData.svg) : '';

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  lines.push(`  <rect width="${width}" height="${height}" fill="#1a1a2e"/>`);
  // Negative side (dimmed / transparent)
  if (negInner) {
    lines.push(`  <g opacity="0.25">${negInner}</g>`);
  }
  // Positive side (full)
  lines.push(`  <g>${posInner}</g>`);
  // Section plane indicator
  lines.push(sectionLineSvg);
  // Label
  lines.push(
    `  <text x="8" y="${height - 10}" font-family="monospace" font-size="11" fill="#ff8844">SECTION ${axis.toUpperCase()}=${offset}</text>`,
  );
  lines.push('</svg>');
  return lines.join('\n');
}

/**
 * Build an SVG group representing the section plane as a colored line overlay.
 * Projects two endpoints of the section plane edge to screen space.
 */
function buildSectionPlaneOverlay(
  data: RenderViewData,
  axis: 'x' | 'y' | 'z',
  offset: number,
  width: number,
  height: number,
): string {
  const { camera } = data;
  const fwd = normalize3(sub3(camera.target, camera.position));
  const right = normalize3(cross3(fwd, camera.up));
  const up = normalize3(cross3(right, fwd));

  const bounds = data.bounds;
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

  const dx = data.bounds ? data.bounds.max[0] - data.bounds.min[0] : 1;
  const dy = data.bounds ? data.bounds.max[1] - data.bounds.min[1] : 1;
  const dz = data.bounds ? data.bounds.max[2] - data.bounds.min[2] : 1;
  const radius = Math.max(dx, dy, dz) / 2 + 1e-3;
  const orthoHalf = (radius < 0.1 ? 1 : radius) * 1.2 * 1.2;

  // Two endpoints of a line spanning the section plane at the given offset
  let p0: [number, number, number], p1: [number, number, number];
  if (axis === 'z') {
    p0 = [cx - ext, cy, offset];
    p1 = [cx + ext, cy, offset];
  } else if (axis === 'y') {
    p0 = [cx - ext, offset, cz];
    p1 = [cx + ext, offset, cz];
  } else {
    p0 = [offset, cy - ext, cz];
    p1 = [offset, cy + ext, cz];
  }

  function project(p: [number, number, number]): [number, number] {
    const d = sub3(p, camera.position);
    const u = dot3(d, right);
    const v = dot3(d, up);
    return toScreenCoords(u, v, orthoHalf, width, height);
  }

  const s0 = project(p0);
  const s1 = project(p1);

  return [
    `  <g id="section-plane">`,
    `    <line x1="${r2(s0[0])}" y1="${r2(s0[1])}" x2="${r2(s1[0])}" y2="${r2(s1[1])}"`,
    `          stroke="#ff8844" stroke-width="2" stroke-dasharray="8 4" opacity="0.9"/>`,
    `  </g>`,
  ].join('\n');
}
