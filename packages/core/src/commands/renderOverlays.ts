import type { CadDocument } from '../model/types';
import type { RenderViewData } from './renderTypes';
import { escapeXml } from '../lib/escapeXml';
import { r2 } from './renderMath';
import { makeProjector, computeOrthoHalf } from './renderCamera';
import { appendEntityLabels } from './renderLabels';

interface OverlayFlags {
  showDimensions: boolean;
  showAxes: boolean;
  showGrid: boolean;
  showLabels: boolean;
}

/** The single overlay pipeline (dimensions, axes/grid, entity labels) applied on top of any base SVG. @pure */
export function composeOverlays(
  svg: string,
  baseData: RenderViewData,
  doc: CadDocument,
  flags: OverlayFlags,
): string {
  let composed = svg;
  if (flags.showDimensions) composed = appendDimensionLabels(composed, baseData);
  if (flags.showAxes || flags.showGrid) {
    composed = appendAxesAndGrid(
      composed,
      baseData,
      doc.units ?? 'mm',
      flags.showAxes,
      flags.showGrid,
    );
  }
  if (flags.showLabels) {
    composed = appendEntityLabels(composed, baseData, Object.values(doc.entities));
  }
  return composed;
}

/**
 * Append bounding-box dimension labels to an existing SVG string.
 *
 * Uses the bounds and camera information from RenderViewData to position
 * labels in screen space. The labels are placed near the bounding box edges.
 *
 * @pure — returns a new SVG string; does not modify the input.
 */
function appendDimensionLabels(svgString: string, data: RenderViewData): string {
  if (!data.bounds) return svgString; // nothing to annotate on empty scene

  const { min, max } = data.bounds;
  const w = r2(Math.abs(max[0] - min[0]));
  const d = r2(Math.abs(max[1] - min[1]));
  const h = r2(Math.abs(max[2] - min[2]));

  // Project bounding box corner midpoints to screen space
  const { camera, width, height } = data;
  const project = makeProjector(camera, computeOrthoHalf(data), width, height);

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
function appendAxesAndGrid(
  svgString: string,
  data: RenderViewData,
  units: string,
  showAxes: boolean,
  showGrid: boolean,
): string {
  const { camera, width, height } = data;
  const project = makeProjector(camera, computeOrthoHalf(data), width, height);
  const axisLen = computeAxisLength(data);

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

    lines.push(
      `  <g id="ground-grid" opacity="0.18" stroke="#88aacc" stroke-width="0.8" stroke-linecap="round">`,
    );

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
      lines.push(
        `    <circle cx="${r2(origin[0])}" cy="${r2(origin[1])}" r="3" fill="#ffffff" opacity="0.7"/>`,
      );

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
    const scalePx = Math.sqrt(Math.pow(xTip[0] - origin[0], 2) + Math.pow(xTip[1] - origin[1], 2));
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
