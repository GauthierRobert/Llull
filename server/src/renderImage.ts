/**
 * @layer server
 *
 * SVG → PNG rasterization helper for MCP image content blocks.
 *
 * Uses @resvg/resvg-js (napi-rs, prebuilt binaries — no build toolchain needed).
 * Isolated here so mcp.ts stays transport-only and this helper is unit-testable.
 *
 * Architecture note: this file exists because rasterization is a server-side
 * side effect (native binary + I/O).  It MUST NOT be moved to core/mcp (L2:
 * core is fetch/native-free).
 */

import { Resvg } from '@resvg/resvg-js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An MCP image content block.
 *
 * Shape required by the MCP SDK's CallToolResult `content` array.
 * `data` is a base64-encoded PNG with NO `data:` URI prefix — the SDK
 * or host handles the URI wrapping when needed.
 */
export interface ImageContentBlock {
  type: 'image';
  data: string;
  mimeType: 'image/png';
}

// ---------------------------------------------------------------------------
// Rasterization
// ---------------------------------------------------------------------------

/**
 * Rasterize an SVG string to a base64-encoded PNG.
 *
 * Returns `null` (never throws) when rasterization fails — callers must treat
 * null as "no image available" and fall back to text-only content.
 *
 * @param svg   - A complete, self-contained SVG document string.
 * @param width - Render width in pixels (height scales proportionally).
 *                Defaults to the SVG's intrinsic width when omitted or ≤ 0.
 * @returns base64 PNG string (no `data:` prefix), or null on failure.
 */
export function rasterizeSvg(svg: string, width?: number): string | null {
  try {
    const opts =
      typeof width === 'number' && width > 0
        ? { fitTo: { mode: 'width' as const, value: width } }
        : {};
    const resvg = new Resvg(svg, opts);
    const pngBuffer = resvg.render().asPng();
    return pngBuffer.toString('base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MCP content block builder
// ---------------------------------------------------------------------------

/**
 * Strip the `svg` field from a data record before text/structured content shaping.
 *
 * When a command result carries `data.svg` and we rasterize it to a PNG image
 * block, the raw SVG markup is redundant in the text/JSON representation — it is
 * multi-KB of `<polygon>` noise that burns agent context without adding value.
 * The other metadata fields (`bounds`, `camera`, `entityCount`, `width`, `height`,
 * `view`) remain so non-multimodal clients and programmatic agents keep them.
 *
 * Called by the `tools/call` handler in `mcp.ts` AFTER confirming an image block
 * was produced (i.e. `buildImageBlock` returned non-null). Only strips when `data`
 * is a plain record; returns `data` unchanged for arrays or non-objects.
 *
 * @pure — returns a new object, never mutates the input.
 * @layer server
 *
 * @param data - The `data` field from a CommandBusResult.
 * @returns A new record with `svg` omitted, or the original value if not a record.
 */
export function stripSvgFromData(data: unknown): unknown {
  if (
    typeof data !== 'object' ||
    data === null ||
    Array.isArray(data)
  ) {
    return data;
  }
  const record = data as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== 'svg') rest[key] = record[key];
  }
  return rest;
}

/**
 * Build an MCP image content block from a busResult's `data` field.
 *
 * Triggers when `data.svg` is a non-empty string — generic, not command-specific.
 * Any future SVG-emitting command gets an image block for free.
 *
 * Returns `null` when:
 *   - `data` is not a record with a string `svg` field.
 *   - Rasterization fails (malformed SVG, resvg error).
 *
 * @param data - The `data` field from a CommandBusResult (may be undefined).
 * @returns An image content block, or null when no image is available.
 */
export function buildImageBlock(data: unknown): ImageContentBlock | null {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as Record<string, unknown>)['svg'] !== 'string'
  ) {
    return null;
  }

  const record = data as Record<string, unknown>;
  const svg = record['svg'] as string;
  if (svg.length === 0) return null;

  const width =
    typeof record['width'] === 'number' && record['width'] > 0
      ? record['width']
      : undefined;

  const base64 = rasterizeSvg(svg, width);
  if (base64 === null) return null;

  return { type: 'image', data: base64, mimeType: 'image/png' };
}
