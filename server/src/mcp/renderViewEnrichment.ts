/**
 * @layer server
 *
 * tools/call intercept for render_view server-side enrichments (turntable, isolate,
 * section, dimension / axes / grid / label overlays). Never mutates the document.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { shapeToolCallContent } from '@mcp/index';
import type { CadDocument } from '@core/model/types';
import { applyCommand } from '../commandBus';
import { stripSvgFromData, rasterizeSvg } from '../renderImage';
import {
  buildTurntableFrames,
  buildIsolateSvg,
  appendDimensionLabels,
  appendAxesAndGrid,
  appendEntityLabels,
  buildSectionSvg,
  type RenderViewEnrichParams,
} from '../renderViewEnrich';

/** The set of param keys that are handled server-side (not forwarded to core). */
const ENRICH_PARAM_KEYS = new Set([
  'turntable',
  'isolate',
  'showDimensions',
  'section',
  'showAxes',
  'showGrid',
  'showLabels',
]);

/**
 * Strip enrichment-only params from a render_view args object so the core
 * command only receives the params it understands (view, width, height).
 */
export function stripEnrichParams(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args;
  const record = args as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!ENRICH_PARAM_KEYS.has(k)) stripped[k] = v;
  }
  return stripped;
}

/**
 * Apply server-side render_view enrichments when any enrichment param is present.
 *
 * Returns a `CallToolResult` when enrichment was applied, or `null` when no
 * enrichment params are present and neither showAxes nor showGrid are requested
 * (caller falls through to normal applyCommand path).
 *
 * Enrichments are applied in this priority order (only the first mutually-exclusive
 * one wins; showDimensions, showAxes, and showGrid compose with any other enrichment):
 *   1. turntable → N-frame horizontal PNG strip
 *   2. isolate   → highlight specific entities
 *   3. section   → section-plane view
 *   4. showDimensions / showAxes / showGrid only → base render + post-process
 *
 * showAxes and showGrid default to true when not explicitly set to false.
 */
export function applyRenderViewEnrichments(
  args: Record<string, unknown>,
  getDoc: () => CadDocument,
): CallToolResult | null {
  const params = args as RenderViewEnrichParams;

  // showAxes and showGrid default to true (not false)
  const wantAxes = params.showAxes !== false;
  const wantGrid = params.showGrid !== false;

  const wantLabels = params.showLabels === true;

  const hasEnrichment =
    params.turntable !== undefined ||
    params.isolate !== undefined ||
    params.showDimensions === true ||
    params.section !== undefined ||
    wantAxes ||
    wantGrid ||
    wantLabels;

  if (!hasEnrichment) return null;

  // Base render params forwarded to core
  const baseView = typeof params.view === 'string' ? params.view : 'iso';
  const baseWidth =
    typeof params.width === 'number' ? Math.max(64, Math.min(2000, Math.round(params.width))) : 800;
  const baseHeight =
    typeof params.height === 'number'
      ? Math.max(64, Math.min(2000, Math.round(params.height)))
      : 600;

  const doc = getDoc();
  const docUnits: string = doc.units ?? 'mm';

  // ------------------------------------------------------------------
  // turntable: N-frame horizontal strip
  // ------------------------------------------------------------------
  if (params.turntable !== undefined) {
    const frames = Math.max(1, Math.min(12, Math.round(params.turntable.frames)));
    const svgs = buildTurntableFrames(doc, frames, baseView, baseWidth, baseHeight);
    if (svgs === null || svgs.length === 0) {
      return makeErrorResult('render_view turntable: failed to produce frames.');
    }

    // Rasterize each frame and concatenate horizontally into a single SVG strip.
    // We compose the SVGs side-by-side in a wrapper SVG, then rasterize once.
    const totalWidth = baseWidth * svgs.length;
    const stripLines: string[] = [];
    stripLines.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${baseHeight}" viewBox="0 0 ${totalWidth} ${baseHeight}">`,
    );
    stripLines.push(`  <rect width="${totalWidth}" height="${baseHeight}" fill="#1a1a2e"/>`);
    for (let i = 0; i < svgs.length; i++) {
      const inner = extractSvgInnerPublic(svgs[i] as string);
      stripLines.push(`  <g transform="translate(${i * baseWidth}, 0)">${inner}</g>`);
    }
    // Frame number labels
    for (let i = 0; i < svgs.length; i++) {
      const angle = Math.round((360 * i) / svgs.length);
      stripLines.push(
        `  <text x="${r2Public(i * baseWidth + 4)}" y="32" font-family="monospace" font-size="13" fill="#aaaacc">${angle}°</text>`,
      );
    }
    stripLines.push('</svg>');
    const stripSvg = stripLines.join('\n');

    const base64 = rasterizeSvg(stripSvg, totalWidth);
    if (base64 === null) {
      return makeErrorResult('render_view turntable: rasterization failed.');
    }

    const summary = `Rendered turntable strip: ${frames} frame(s), ${totalWidth}×${baseHeight}.`;
    const shaped = shapeToolCallContent({
      summary,
      affected: [],
      isError: false,
    }) as CallToolResult;
    (shaped.content as unknown[]).push({ type: 'image', data: base64, mimeType: 'image/png' });
    return shaped;
  }

  // ------------------------------------------------------------------
  // isolate: highlight specific entities, dim everything else
  // ------------------------------------------------------------------
  if (params.isolate !== undefined) {
    const rawIsolate = params.isolate;
    const ids: string[] = Array.isArray(rawIsolate)
      ? (rawIsolate as string[])
      : typeof rawIsolate === 'string'
        ? [rawIsolate]
        : [];

    let svg = buildIsolateSvg(doc, ids, baseView, baseWidth, baseHeight);
    if (svg === null) {
      return makeErrorResult('render_view isolate: render failed.');
    }

    // Compose overlay enrichments on top
    const baseResult = applyCommand('render_view', {
      view: baseView,
      width: baseWidth,
      height: baseHeight,
    });
    if (params.showDimensions === true && baseResult.data) {
      svg = appendDimensionLabels(
        svg,
        baseResult.data as import('@core/commands/render').RenderViewData,
      );
    }
    if ((wantAxes || wantGrid) && baseResult.data) {
      svg = appendAxesAndGrid(
        svg,
        baseResult.data as import('@core/commands/render').RenderViewData,
        docUnits,
        wantAxes,
        wantGrid,
      );
    }
    if (wantLabels && baseResult.data) {
      const allEntities = Object.values(doc.entities).filter(
        (e): e is NonNullable<typeof e> => e !== undefined,
      );
      svg = appendEntityLabels(
        svg,
        baseResult.data as import('@core/commands/render').RenderViewData,
        allEntities,
      );
    }

    const base64 = rasterizeSvg(svg, baseWidth);
    if (base64 === null) {
      return makeErrorResult('render_view isolate: rasterization failed.');
    }

    const summary = `Rendered isolated view: ${ids.length} entity/entities highlighted, ${baseWidth}×${baseHeight}.`;
    const shaped = shapeToolCallContent({
      summary,
      affected: [],
      isError: false,
    }) as CallToolResult;
    (shaped.content as unknown[]).push({ type: 'image', data: base64, mimeType: 'image/png' });
    return shaped;
  }

  // ------------------------------------------------------------------
  // section: section-plane view
  // ------------------------------------------------------------------
  if (params.section !== undefined) {
    const { axis, offset } = params.section;
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
      return makeErrorResult(
        `render_view section: invalid axis "${String(axis)}". Must be "x", "y", or "z".`,
      );
    }

    let svg = buildSectionSvg(doc, { axis, offset }, baseView, baseWidth, baseHeight);
    if (svg === null) {
      return makeErrorResult('render_view section: render failed.');
    }

    // Compose overlay enrichments on top
    const baseResult = applyCommand('render_view', {
      view: baseView,
      width: baseWidth,
      height: baseHeight,
    });
    if (params.showDimensions === true && baseResult.data) {
      svg = appendDimensionLabels(
        svg,
        baseResult.data as import('@core/commands/render').RenderViewData,
      );
    }
    if ((wantAxes || wantGrid) && baseResult.data) {
      svg = appendAxesAndGrid(
        svg,
        baseResult.data as import('@core/commands/render').RenderViewData,
        docUnits,
        wantAxes,
        wantGrid,
      );
    }
    if (wantLabels && baseResult.data) {
      const allEntities = Object.values(doc.entities).filter(
        (e): e is NonNullable<typeof e> => e !== undefined,
      );
      svg = appendEntityLabels(
        svg,
        baseResult.data as import('@core/commands/render').RenderViewData,
        allEntities,
      );
    }

    const base64 = rasterizeSvg(svg, baseWidth);
    if (base64 === null) {
      return makeErrorResult('render_view section: rasterization failed.');
    }

    const summary = `Rendered section view: cut at ${axis}=${offset}, ${baseWidth}×${baseHeight}.`;
    const shaped = shapeToolCallContent({
      summary,
      affected: [],
      isError: false,
    }) as CallToolResult;
    (shaped.content as unknown[]).push({ type: 'image', data: base64, mimeType: 'image/png' });
    return shaped;
  }

  // ------------------------------------------------------------------
  // showDimensions / showAxes / showGrid (no other enrichment): base render + post-process
  // ------------------------------------------------------------------
  const busResult = applyCommand('render_view', {
    view: baseView,
    width: baseWidth,
    height: baseHeight,
  });
  if (!busResult.data) {
    return makeErrorResult('render_view enrichment: base render returned no data.');
  }
  const baseData = busResult.data as import('@core/commands/render').RenderViewData;

  let enrichedSvg = baseData.svg;

  if (params.showDimensions === true) {
    enrichedSvg = appendDimensionLabels(enrichedSvg, baseData);
  }
  if (wantAxes || wantGrid) {
    enrichedSvg = appendAxesAndGrid(enrichedSvg, baseData, docUnits, wantAxes, wantGrid);
  }
  if (wantLabels) {
    const allEntities = Object.values(doc.entities).filter(
      (e): e is NonNullable<typeof e> => e !== undefined,
    );
    enrichedSvg = appendEntityLabels(enrichedSvg, baseData, allEntities);
  }

  const base64 = rasterizeSvg(enrichedSvg, baseWidth);
  if (base64 === null) {
    return makeErrorResult('render_view enrichment: rasterization failed.');
  }

  const summary = `Rendered view: ${baseData.entityCount} entit${baseData.entityCount === 1 ? 'y' : 'ies'}, ${baseWidth}×${baseHeight}.`;
  const shaped = shapeToolCallContent({
    summary,
    affected: [],
    isError: false,
    data: stripSvgFromData(busResult.data),
  }) as CallToolResult;
  (shaped.content as unknown[]).push({ type: 'image', data: base64, mimeType: 'image/png' });
  return shaped;
}

/** Build an error CallToolResult for enrichment failures. */
export function makeErrorResult(message: string): CallToolResult {
  return shapeToolCallContent({ summary: message, affected: [], isError: true }) as CallToolResult;
}

/** Extract SVG inner content (strips outer svg tags). Used by enrichment functions. */
function extractSvgInnerPublic(svgString: string): string {
  const openEnd = svgString.indexOf('>');
  if (openEnd === -1) return svgString;
  const closeStart = svgString.lastIndexOf('</svg>');
  if (closeStart === -1) return svgString.substring(openEnd + 1);
  return svgString.substring(openEnd + 1, closeStart);
}

/** Round to 2 decimal places (used in SVG coordinate output). */
function r2Public(n: number): number {
  return Math.round(n * 100) / 100;
}
