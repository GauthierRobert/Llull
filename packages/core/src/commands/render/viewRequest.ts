/**
 * render_view parameters of plant 09 VIS-M4 / VIS-M9: projection, viewpoint and renderer, and the result provenance (reference digest or
 * native picture). Perspective and viewpoint renders are raster-only and draw no orthographic overlays (grid, axes, labels, dimensions).
 */

import type { CadDocument } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { z } from '../schema';
import { report } from '../noop';
import { reviewRejection } from '../review/reviewModel';
import { resolveViewSetup } from './viewSetup';
import { nativeRun, referenceProvenance } from './rendererProvenance';
import type { RenderOptions, RenderViewData } from './types';
import type { ViewName } from './camera';
import type { Vec3 } from '../../model/types';

export const viewParams = {
  projection: z
    .enum(['orthographic', 'perspective'])
    .optional()
    .describe(
      '"orthographic" (default) or "perspective" (raster mode only; the eye is placed on the view direction so the scene fits fovDeg). ' +
        'Perspective draws no grid / axes / labels / dimensions and cannot be combined with turntable, isolate or section.',
    ),
  fovDeg: z.number().optional().describe('Perspective vertical field of view in degrees, (0, 180). Default 45 (the viewport).'),
  viewpointId: z
    .string()
    .optional()
    .describe('Render from a saved viewpoint (save_viewpoint): its camera replaces view / direction / target / zoom / projection.'),
  renderer: z
    .enum(['reference', 'native'])
    .optional()
    .describe(
      '"reference" (default): the TypeScript raster, deterministic, data.svgSha256 + rendererVersion (use it for anything reproducible). ' +
        '"native": the same scene drawn on the GPU by llull-compute raster (CLI / desktop app only): a picture, no svgSha256, ' +
        'data.deterministic false, data.device / version / engine. Raster mode only. No binary in this host: NATIVE_TOOL_MISSING.',
    ),
};

interface ViewRequest {
  readonly view?: ViewName | undefined;
  readonly direction?: Vec3 | undefined;
  readonly target?: Vec3 | undefined;
  readonly projection?: 'orthographic' | 'perspective' | undefined;
  readonly fovDeg?: number | undefined;
  readonly viewpointId?: string | undefined;
  readonly renderer?: 'reference' | 'native' | undefined;
  readonly turntable?: unknown;
  readonly isolate?: unknown;
  readonly section?: unknown;
}

type Finish = (doc: CadDocument, summary: string, data: RenderViewData) => CommandResult;

export type PreparedView =
  | { readonly perspective: boolean; readonly finish: Finish }
  | { readonly code: string; readonly message: string; readonly paths: readonly string[] };

/**
 * Applies the viewpoint / perspective camera and the native pixel stage to `options` (a fresh object owned by the caller).
 * @failure unknown viewpoint, invalid fov, perspective with vector mode or multi-pass views, native without raster mode or port -> code
 */
export function prepareView(
  doc: CadDocument,
  params: ViewRequest,
  options: RenderOptions,
  width: number,
  height: number,
  ctx: ExecutionContext | undefined,
): PreparedView {
  const setup = resolveViewSetup(doc, { ...params, zoom: options.zoom }, width, height);
  if ('code' in setup) return { ...setup, paths: [params.viewpointId !== undefined ? 'viewpointId' : 'fovDeg'] };
  const perspective = setup.projection === 'perspective';
  if (perspective && options.mode === 'vector')
    return { code: 'VIS_RENDER_INVALID', message: 'perspective renders are raster-only (omit mode or use "raster")', paths: ['mode'] };
  if (perspective && (params.turntable !== undefined || params.isolate !== undefined || params.section !== undefined))
    return {
      code: 'VIS_RENDER_INVALID',
      message: 'perspective renders cannot be combined with turntable, isolate or section',
      paths: ['projection'],
    };
  if (setup.view !== undefined) options.view = setup.view;
  const data = { projection: setup.projection, ...(params.viewpointId !== undefined ? { viewpointId: params.viewpointId } : {}) };
  if (params.renderer !== 'native')
    return { perspective, finish: (d, summary, base) => report(d, summary, { ...base, ...data, ...referenceProvenance(base.svg) }) };
  if (options.mode === 'vector')
    return { code: 'VIS_RENDER_INVALID', message: 'the native renderer draws raster mode only (omit mode)', paths: ['renderer'] };
  const port = ctx?.raster ?? null;
  if (port === null)
    return { code: 'NATIVE_TOOL_MISSING', message: 'no native raster (llull-compute) is installed in this host', paths: ['renderer'] };
  const native = nativeRun(port, 'gpu');
  options.pixels = native.pixels;
  const finish: Finish = (d, summary, base) => {
    const outcome = native.result();
    if ('code' in outcome) return reviewRejection(d, 'render_view', outcome.code, outcome.message, [], ['renderer']);
    const note = `Drawn by the native raster (${outcome.engine}, ${outcome.device}): a picture, not a reference (no svgSha256).`;
    return report(d, `${summary} ${note}`, { ...base, ...data, ...outcome });
  };
  return { perspective, finish };
}
