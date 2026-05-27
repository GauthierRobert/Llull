/**
 * @layer server
 *
 * Server-side enrichments for the `render_view` MCP tool.
 *
 * These features are implemented at the server transport layer because they
 * require multi-pass rendering or SVG post-processing — capabilities that
 * belong in the server (L6) rather than the pure core command layer (L2).
 *
 * The core `render_view` command is called one or more times per enrichment;
 * enrichments never mutate the live document.
 *
 * Enrichments:
 *   turntable     — horizontal strip of N frames evenly spaced around the Z axis
 *   isolate       — dim everything except the specified entity ids
 *   showDimensions — overlay W × D × H bounding-box text on the SVG
 *   section       — overlay a section-plane indicator; negative side dimmed
 *   showLabels    — per-entity id/name labels + key-point markers + legend
 */

import type { CadDocument, Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { RenderViewData } from '@core/commands/render';
import { entityBounds } from '@core/commands/scene';

// ---------------------------------------------------------------------------
// Extended param types (server-only — never passed to core)
// ---------------------------------------------------------------------------

export interface TurntableParams {
  /** Number of evenly-spaced frames (1..12). */
  frames: number;
}

export interface SectionParams {
  /** Axis to cut along ('x' | 'y' | 'z'). */
  axis: 'x' | 'y' | 'z';
  /** World-space offset of the cut plane along the axis. */
  offset: number;
}

/** All optional enrichment params that the server handles. */
export interface RenderViewEnrichParams {
  /** Base render_view params forwarded to core. */
  view?: string;
  width?: number;
  height?: number;
  /** Turntable strip — frames evenly spaced around the Z (up) axis. */
  turntable?: TurntableParams;
  /** Entity id(s) to highlight; all others are dimmed/desaturated. */
  isolate?: string | string[];
  /** Overlay bounding-box W × D × H dimensions as text on the image. */
  showDimensions?: boolean;
  /** Section plane overlay: cut at axis=offset; negative side dimmed. */
  section?: SectionParams;
  /**
   * Overlay a world-frame X/Y/Z axis triad at the origin.
   * X=red, Y=green, Z=blue. Default: true.
   */
  showAxes?: boolean;
  /**
   * Overlay a faint ground grid on the Z=0 plane.
   * Default: true.
   */
  showGrid?: boolean;
  /**
   * Overlay per-entity id/name labels and key-point markers on the SVG.
   * Renders a small marker at each entity's structural key points (endpoints,
   * center, corners, …) and a text label showing the entity name (or id).
   * A legend in the top-right corner maps colors to entity categories.
   * Default: false — opt in so plain render_view stays uncluttered.
   */
  showLabels?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract RenderViewData from an execute() result, or null on failure. */
function extractRenderData(doc: CadDocument, view: string, width: number, height: number): RenderViewData | null {
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
function rotateDocumentAroundZ(doc: CadDocument, cx: number, cy: number, angleRad: number): CadDocument {
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
  const snapshot = baseResult.data as { bounds: { min: [number, number, number]; max: [number, number, number] } | null } | undefined;
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
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
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
// ShowDimensions: overlay W × D × H as SVG text
// ---------------------------------------------------------------------------

/**
 * Append bounding-box dimension labels to an existing SVG string.
 *
 * Uses the bounds and camera information from RenderViewData to position
 * labels in screen space. The labels are placed near the bounding box edges.
 *
 * @pure — returns a new SVG string; does not modify the input.
 */
export function appendDimensionLabels(svgString: string, data: RenderViewData): string {
  if (!data.bounds) return svgString; // nothing to annotate on empty scene

  const { min, max } = data.bounds;
  const w = r2(Math.abs(max[0] - min[0]));
  const d = r2(Math.abs(max[1] - min[1]));
  const h = r2(Math.abs(max[2] - min[2]));

  // Project bounding box corner midpoints to screen space
  const { camera, width, height } = data;
  const cam = camera;

  // Re-derive camera basis (same math as render.ts)
  const fwd = normalize3(sub3(cam.target, cam.position));
  const right = normalize3(cross3(fwd, cam.up));
  const up = normalize3(cross3(right, fwd));

  // Compute orthoHalf the same way renderDocument does: max scene extent / 2 * 1.2
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  const radius = Math.max(dx, dy, dz) / 2 + 1e-3;
  const orthoHalf = (radius < 0.1 ? 1 : radius) * 1.2 * 1.2; // extra 1.2x for cameraForView

  function project(p: [number, number, number]): [number, number] {
    const dd = sub3(p, cam.position);
    const u = dot3(dd, right);
    const v = dot3(dd, up);
    return toScreenCoords(u, v, orthoHalf, width, height);
  }

  // Midpoints of the 3 dimension edges of the bounding box
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;

  // Width label: along X axis at the front-bottom edge
  const pWidth = project([cx, min[1], min[2]]);
  // Depth label: along Y axis at the left-bottom edge
  const pDepth = project([min[0], cy, min[2]]);
  // Height label: along Z axis at the front-left edge
  const pHeight = project([min[0], min[1], cz]);

  const dimensionSvg = [
    `  <!-- bounding box dimensions -->`,
    `  <g font-family="monospace" font-size="11" fill="#ffdd44" stroke="#1a1a2e" stroke-width="2" paint-order="stroke">`,
    `    <text x="${r2(pWidth[0])}" y="${r2(pWidth[1] + 14)}" text-anchor="middle">W:${w}</text>`,
    `    <text x="${r2(pDepth[0] - 14)}" y="${r2(pDepth[1])}" text-anchor="end">D:${d}</text>`,
    `    <text x="${r2(pHeight[0] - 14)}" y="${r2(pHeight[1])}" text-anchor="end">H:${h}</text>`,
    `  </g>`,
  ].join('\n');

  // Insert dimension labels just before the closing </svg> tag
  return svgString.replace('</svg>', `${dimensionSvg}\n</svg>`);
}

// ---------------------------------------------------------------------------
// Axes + Grid: world-frame triad and Z=0 ground grid overlay
// ---------------------------------------------------------------------------

/**
 * Compute the orthoHalf value used for projection, matching appendDimensionLabels.
 * This is the half-width of the orthographic frustum in world units.
 */
function computeOrthoHalf(data: RenderViewData): number {
  const bounds = data.bounds;
  if (!bounds) return 1;
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const radius = Math.max(dx, dy, dz) / 2 + 1e-3;
  return (radius < 0.1 ? 1 : radius) * 1.2 * 1.2;
}

/**
 * Compute axis tip length in world units — scaled to be visible relative to
 * scene bounds but not overwhelming. Uses 30% of the scene radius.
 */
function computeAxisLength(data: RenderViewData): number {
  const orthoHalf = computeOrthoHalf(data);
  // orthoHalf is roughly 1.44 × scene radius; scale tip to ~20% of orthoHalf
  return Math.max(orthoHalf * 0.2, 0.5);
}

/**
 * Append a world-frame axis triad and/or a Z=0 ground grid to an existing SVG.
 *
 * Reuses the same world→screen projection as appendDimensionLabels.
 *
 * Axis triad:
 *   - X axis: red  (+X direction from origin)
 *   - Y axis: green (+Y direction from origin)
 *   - Z axis: blue  (+Z direction from origin)
 *   - Labeled "X", "Y", "Z" at the tips.
 *
 * Ground grid:
 *   - Faint lines on the Z=0 plane, spaced by grid step.
 *   - Clipped to the visible scene extent.
 *
 * Document units are used for the scale label (e.g. "1 mm = 42 px").
 *
 * @pure — returns a new SVG string; does not modify the input.
 */
export function appendAxesAndGrid(
  svgString: string,
  data: RenderViewData,
  units: string,
  showAxes: boolean,
  showGrid: boolean,
): string {
  const { camera, width, height } = data;
  const cam = camera;

  // Re-derive camera basis (same as appendDimensionLabels)
  const fwd = normalize3(sub3(cam.target, cam.position));
  const right = normalize3(cross3(fwd, cam.up));
  const up = normalize3(cross3(right, fwd));

  const orthoHalf = computeOrthoHalf(data);
  const axisLen = computeAxisLength(data);

  function project(p: [number, number, number]): [number, number] {
    const dd = sub3(p, cam.position);
    const u = dot3(dd, right);
    const v = dot3(dd, up);
    return toScreenCoords(u, v, orthoHalf, width, height);
  }

  const lines: string[] = ['  <!-- world-frame overlay -->'];

  // -------------------------------------------------------------------------
  // Ground grid (Z=0 plane)
  // -------------------------------------------------------------------------
  if (showGrid) {
    // Determine grid extent from scene bounds or a default
    const bounds = data.bounds;
    const ext = bounds
      ? Math.max(
          Math.abs(bounds.max[0]),
          Math.abs(bounds.min[0]),
          Math.abs(bounds.max[1]),
          Math.abs(bounds.min[1]),
          1,
        ) * 1.5
      : Math.max(axisLen * 3, 2);

    // Grid step: aim for ~5–8 grid lines visible across the scene
    const rawStep = ext / 4;
    // Round to a nice number (1, 2, 5, 10, 20, 50, ...)
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const normalized = rawStep / magnitude;
    const gridStep = magnitude * (normalized < 2 ? 1 : normalized < 5 ? 2 : 5);

    const iMin = Math.floor(-ext / gridStep);
    const iMax = Math.ceil(ext / gridStep);

    lines.push(`  <g id="ground-grid" opacity="0.18" stroke="#88aacc" stroke-width="0.8" stroke-linecap="round">`);

    // Lines parallel to Y axis (varying X, fixed Z=0)
    for (let i = iMin; i <= iMax; i++) {
      const x = i * gridStep;
      const p0 = project([x, iMin * gridStep, 0]);
      const p1 = project([x, iMax * gridStep, 0]);
      lines.push(
        `    <line x1="${r2(p0[0])}" y1="${r2(p0[1])}" x2="${r2(p1[0])}" y2="${r2(p1[1])}"/>`,
      );
    }
    // Lines parallel to X axis (varying Y, fixed Z=0)
    for (let j = iMin; j <= iMax; j++) {
      const y = j * gridStep;
      const p0 = project([iMin * gridStep, y, 0]);
      const p1 = project([iMax * gridStep, y, 0]);
      lines.push(
        `    <line x1="${r2(p0[0])}" y1="${r2(p0[1])}" x2="${r2(p1[0])}" y2="${r2(p1[1])}"/>`,
      );
    }

    // Highlight the X and Y world axes on the Z=0 plane (slightly brighter)
    const xNeg = project([-ext, 0, 0]);
    const xPos = project([ext, 0, 0]);
    const yNeg = project([0, -ext, 0]);
    const yPos = project([0, ext, 0]);
    lines.push(
      `    <line x1="${r2(xNeg[0])}" y1="${r2(xNeg[1])}" x2="${r2(xPos[0])}" y2="${r2(xPos[1])}" stroke="#cc4444" opacity="0.35"/>`,
    );
    lines.push(
      `    <line x1="${r2(yNeg[0])}" y1="${r2(yNeg[1])}" x2="${r2(yPos[0])}" y2="${r2(yPos[1])}" stroke="#44bb44" opacity="0.35"/>`,
    );

    lines.push(`  </g>`);
  }

  // -------------------------------------------------------------------------
  // Axis triad
  // -------------------------------------------------------------------------
  if (showAxes) {
    const origin = project([0, 0, 0]);
    const xTip = project([axisLen, 0, 0]);
    const yTip = project([0, axisLen, 0]);
    const zTip = project([0, 0, axisLen]);

    // Check if origin is within the visible area (add margin)
    const margin = 20;
    const visible =
      origin[0] > -margin &&
      origin[0] < width + margin &&
      origin[1] > -margin &&
      origin[1] < height + margin;

    if (visible) {
      lines.push(`  <g id="world-axes" stroke-linecap="round" stroke-linejoin="round">`);

      // X axis — red
      lines.push(
        `    <line x1="${r2(origin[0])}" y1="${r2(origin[1])}" x2="${r2(xTip[0])}" y2="${r2(xTip[1])}" stroke="#ff4444" stroke-width="2"/>`,
      );
      // Y axis — green
      lines.push(
        `    <line x1="${r2(origin[0])}" y1="${r2(origin[1])}" x2="${r2(yTip[0])}" y2="${r2(yTip[1])}" stroke="#44dd44" stroke-width="2"/>`,
      );
      // Z axis — blue
      lines.push(
        `    <line x1="${r2(origin[0])}" y1="${r2(origin[1])}" x2="${r2(zTip[0])}" y2="${r2(zTip[1])}" stroke="#4488ff" stroke-width="2"/>`,
      );

      // Arrowheads at tips (small circles for simplicity and SVG robustness)
      lines.push(`    <circle cx="${r2(xTip[0])}" cy="${r2(xTip[1])}" r="3" fill="#ff4444"/>`);
      lines.push(`    <circle cx="${r2(yTip[0])}" cy="${r2(yTip[1])}" r="3" fill="#44dd44"/>`);
      lines.push(`    <circle cx="${r2(zTip[0])}" cy="${r2(zTip[1])}" r="3" fill="#4488ff"/>`);

      // Origin dot
      lines.push(`    <circle cx="${r2(origin[0])}" cy="${r2(origin[1])}" r="3" fill="#ffffff" opacity="0.7"/>`);

      // Axis labels at tips (with outline for legibility over any background)
      const labelStyle = `font-family="monospace" font-size="12" font-weight="bold" stroke="#1a1a2e" stroke-width="3" paint-order="stroke"`;
      lines.push(
        `    <text x="${r2(xTip[0] + 5)}" y="${r2(xTip[1] + 4)}" ${labelStyle} fill="#ff4444">X</text>`,
      );
      lines.push(
        `    <text x="${r2(yTip[0] + 5)}" y="${r2(yTip[1] + 4)}" ${labelStyle} fill="#44dd44">Y</text>`,
      );
      lines.push(
        `    <text x="${r2(zTip[0] + 5)}" y="${r2(zTip[1] + 4)}" ${labelStyle} fill="#4488ff">Z</text>`,
      );

      lines.push(`  </g>`);
    }

    // Scale label — shows pixel-per-unit ratio for the agent
    // Compute screen distance for the axis length in world units
    const scalePx = Math.sqrt(
      Math.pow(xTip[0] - origin[0], 2) + Math.pow(xTip[1] - origin[1], 2),
    );
    const scaleLabel = `${r2(axisLen)} ${units} = ${r2(scalePx)} px`;
    lines.push(
      `  <text x="8" y="${height - 8}" font-family="monospace" font-size="10" ` +
        `fill="#aabbdd" stroke="#1a1a2e" stroke-width="2" paint-order="stroke">${escapeXml(scaleLabel)}</text>`,
    );
  }

  const overlay = lines.join('\n');
  // Insert just before the closing </svg> tag
  return svgString.replace('</svg>', `${overlay}\n</svg>`);
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
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
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
  const ext = bounds ? Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ) * 1.5 : 10;

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

// ---------------------------------------------------------------------------
// Entity labels: per-entity id/name labels + key-point markers + legend
// ---------------------------------------------------------------------------

/**
 * Category of an entity for colour-coding in the label overlay.
 *   point    — PointEntity
 *   curve2d  — 2D lines, polylines, arcs, circles, ellipses, splines, rectangles
 *   solid3d  — all 3D solid kinds
 *   annotation — text, dimension
 */
type EntityCategory = 'point' | 'curve2d' | 'solid3d' | 'annotation';

/** CSS colours per category (must stay in sync with the legend). */
const CATEGORY_COLORS: Record<EntityCategory, string> = {
  point:      '#ff9944',  // orange
  curve2d:    '#44ddff',  // cyan
  solid3d:    '#bb88ff',  // purple
  annotation: '#ffdd44',  // yellow
};

function entityCategory(e: Entity): EntityCategory {
  switch (e.kind) {
    case 'point':      return 'point';
    case 'line':
    case 'polyline':
    case 'arc':
    case 'circle':
    case 'rectangle':
    case 'ellipse':
    case 'spline':     return 'curve2d';
    case 'text':
    case 'dimension':  return 'annotation';
    default:           return 'solid3d';
  }
}

/**
 * Collect the world-space key points for an entity.
 *
 * For 2D entities the geometry is LOCAL (Vec2) to the work plane; we lift each
 * 2D point into world space by adding `entity.position` as the plane origin and
 * keeping z = entity.position[2] (the default Z=0 plane convention).
 *
 * For 3D solids we derive the 8 corners of the world-space AABB using
 * `entityBounds` — the same helper used by the scene snapshot. Rotation is NOT
 * applied (AABB only); this is acceptable for v1 corner markers.
 *
 * Point limit: at most MAX_KEY_POINTS per entity to avoid marker floods on
 * dense polylines/splines. We sample evenly when over the cap.
 */
const MAX_KEY_POINTS = 16;

function entityKeyPoints(e: Entity): Array<[number, number, number]> {
  const pos = e.position;

  // Helper to lift a local 2D point to world space.
  function lift(x: number, y: number): [number, number, number] {
    return [pos[0] + x, pos[1] + y, pos[2]];
  }

  // Evenly sample an array down to at most MAX_KEY_POINTS items.
  function cap<T>(pts: T[]): T[] {
    if (pts.length <= MAX_KEY_POINTS) return pts;
    const step = pts.length / MAX_KEY_POINTS;
    const result: T[] = [];
    for (let i = 0; i < MAX_KEY_POINTS; i++) {
      result.push(pts[Math.round(i * step)] as T);
    }
    return result;
  }

  switch (e.kind) {
    // -----------------------------------------------------------------------
    // 2D shapes
    // -----------------------------------------------------------------------
    case 'point':
      return [[pos[0], pos[1], pos[2]]];

    case 'line':
      return [lift(e.start[0], e.start[1]), lift(e.end[0], e.end[1])];

    case 'polyline':
      return cap(e.points.map(([x, y]) => lift(x, y)));

    case 'spline':
      return cap(e.points.map(([x, y]) => lift(x, y)));

    case 'arc': {
      // Center + a radius handle at the arc's mid-sweep angle, so the marker
      // sits ON the curve (a +X handle can fall outside the angular sweep).
      const mid = (e.startAngle + e.endAngle) / 2;
      return [
        lift(e.center[0], e.center[1]),
        lift(e.center[0] + e.radius * Math.cos(mid), e.center[1] + e.radius * Math.sin(mid)),
      ];
    }

    case 'circle':
      // Center + a radius-handle point along +X (so the agent can read the radius visually).
      return [lift(e.center[0], e.center[1]), lift(e.center[0] + e.radius, e.center[1])];

    case 'ellipse':
      // Center + semi-axis tip along +X and +Y.
      return [
        lift(e.center[0], e.center[1]),
        lift(e.center[0] + e.radiusX, e.center[1]),
        lift(e.center[0], e.center[1] + e.radiusY),
      ];

    case 'rectangle':
      // 4 corners: lower-left, lower-right, upper-right, upper-left.
      return [
        lift(0, 0),
        lift(e.width, 0),
        lift(e.width, e.height),
        lift(0, e.height),
      ];

    case 'text':
    case 'dimension':
      // Single anchor at entity position (position is the placement point).
      return [[pos[0], pos[1], pos[2]]];

    // -----------------------------------------------------------------------
    // 3D solids — 8 AABB corners
    // -----------------------------------------------------------------------
    default: {
      const b = entityBounds(e);
      const { min, max } = b;
      return [
        [min[0], min[1], min[2]],
        [max[0], min[1], min[2]],
        [max[0], max[1], min[2]],
        [min[0], max[1], min[2]],
        [min[0], min[1], max[2]],
        [max[0], min[1], max[2]],
        [max[0], max[1], max[2]],
        [min[0], max[1], max[2]],
      ];
    }
  }
}

/**
 * Compute the screen-space anchor for a label: centroid of the key points,
 * offset slightly up so the label doesn't overlap the centre marker.
 */
function labelAnchor(
  keyPoints: Array<[number, number, number]>,
  project: (p: [number, number, number]) => [number, number],
): [number, number] {
  if (keyPoints.length === 0) return [0, 0];
  let sumX = 0, sumY = 0;
  for (const pt of keyPoints) {
    const [sx, sy] = project(pt);
    sumX += sx;
    sumY += sy;
  }
  return [sumX / keyPoints.length, sumY / keyPoints.length - 8];
}

/**
 * Append per-entity id/name labels, key-point markers, and a category legend
 * to an existing SVG string.
 *
 * Reuses the same world→screen projection as appendDimensionLabels / appendAxesAndGrid.
 *
 * Label design:
 *   - Each entity gets a text label (name if set, else id) at the centroid of its
 *     key points, with a dark stroke outline for readability over any background.
 *   - Key points are shown as small filled circles (r=3) in the category colour.
 *   - Marker shapes: circle for all categories (simple and robust in SVG).
 *   - Legend: top-right corner, lists the 4 categories with their colours.
 *
 * Scene density: all entities are labelled. At >30 entities labels may become
 * crowded; the agent can still use individual key-point markers for orientation.
 *
 * @pure — returns a new SVG string; does not modify the input.
 */
export function appendEntityLabels(
  svgString: string,
  data: RenderViewData,
  entities: ReadonlyArray<Entity>,
): string {
  const { camera, width, height } = data;
  const cam = camera;

  // Camera basis — identical to appendDimensionLabels / appendAxesAndGrid.
  const fwd = normalize3(sub3(cam.target, cam.position));
  const right = normalize3(cross3(fwd, cam.up));
  const up = normalize3(cross3(right, fwd));

  const orthoHalf = computeOrthoHalf(data);

  function project(p: [number, number, number]): [number, number] {
    const dd = sub3(p, cam.position);
    const u = dot3(dd, right);
    const v = dot3(dd, up);
    return toScreenCoords(u, v, orthoHalf, width, height);
  }

  const lines: string[] = ['  <!-- entity labels overlay -->'];
  const labelStyle = `font-family="monospace" font-size="10" stroke="#0d0d1a" stroke-width="2.5" paint-order="stroke"`;

  // -------------------------------------------------------------------------
  // Per-entity markers and labels
  // -------------------------------------------------------------------------
  for (const e of entities) {
    const cat = entityCategory(e);
    const color = CATEGORY_COLORS[cat];
    const label = e.name ?? e.id;
    const keyPts = entityKeyPoints(e);

    // Key-point markers
    lines.push(`  <g data-entity-id="${escapeXml(e.id)}" data-kind="${escapeXml(e.kind)}">`);
    for (const pt of keyPts) {
      const [sx, sy] = project(pt);
      // Only draw if reasonably within the viewport (with generous margin).
      if (sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20) continue;
      lines.push(`    <circle cx="${r2(sx)}" cy="${r2(sy)}" r="3" fill="${color}" opacity="0.85" stroke="#0d0d1a" stroke-width="0.8"/>`);
    }

    // Label at centroid of key points (always drawn even if markers clip)
    const [lx, ly] = labelAnchor(keyPts, project);
    // Clamp label position inside the viewport so it stays readable.
    const clampedLx = Math.max(4, Math.min(width - 4, lx));
    const clampedLy = Math.max(12, Math.min(height - 4, ly));
    lines.push(
      `    <text x="${r2(clampedLx)}" y="${r2(clampedLy)}" ${labelStyle} fill="${color}" text-anchor="middle">${escapeXml(label)}</text>`,
    );
    lines.push(`  </g>`);
  }

  // -------------------------------------------------------------------------
  // Legend — top-right corner
  // -------------------------------------------------------------------------
  const legendEntries: Array<{ cat: EntityCategory; label: string }> = [
    { cat: 'solid3d',    label: '3D solid' },
    { cat: 'curve2d',    label: '2D curve' },
    { cat: 'point',      label: 'point' },
    { cat: 'annotation', label: 'annotation' },
  ];
  const legendX = width - 4;
  const legendY0 = 16;
  const lineH = 14;
  lines.push(`  <g id="entity-labels-legend" font-family="monospace" font-size="10">`);
  for (let i = 0; i < legendEntries.length; i++) {
    const entry = legendEntries[i] as { cat: EntityCategory; label: string };
    const color = CATEGORY_COLORS[entry.cat];
    const y = legendY0 + i * lineH;
    lines.push(`    <circle cx="${r2(legendX - 60)}" cy="${r2(y - 3)}" r="3" fill="${color}"/>`);
    lines.push(
      `    <text x="${r2(legendX - 54)}" y="${r2(y)}" fill="${color}" stroke="#0d0d1a" stroke-width="2" paint-order="stroke">${escapeXml(entry.label)}</text>`,
    );
  }
  lines.push(`  </g>`);

  const overlay = lines.join('\n');
  return svgString.replace('</svg>', `${overlay}\n</svg>`);
}

// ---------------------------------------------------------------------------
// SVG composition utilities
// ---------------------------------------------------------------------------

/**
 * Extract the inner content of an SVG string (strips outer `<svg ...>` and `</svg>` tags).
 * Returns the raw inner XML string.
 */
function extractSvgInner(svgString: string): string {
  const openEnd = svgString.indexOf('>');
  if (openEnd === -1) return svgString;
  const closeStart = svgString.lastIndexOf('</svg>');
  if (closeStart === -1) return svgString.substring(openEnd + 1);
  return svgString.substring(openEnd + 1, closeStart);
}

/** Escape XML special characters for safe text embedding. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Pure math helpers (duplicated from render.ts — server layer cannot import
// unexported internal helpers; these are short and exact copies)
// ---------------------------------------------------------------------------

type Vec3Mutable = [number, number, number];

function sub3(a: readonly [number, number, number], b: readonly [number, number, number]): Vec3Mutable {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: readonly [number, number, number], b: readonly [number, number, number]): Vec3Mutable {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function len3(a: readonly [number, number, number]): number {
  return Math.sqrt(dot3(a, a));
}

function normalize3(a: readonly [number, number, number]): Vec3Mutable {
  const l = len3(a);
  return l > 1e-10 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toScreenCoords(
  u: number,
  v: number,
  orthoHalf: number,
  width: number,
  height: number,
): [number, number] {
  const margin = 0.9;
  const scaleX = (width / 2) * margin / orthoHalf;
  const scaleY = (height / 2) * margin / orthoHalf;
  const scale = Math.min(scaleX, scaleY);
  const sx = width / 2 + u * scale;
  const sy = height / 2 - v * scale;
  return [sx, sy];
}
