import type { CadDocument } from '../model/types';
import type { RenderViewData } from './renderTypes';
import { escapeXml } from '../lib/escapeXml';
import { type Projector, makeProjector, computeOrthoHalf } from './renderCamera';
import { appendBeforeClose, r2, svgDot, svgLine } from './renderSvg';
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
 * Append the bounding-box dimension labels (W/D/H) to an SVG, placed in screen space near the
 * box edges. An empty scene (no bounds) is returned unchanged.
 * @pure
 */
function appendDimensionLabels(svgString: string, data: RenderViewData): string {
  if (!data.bounds) return svgString;

  const { min, max } = data.bounds;
  const w = r2(Math.abs(max[0] - min[0]));
  const d = r2(Math.abs(max[1] - min[1]));
  const h = r2(Math.abs(max[2] - min[2]));

  const { camera, width, height } = data;
  const project = makeProjector(camera, computeOrthoHalf(data.bounds), width, height);

  // Midpoints of the 3 dimension edges of the bounding box.
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const pWidth = project([cx, min[1], min[2]]); // along X, front-bottom edge
  const pDepth = project([min[0], cy, min[2]]); // along Y, left-bottom edge
  const pHeight = project([min[0], min[1], cz]); // along Z, front-left edge

  return appendBeforeClose(
    svgString,
    [
      `  <!-- bounding box dimensions -->`,
      `  <g font-family="monospace" font-size="11" fill="#ffdd44" stroke="#1a1a2e" stroke-width="2" paint-order="stroke">`,
      `    <text x="${r2(pWidth[0])}" y="${r2(pWidth[1] + 14)}" text-anchor="middle">W:${w}</text>`,
      `    <text x="${r2(pDepth[0] - 14)}" y="${r2(pDepth[1])}" text-anchor="end">D:${d}</text>`,
      `    <text x="${r2(pHeight[0] - 14)}" y="${r2(pHeight[1])}" text-anchor="end">H:${h}</text>`,
      `  </g>`,
    ].join('\n'),
  );
}

/** Faint Z=0 ground grid over the scene extent, with the world X (red) and Y (green) axes picked out. */
function groundGridLines(project: Projector, data: RenderViewData, axisLength: number): string[] {
  const { bounds } = data;
  const ext = bounds
    ? Math.max(
        Math.abs(bounds.max[0]),
        Math.abs(bounds.min[0]),
        Math.abs(bounds.max[1]),
        Math.abs(bounds.min[1]),
        1,
      ) * 1.5
    : Math.max(axisLength * 3, 2);

  // Grid step: ~5–8 lines across the scene, rounded to a nice number (1, 2, 5, 10, 20, 50, ...).
  const rawStep = ext / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const gridStep = magnitude * (normalized < 2 ? 1 : normalized < 5 ? 2 : 5);

  const iMin = Math.floor(-ext / gridStep);
  const iMax = Math.ceil(ext / gridStep);
  const ticks = Array.from({ length: iMax - iMin + 1 }, (_, n) => (iMin + n) * gridStep);
  const [low, high] = [iMin * gridStep, iMax * gridStep];
  const line = (
    from: [number, number, number],
    to: [number, number, number],
    attributes = '',
  ): string => `    ${svgLine(project(from), project(to), attributes)}`;

  return [
    `  <g id="ground-grid" opacity="0.18" stroke="#88aacc" stroke-width="0.8" stroke-linecap="round">`,
    ...ticks.map((x) => line([x, low, 0], [x, high, 0])), // parallel to Y
    ...ticks.map((y) => line([low, y, 0], [high, y, 0])), // parallel to X
    line([-ext, 0, 0], [ext, 0, 0], 'stroke="#cc4444" opacity="0.35"'),
    line([0, -ext, 0], [0, ext, 0], 'stroke="#44bb44" opacity="0.35"'),
    `  </g>`,
  ];
}

/** World-frame X/Y/Z axis triad at the origin (when on screen) plus a "<length> <unit> = <px> px" scale label. */
function worldAxesLines(
  project: Projector,
  data: RenderViewData,
  units: string,
  axisLength: number,
): string[] {
  const { width, height } = data;
  const origin = project([0, 0, 0]);
  const xTip = project([axisLength, 0, 0]);
  const axes = [
    { label: 'X', color: '#ff4444', tip: xTip },
    { label: 'Y', color: '#44dd44', tip: project([0, axisLength, 0]) },
    { label: 'Z', color: '#4488ff', tip: project([0, 0, axisLength]) },
  ];
  const labelStyle = `font-family="monospace" font-size="12" font-weight="bold" stroke="#1a1a2e" stroke-width="3" paint-order="stroke"`;

  const margin = 20;
  const visible =
    origin[0] > -margin &&
    origin[0] < width + margin &&
    origin[1] > -margin &&
    origin[1] < height + margin;
  const lines = visible
    ? [
        `  <g id="world-axes" stroke-linecap="round" stroke-linejoin="round">`,
        ...axes.map(
          ({ color, tip }) => `    ${svgLine(origin, tip, `stroke="${color}" stroke-width="2"`)}`,
        ),
        ...axes.map(({ color, tip }) => `    ${svgDot(tip, `fill="${color}"`)}`),
        `    ${svgDot(origin, 'fill="#ffffff" opacity="0.7"')}`,
        ...axes.map(
          ({ label, color, tip }) =>
            `    <text x="${r2(tip[0] + 5)}" y="${r2(tip[1] + 4)}" ${labelStyle} fill="${color}">${label}</text>`,
        ),
        `  </g>`,
      ]
    : [];

  const scalePx = Math.sqrt(Math.pow(xTip[0] - origin[0], 2) + Math.pow(xTip[1] - origin[1], 2));
  const scaleLabel = `${r2(axisLength)} ${units} = ${r2(scalePx)} px`;
  lines.push(
    `  <text x="8" y="${height - 8}" font-family="monospace" font-size="10" ` +
      `fill="#aabbdd" stroke="#1a1a2e" stroke-width="2" paint-order="stroke">${escapeXml(scaleLabel)}</text>`,
  );
  return lines;
}

/**
 * Append a Z=0 ground grid and/or a world-frame axis triad to an SVG, projected like
 * `appendDimensionLabels`. The scale label uses the document `units`.
 * @pure
 */
function appendAxesAndGrid(
  svgString: string,
  data: RenderViewData,
  units: string,
  showAxes: boolean,
  showGrid: boolean,
): string {
  const { camera, width, height } = data;
  const orthoHalf = computeOrthoHalf(data.bounds);
  const project = makeProjector(camera, orthoHalf, width, height);
  const axisLength = Math.max(orthoHalf * 0.2, 0.5);

  return appendBeforeClose(
    svgString,
    [
      '  <!-- world-frame overlay -->',
      ...(showGrid ? groundGridLines(project, data, axisLength) : []),
      ...(showAxes ? worldAxesLines(project, data, units, axisLength) : []),
    ].join('\n'),
  );
}
