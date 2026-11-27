/**
 * render_view over its polygon budget (ASC M6b, FR-ASC-25, TR-ASC-17): never a fragmented image. The reference render (TypeScript raster, deterministic) stands
 * when it drew everything. When the budget decimated or skipped entities, a plain request is routed to
 *   1. `ctx.viewportCapture` (the desktop viewport: its own lighting, perspective camera, no polygon budget), else
 *   2. `ctx.raster` (the native GPU raster of the same scene), only for scenes of at most NATIVE_ROUTE_BUDGET polygons, else
 *   3. the best effort with a RENDER_BUDGET_EXCEEDED warning and `data.drawnShare`.
 * A routed picture is a picture, not a reference: `data.deterministic` false, no `svgSha256`; the summary names how it differs.
 * @invariant under budget the reference result is returned as is (same object); the document is never changed
 * @invariant plain = none of turntable, isolate, section, cut, overlay, viewpoint, review styling, hide2D, vector mode, projection, fovDeg, title, showLabels, showDimensions, explicit renderer; others get the warning only (`renderer: 'reference'` keeps the reference picture and its svgSha256)
 * @invariant the native raster is never asked for a scene above NATIVE_ROUTE_BUDGET polygons (the summary says so): its scene buffers are about 150 bytes per polygon on the event loop
 * @invariant a viewport refusal other than VIEWPORT_PENDING falls through to the next branch (named in the summary, except VIEWPORT_UNAVAILABLE: no app is not a failure); VIEWPORT_PENDING is returned so the host awaits the frame and runs the command again
 */

import type { CadDocument } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import type { ViewportCaptureRequest } from '../../model/viewportCapture';
import { uint8ArrayToBase64 } from '../../lib/base64';
import { isRecord } from '../../lib/isRecord';
import { codedRejection } from '../noop';
import type { RenderViewData, ViewportPictureData } from './types';

/**
 * Named guard (PROVISIONAL: no native raster was available to measure it): scene polygons above which the native raster is not asked. About 150 bytes per
 * polygon (Float64 face / loop / point buffers plus the polygon objects) puts 1M at roughly 150 MB; a larger assembly goes to the viewport or the warning.
 */
export const NATIVE_ROUTE_BUDGET = 1_000_000;
const WARNING_CODE = 'RENDER_BUDGET_EXCEEDED';
const PENDING = 'VIEWPORT_PENDING';
const UNAVAILABLE = 'VIEWPORT_UNAVAILABLE';

/** The request fields routing reads (structural: the zod params of render_view satisfy it). */
interface RoutedParams {
  readonly view?: ViewportCaptureRequest['view'] | undefined;
  readonly direction?: readonly [number, number, number] | undefined;
  readonly target?: readonly [number, number, number] | undefined;
  readonly zoom?: number | undefined;
  readonly background?: string | undefined;
  readonly mode?: 'raster' | 'vector' | undefined;
  readonly renderer?: 'reference' | 'native' | undefined;
  readonly projection?: 'orthographic' | 'perspective' | undefined;
  readonly fovDeg?: number | undefined;
  readonly title?: string | undefined;
  readonly showLabels?: boolean | undefined;
  readonly showDimensions?: boolean | undefined;
  readonly turntable?: unknown;
  readonly isolate?: unknown;
  readonly section?: unknown;
  readonly cut?: unknown;
  readonly overlay?: unknown;
  readonly viewpointId?: string | undefined;
  readonly camera?: string | undefined;
  readonly hide2D?: boolean | undefined;
  readonly colourProfileId?: string | undefined;
  readonly sectionBoxId?: string | undefined;
  readonly shading?: string | undefined;
  readonly issueId?: string | undefined;
  readonly highlightEntityIds?: unknown;
}

type RenderOnce<P> = (doc: CadDocument, params: P, ctx: ExecutionContext | undefined, budget?: number) => CommandResult;

const isData = (value: unknown): value is RenderViewData => isRecord(value) && Array.isArray(value['simplifiedEntityIds']);

const overBudget = (data: RenderViewData): boolean => data.simplifiedEntityIds.length + data.skippedEntityIds.length > 0;

const plain = (p: RoutedParams): boolean =>
  [
    p.turntable,
    p.isolate,
    p.section,
    p.cut,
    p.overlay,
    p.viewpointId,
    p.camera,
    p.colourProfileId,
    p.sectionBoxId,
    p.issueId,
    p.highlightEntityIds,
    p.renderer,
    p.projection,
    p.fovDeg,
    p.title,
  ].every((value) => value === undefined) &&
  p.hide2D !== true &&
  p.showLabels !== true &&
  p.showDimensions !== true &&
  p.mode !== 'vector' &&
  p.shading !== 'review';

const share = (data: RenderViewData): number =>
  data.polygonTotal === undefined || data.polygonTotal === 0 ? 1 : data.polygonCount / data.polygonTotal;

const percent = (value: number): string => `${Math.round(value * 1000) / 10}%`;

const withNote = (result: CommandResult, data: RenderViewData, extra: Partial<RenderViewData>, note: string): CommandResult => ({
  ...result,
  summary: `${result.summary} ${note}`,
  data: { ...data, ...extra },
});

/** The picture as the self-contained SVG render_view returns (the viewport's PNG embedded), so `--save x.png` and `data.svg` consumers keep working. */
function pictureSvg(png: Uint8Array, width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${uint8ArrayToBase64(png)}"/></svg>`
  );
}

/** What the viewport route says about itself: a result to return, or the reason to put in the summary ('' = nothing to say). */
type ViewportRoute = { readonly result: CommandResult } | { readonly note: string };

function viaViewport(
  doc: CadDocument,
  params: RoutedParams,
  ctx: ExecutionContext | undefined,
  result: CommandResult,
  data: RenderViewData,
): ViewportRoute {
  const port = ctx?.viewportCapture ?? null;
  if (port === null) return { note: '' };
  const request: ViewportCaptureRequest = {
    view: params.view ?? 'iso',
    ...(params.direction !== undefined ? { direction: params.direction } : {}),
    ...(params.target !== undefined ? { target: params.target } : {}),
    zoom: params.zoom ?? 1,
    width: data.width,
    height: data.height,
    ...(params.background !== undefined ? { background: params.background } : {}),
    hideLayers: [],
  };
  const outcome = port.capture(request, doc);
  if (!outcome.ok) {
    if (outcome.code === PENDING)
      return {
        result: codedRejection(doc, 'render_view', PENDING, outcome.message, 'The host runs the command again once the frame is drawn.'),
      };
    return { note: outcome.code === UNAVAILABLE ? '' : `The desktop viewport could not draw it (${outcome.code}: ${outcome.message}).` };
  }
  const { svgSha256: _digest, rendererVersion: _version, polygonCount, polygonBudget, polygonTotal, ...rest } = data;
  void _digest;
  void _version;
  const picture: ViewportPictureData = {
    ...rest,
    svg: pictureSvg(outcome.png, outcome.width, outcome.height),
    width: outcome.width,
    height: outcome.height,
    simplifiedEntityIds: [],
    skippedEntityIds: [],
    referencePolygonCount: polygonCount,
    referencePolygonBudget: polygonBudget,
    ...(polygonTotal === undefined ? {} : { referencePolygonTotal: polygonTotal }),
    drawnShare: 1,
    routedTo: 'viewport',
    renderer: 'viewport',
    engine: 'desktop-viewport',
    deterministic: false,
  };
  const note =
    `Over the polygon budget (${percent(share(data))} of ${data.polygonTotal ?? data.polygonCount} polygons drawn by the reference raster): ` +
    'drawn by the open desktop viewport instead (all geometry, no budget). It is a picture, not a reference (no svgSha256, deterministic false) and differs from the reference raster: ' +
    'perspective camera framing the visible scene, the app lighting and materials, no crease outlines, no axes / grid / title / dimension overlays, and `data.camera` / `bounds` describe the reference framing.';
  return { result: { ...result, summary: `${result.summary} ${note}`, data: picture } };
}

/**
 * `result` (the reference render of `params`) when it drew everything; else the viewport picture, the native raster picture, or `result` with the warning.
 * @failure VIEWPORT_PENDING from the port is returned as the refusal (the host awaits the frame and runs the command again)
 */
export function routeOverBudget<P extends RoutedParams>(
  doc: CadDocument,
  params: P,
  ctx: ExecutionContext | undefined,
  result: CommandResult,
  renderOnce: RenderOnce<P>,
): CommandResult {
  const data: unknown = result.data;
  if (result.error !== undefined || !isData(data) || !overBudget(data)) return result;
  const drawn = share(data);
  const total = data.polygonTotal ?? data.polygonCount;
  const warning = (note: string): CommandResult =>
    withNote(
      result,
      data,
      { drawnShare: drawn, warnings: [{ code: WARNING_CODE, message: `${percent(drawn)} of the polygons are drawn` }] },
      `${WARNING_CODE}: ${percent(drawn)} of ${total} polygons are drawn (the rest is decimated or skipped; see simplifiedEntityIds / skippedEntityIds). ${note}`.trim(),
    );
  if (!plain(params))
    return warning(
      "Routing to a GPU path needs a plain request (no turntable, isolate, section, cut, overlay, viewpoint, review styling, vector mode, projection, fovDeg, title, labels, dimensions or explicit renderer; renderer 'reference' keeps this picture and its svgSha256).",
    );
  const skipped: string[] = [];
  const viewport = viaViewport(doc, params, ctx, result, data);
  if ('result' in viewport) return viewport.result;
  if (viewport.note !== '') skipped.push(viewport.note);
  if ((ctx?.raster ?? null) !== null) {
    if (total > NATIVE_ROUTE_BUDGET) {
      skipped.push(`The native raster was not asked: ${total} polygons are above its limit of ${NATIVE_ROUTE_BUDGET}.`);
      return warning(skipped.join(' '));
    }
    const native = renderOnce(doc, { ...params, renderer: 'native' }, ctx, NATIVE_ROUTE_BUDGET);
    const nativeData: unknown = native.data;
    if (native.error === undefined && isData(nativeData) && !overBudget(nativeData))
      return withNote(
        native,
        nativeData,
        { drawnShare: 1, routedTo: 'raster' },
        `Over the polygon budget of the reference raster (${percent(drawn)} drawn): drawn by the native raster with a budget of ${NATIVE_ROUTE_BUDGET} polygons (a picture, deterministic false, no svgSha256). ${skipped.join(' ')}`.trim(),
      );
    skipped.push(`The native raster could not draw it (${native.error?.code ?? 'still over its budget'}).`);
  }
  return warning(skipped.join(' '));
}
