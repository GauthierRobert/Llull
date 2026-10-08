/**
 * @layer server
 *
 * SVG → PNG rasterization for MCP image content blocks, via @resvg/resvg-js (napi-rs, prebuilt
 * binaries). Server-side because it is a native-binary side effect: it MUST NOT move to core/mcp (L2).
 */

import { Resvg } from '@resvg/resvg-js';
import { isRecord } from '@lib/isRecord';

/** An MCP image content block; `data` is base64 PNG with NO `data:` URI prefix. */
interface ImageContentBlock {
  type: 'image';
  data: string;
  mimeType: 'image/png';
}

/** Longest side of a rasterized image: bounds pixmap memory whatever a command's svg asks for. */
export const MAX_RASTER_PX = 4096;

/**
 * Rasterize a complete SVG document to a base64 PNG, `width` px wide (height scales; intrinsic
 * width when omitted or ≤ 0). The longest side is capped at `MAX_RASTER_PX`, keeping the aspect.
 * @failure rasterization error → null (never throws): callers fall back to text-only content
 */
export function rasterizeSvg(svg: string, width?: number): string | null {
  try {
    const intrinsic = new Resvg(svg);
    const wantedWidth = typeof width === 'number' && width > 0 ? width : intrinsic.width;
    const wantedHeight = (intrinsic.height * wantedWidth) / Math.max(intrinsic.width, 1);
    const scale = Math.min(1, MAX_RASTER_PX / Math.max(wantedWidth, wantedHeight, 1));
    const fitWidth = Math.max(1, Math.floor(wantedWidth * scale));
    const opts = { fitTo: { mode: 'width' as const, value: fitWidth } };
    return new Resvg(svg, opts).render().asPng().toString('base64');
  } catch {
    return null;
  }
}

/**
 * Drop `svg` from a data record once it is rasterized: the multi-KB markup burns agent context while
 * the other fields (`bounds`, `camera`, `width`, …) stay for non-multimodal clients.
 * @pure returns a new record; non-record data is returned unchanged
 */
export function stripSvgFromData(data: unknown): unknown {
  if (!isRecord(data)) return data;
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'svg'));
}

/**
 * Image block for a command result's `data` — generic: any command whose `data.svg` is a non-empty
 * string gets one, sized by `data.width` when positive.
 * @failure no svg / rasterization error → null
 */
export function buildImageBlock(data: unknown): ImageContentBlock | null {
  if (!isRecord(data)) return null;
  const { svg, width } = data;
  if (typeof svg !== 'string' || svg.length === 0) return null;
  const base64 = rasterizeSvg(svg, typeof width === 'number' ? width : undefined);
  return base64 === null ? null : { type: 'image', data: base64, mimeType: 'image/png' };
}
