/** capture_viewport (ASC M6a, FR-ASC-24): a PNG of the open desktop viewport at a temporary camera, through `ctx.viewportCapture`. */

import { defineCommand, vec3, z } from '../schema';
import { codedRejection, report } from '../noop';
import { uint8ArrayToBase64 } from '../../lib/base64';
import type { ViewportCaptureRequest } from '../../model/viewportCapture';

const REMEDIATION: Readonly<Record<string, string>> = {
  VIEWPORT_UNAVAILABLE: 'Open the desktop app and run with `--app`, or use `render_view renderer=native` (no app needed).',
  VIEWPORT_PENDING: 'The frame is still being drawn: run the command again (the host does this itself under `--app`).',
  VIEWPORT_TIMEOUT: 'The viewport did not answer in time: check the app window is open and not busy, then run again.',
  VIEWPORT_CAPTURE_FAILED: 'Show the 3D view in the app (not the 2D view or a sheet) and run again.',
  VIEWPORT_UNKNOWN_LAYER: 'Use layer ids or names from describe_scene.',
};
const remediationOf = (code: string): string => REMEDIATION[code] ?? 'See the message.';

const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 1000;
const NAME = 'capture_viewport';

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant the user's camera, selection and layer visibility are not touched; hideLayers applies to this frame only
 * @failure no ctx.viewportCapture -> VIEWPORT_UNAVAILABLE; unknown hideLayers entry -> VIEWPORT_UNKNOWN_LAYER; renderer refusals keep the port's code (VIEWPORT_PENDING, VIEWPORT_TIMEOUT, VIEWPORT_CAPTURE_FAILED)
 */
export const captureViewport = defineCommand({
  name: NAME,
  annotations: { readOnly: true },
  description:
    'PNG of what the OPEN DESKTOP APP shows (the real viewport: lighting, materials, instancing), drawn at a camera you choose; ' +
    "the user's camera, selection, layers and the document are not changed and no window needs focus. Use with `--app`: `llull capture_viewport view=iso width=1600 height=1000 --save engine.png --app`. " +
    'Camera: `view` (iso default, top, bottom, front, back, left, right), `direction` ([x,y,z] from the scene toward the camera, overrides view), `target` (point looked at), `zoom` (1 fits the scene). ' +
    '`background` is a CSS colour; `hideLayers` (layer ids or names) leaves layers out of this frame only. Size 64..4096 per side (default 1600x1000). ' +
    'Returns data { image (PNG, base64; written by --save), width, height, view }. Without the app: VIEWPORT_UNAVAILABLE (use `--app`, or `render_view renderer=native`). Other codes: VIEWPORT_TIMEOUT, VIEWPORT_CAPTURE_FAILED, VIEWPORT_UNKNOWN_LAYER.',
  params: z.object({
    view: z.enum(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso']).optional().describe('Named camera direction; default "iso".'),
    direction: vec3('Viewing direction [x, y, z] pointing from the scene toward the camera (Z-up), non-zero; overrides `view`.').optional(),
    target: vec3('World point the camera looks at (default: centre of the visible bounds).').optional(),
    zoom: z.number().min(0.1).max(50).optional().describe('Magnification of the framed scene, 0.1..50 (default 1: the whole scene fits).'),
    width: z.number().int().min(64).max(4096).optional().describe(`Image width in pixels, 64..4096 (default ${DEFAULT_WIDTH}).`),
    height: z.number().int().min(64).max(4096).optional().describe(`Image height in pixels, 64..4096 (default ${DEFAULT_HEIGHT}).`),
    background: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Background CSS colour ("#rrggbb", a name, rgb()); default the viewport\'s own.'),
    hideLayers: z
      .array(z.string())
      .max(256)
      .optional()
      .describe('Layer ids or names left out of this frame only (the document is unchanged).'),
  }),
  run: (doc, params, ctx) => {
    const port = ctx?.viewportCapture ?? null;
    if (port === null)
      return codedRejection(doc, NAME, 'VIEWPORT_UNAVAILABLE', 'no desktop viewport is connected', remediationOf('VIEWPORT_UNAVAILABLE'));
    if (params.direction !== undefined && params.direction.every((component) => component === 0))
      return codedRejection(
        doc,
        NAME,
        'VIEWPORT_BAD_CAMERA',
        'direction must be non-zero',
        'Give a non-zero [x, y, z].',
        [],
        ['direction'],
      );
    const layerIds: string[] = [];
    for (const [index, wanted] of (params.hideLayers ?? []).entries()) {
      const layer = Object.values(doc.layers).find((l) => l.id === wanted || l.name === wanted);
      if (layer === undefined)
        return codedRejection(
          doc,
          NAME,
          'VIEWPORT_UNKNOWN_LAYER',
          `no layer '${wanted}'`,
          remediationOf('VIEWPORT_UNKNOWN_LAYER'),
          [],
          [`hideLayers.${index}`],
        );
      layerIds.push(layer.id);
    }
    const view = params.direction === undefined ? (params.view ?? 'iso') : 'custom';
    const request: ViewportCaptureRequest = {
      view: params.view ?? 'iso',
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
      ...(params.target !== undefined ? { target: params.target } : {}),
      zoom: params.zoom ?? 1,
      width: params.width ?? DEFAULT_WIDTH,
      height: params.height ?? DEFAULT_HEIGHT,
      ...(params.background !== undefined ? { background: params.background } : {}),
      hideLayers: layerIds,
    };
    const outcome = port.capture(request);
    if (!outcome.ok) return codedRejection(doc, NAME, outcome.code, outcome.message, remediationOf(outcome.code));
    return report(doc, `Captured the viewport: ${outcome.width}x${outcome.height} PNG (${outcome.png.length} bytes), view ${view}.`, {
      image: uint8ArrayToBase64(outcome.png),
      width: outcome.width,
      height: outcome.height,
      view,
    });
  },
});
