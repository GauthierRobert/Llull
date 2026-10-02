/**
 * @layer server
 *
 * tools/list augmentation: advertise the server-side render_view enrichment params.
 */

import type { McpToolDefinition } from '@core/mcp';

/** Augment the core render_view tool definition with the server-side enrichment params. */
export function augmentRenderViewTool(t: McpToolDefinition): {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] };
} {
  // Augment the core render_view schema with server-side enrichment params.
  // The core schema already has: view, width, height.
  // We add: turntable, isolate, showDimensions, section.
  const augmented = {
    ...t.inputSchema,
    properties: {
      ...(t.inputSchema.properties ?? {}),
      turntable: {
        type: 'object',
        description:
          'Produce a horizontal strip of N evenly-spaced rotation frames around the Z (up) axis. ' +
          'frames: integer 1..12. When omitted, behavior is unchanged (single frame).',
        properties: {
          frames: {
            type: 'number',
            description:
              'Number of frames (1..12). Each frame is a separate rotated view stitched into one wide PNG strip.',
          },
        },
        required: ['frames'],
      },
      isolate: {
        type: 'string',
        description:
          'Entity id (or JSON array of ids) to highlight. All other entities are rendered ' +
          'dimmed/desaturated; the specified id(s) are shown at full color. ' +
          'Pass a single id string or a JSON-encoded array of id strings.',
      },
      showDimensions: {
        type: 'boolean',
        description:
          'When true, overlay the bounding-box dimensions (W × D × H) as text labels on the image. ' +
          'Labels are placed near the bounding box edges in screen space.',
      },
      section: {
        type: 'object',
        description:
          'Render a section-plane view: entities on the negative side of the cut plane are dimmed; ' +
          'a colored dashed line marks the cut. axis: "x"|"y"|"z"; offset: world-space position of the plane.',
        properties: {
          axis: {
            type: 'string',
            description: 'Axis normal to the cut plane: "x", "y", or "z".',
          },
          offset: {
            type: 'number',
            description: 'World-space position of the cut plane along the axis.',
          },
        },
        required: ['axis', 'offset'],
      },
      showAxes: {
        type: 'boolean',
        description:
          'When true (default), overlay a world-frame X/Y/Z axis triad anchored at the world origin. ' +
          'X=red, Y=green, Z=blue. A scale label (e.g. "1 mm = 42 px") is also shown. ' +
          'Set to false to suppress.',
      },
      showGrid: {
        type: 'boolean',
        description:
          'When true (default), overlay a faint ground grid on the Z=0 plane so you can judge ' +
          'object placement relative to the world origin. Set to false to suppress.',
      },
      showLabels: {
        type: 'boolean',
        description:
          'When true, overlay per-entity id/name labels and key-point markers on the image. ' +
          'Each entity shows its name (or id) at the centroid of its key points (endpoints, center, ' +
          'corners, AABB corners for solids). Markers are color-coded by category: ' +
          'orange=point, cyan=2D curve, purple=3D solid, yellow=annotation. ' +
          'A legend appears in the top-right corner. Default: false (opt in to avoid clutter).',
      },
    },
  };
  return {
    name: t.name,
    description:
      t.description +
      ' [Server enrichments available: turntable (multi-frame strip), isolate (highlight entity), ' +
      'showDimensions (bbox labels), section (cut-plane view), showAxes (world triad, default on), ' +
      'showGrid (ground grid, default on), showLabels (entity id/name labels + key-point markers, default off).]',
    inputSchema: augmented as {
      type: 'object';
      properties?: Record<string, object>;
      required?: string[];
    },
  };
}
