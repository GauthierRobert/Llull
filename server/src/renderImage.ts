/**
 * SVG → PNG rasterization (CLI `--save view.png`, image blocks for the production agent gate), via @resvg/resvg-js
 * (napi-rs, prebuilt binaries). Server-side because it is a native-binary side effect: it MUST NOT move to a package (L2).
 */

import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'module';
import { Resvg } from '@resvg/resvg-js';
import { isRecord } from '@lib/isRecord';

/** An image content block; `data` is base64 PNG with NO `data:` URI prefix. */
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
 * resvg 2.6 aborts the whole process (Rust panic, "failed to initiate panic") on an element with `opacity` whose
 * content lies entirely outside the canvas — e.g. the ground grid of a zoomed-in `render_view`. On shapes and groups of
 * non-overlapping strokes, `opacity` equals fill/stroke-opacity, which resvg renders safely. `<image>` and the root keep theirs.
 */
export function sanitizeSvgForResvg(svg: string): string {
  return svg.replace(
    /<(?!image\b|svg\b)([a-zA-Z]+)\b([^>]*?)\sopacity="([0-9.]+)"([^>]*)>/g,
    '<$1$2 stroke-opacity="$3" fill-opacity="$3"$4>',
  );
}

const RENDER_SCRIPT =
  "const{Resvg}=require(process.argv[1]);const i=JSON.parse(require('fs').readFileSync(0,'utf8'));" +
  "process.stdout.write(new Resvg(i.svg,{fitTo:{mode:'width',value:i.fitWidth}}).render().asPng())";

/** Child-process launch of one render; inside the desktop backend process.execPath is the Electron binary, run as plain node. */
function renderChild(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const resvgPath = createRequire(__filename).resolve('@resvg/resvg-js');
  return { command: process.execPath, args: ['-e', RENDER_SCRIPT, resvgPath], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * Render in a throw-away node process: a native abort inside resvg (Rust panic across the napi boundary
 * cannot unwind) then kills only the child, never the CLI or the backend. Blocking: for the CLI.
 */
function renderIsolated(svg: string, fitWidth: number): Buffer | null {
  const child = renderChild();
  const result = spawnSync(child.command, child.args, {
    input: JSON.stringify({ svg, fitWidth }),
    timeout: RASTER_TIMEOUT_MS,
    maxBuffer: RASTER_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: child.env,
  });
  return result.status === 0 && result.stdout.length > 0 ? result.stdout : null;
}

/** `renderIsolated` without blocking the event loop (the backend keeps serving other clients while a render runs). */
function renderIsolatedAsync(svg: string, fitWidth: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = renderChild();
    const process_ = spawn(child.command, child.args, { stdio: ['pipe', 'pipe', 'ignore'], env: child.env });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => process_.kill('SIGKILL'), RASTER_TIMEOUT_MS);
    process_.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > RASTER_MAX_BUFFER) process_.kill('SIGKILL');
      else chunks.push(chunk);
    });
    process_.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    process_.on('close', (code) => {
      clearTimeout(timer);
      const png = Buffer.concat(chunks);
      resolve(code === 0 && png.length > 0 && size <= RASTER_MAX_BUFFER ? png : null);
    });
    process_.stdin.on('error', () => undefined);
    process_.stdin.end(JSON.stringify({ svg, fitWidth }));
  });
}

/** The sanitized svg and the pixel width to render it at, or null when resvg cannot even parse it. */
function rasterPlan(svg: string, width: number | undefined): { clean: string; fitWidth: number } | null {
  try {
    const clean = sanitizeSvgForResvg(svg);
    const intrinsic = new Resvg(clean);
    const wantedWidth = typeof width === 'number' && width > 0 ? width : intrinsic.width;
    const wantedHeight = (intrinsic.height * wantedWidth) / Math.max(intrinsic.width, 1);
    const scale = Math.min(1, MAX_RASTER_PX / Math.max(wantedWidth, wantedHeight, 1));
    return { clean, fitWidth: Math.max(1, Math.floor(wantedWidth * scale)) };
  } catch {
    return null;
  }
}

/**
 * Rasterize a complete SVG document to a base64 PNG, `width` px wide (height scales; intrinsic
 * width when omitted or <= 0). The longest side is capped at `MAX_RASTER_PX`, keeping the aspect.
 * The render itself runs in a child process (see `renderIsolated`).
 * @failure rasterization error or native abort -> null (never throws, never kills the caller): callers fall back to text-only content
 */
export function rasterizeSvg(svg: string, width?: number): string | null {
  const plan = rasterPlan(svg, width);
  return plan === null ? null : (renderIsolated(plan.clean, plan.fitWidth)?.toString('base64') ?? null);
}

/** `rasterizeSvg` for the server: same result, the render runs without blocking the event loop. */
async function rasterizeSvgAsync(svg: string, width?: number): Promise<string | null> {
  const plan = rasterPlan(svg, width);
  if (plan === null) return null;
  return (await renderIsolatedAsync(plan.clean, plan.fitWidth))?.toString('base64') ?? null;
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
export async function buildImageBlock(data: unknown): Promise<ImageContentBlock | null> {
  if (!isRecord(data)) return null;
  const { svg, width } = data;
  if (typeof svg !== 'string' || svg.length === 0) return null;
  const base64 = await rasterizeSvgAsync(svg, typeof width === 'number' ? width : undefined);
  return base64 === null ? null : { type: 'image', data: base64, mimeType: 'image/png' };
}
