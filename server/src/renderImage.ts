/**
 * SVG → PNG rasterization for MCP image content blocks, via @resvg/resvg-js (napi-rs, prebuilt
 * binaries). Server-side because it is a native-binary side effect: it MUST NOT move to core/mcp (L2).
 */

import { spawnSync } from 'child_process';
import { createRequire } from 'module';
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

/** Child-process budget for one rasterization (a 4096 px render of a multi-MB svg stays far below). */
const RASTER_TIMEOUT_MS = 60_000;
const RASTER_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * resvg 2.6 aborts the whole process (Rust panic, "failed to initiate panic") on a `<g opacity>` layer whose
 * content lies entirely outside the canvas — e.g. the ground grid of a zoomed-in `render_view`. Group opacity
 * on such a group is equivalent to fill/stroke-opacity on its (non-overlapping) strokes, which resvg renders safely.
 */
export function sanitizeSvgForResvg(svg: string): string {
  return svg.replace(/<g\b([^>]*?)\sopacity="([0-9.]+)"([^>]*)>/g, '<g$1 stroke-opacity="$2" fill-opacity="$2"$3>');
}

/**
 * Render in a throw-away node process: a native abort inside resvg (Rust panic across the napi boundary
 * cannot unwind) then kills only the child, never the CLI or the MCP host.
 */
function renderIsolated(svg: string, fitWidth: number): Buffer | null {
  const script =
    "const{Resvg}=require(process.argv[1]);const i=JSON.parse(require('fs').readFileSync(0,'utf8'));" +
    "process.stdout.write(new Resvg(i.svg,{fitTo:{mode:'width',value:i.fitWidth}}).render().asPng())";
  const resvgPath = createRequire(__filename).resolve('@resvg/resvg-js');
  const result = spawnSync(process.execPath, ['-e', script, resvgPath], {
    input: JSON.stringify({ svg, fitWidth }),
    timeout: RASTER_TIMEOUT_MS,
    maxBuffer: RASTER_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'ignore'],
    // Inside the desktop backend process.execPath is the Electron binary: run it as plain node.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return result.status === 0 && result.stdout.length > 0 ? result.stdout : null;
}

/**
 * Rasterize a complete SVG document to a base64 PNG, `width` px wide (height scales; intrinsic
 * width when omitted or <= 0). The longest side is capped at `MAX_RASTER_PX`, keeping the aspect.
 * The render itself runs in a child process (see `renderIsolated`).
 * @failure rasterization error or native abort -> null (never throws, never kills the caller): callers fall back to text-only content
 */
export function rasterizeSvg(svg: string, width?: number): string | null {
  try {
    const clean = sanitizeSvgForResvg(svg);
    const intrinsic = new Resvg(clean);
    const wantedWidth = typeof width === 'number' && width > 0 ? width : intrinsic.width;
    const wantedHeight = (intrinsic.height * wantedWidth) / Math.max(intrinsic.width, 1);
    const scale = Math.min(1, MAX_RASTER_PX / Math.max(wantedWidth, wantedHeight, 1));
    const fitWidth = Math.max(1, Math.floor(wantedWidth * scale));
    return renderIsolated(clean, fitWidth)?.toString('base64') ?? null;
  } catch {
    return null;
  }
}

/**
 * Drop `svg` from a data record once it is rasterized: the multi-KB markup burns agent context while
 * the other fields (`bounds`, `camera`, `width`, …) stay for non-multimodal clients.
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
