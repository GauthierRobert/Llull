// Pure data-to-geometry mapping of the wrap overlays: the `wrap_overlay` answer (world coordinates) as flat xyz arrays of line-segment pairs.
// Presentation only: every point comes from the command, nothing is derived from the document here.

import type { Vec3 } from '@core/model/types';
import type { WrapOverlayCurve, WrapOverlayEdge } from '@core/commands/wrap/wrapOverlay';
import { chainsSegments } from './deformOverlayGeometry';

export type EdgeConvexity = WrapOverlayEdge['convexity'];

export interface WrapOverlayView {
  readonly curves: ReadonlyArray<Pick<WrapOverlayCurve, 'id' | 'face' | 'source' | 'points'>>;
  readonly edges: ReadonlyArray<WrapOverlayEdge> | null;
  /** What the query says about itself: why the edges are missing, what was left out. */
  readonly notes: readonly string[];
}

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
const isPoints = (value: unknown): value is Vec3[] => Array.isArray(value) && value.every(isVec3);
const CONVEXITIES: readonly string[] = ['smooth', 'convex', 'concave', 'unknown'];

/** The view of a `wrap_overlay` answer; null when the data is not that shape (an entry that is damaged is left out). */
export function parseWrapOverlay(data: unknown): WrapOverlayView | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d['curves'])) return null;
  const curves = (d['curves'] as unknown[]).flatMap((entry) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    return typeof c['id'] === 'string' &&
      typeof c['face'] === 'number' &&
      (c['source'] === 'solid' || c['source'] === 'earlier') &&
      isPoints(c['points'])
      ? [{ id: c['id'], face: c['face'], source: c['source'] as 'solid' | 'earlier', points: c['points'] }]
      : [];
  });
  const edges = Array.isArray(d['edges'])
    ? (d['edges'] as unknown[]).flatMap((entry) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        return typeof e['edge'] === 'number' &&
          Array.isArray(e['faces']) &&
          typeof e['convexity'] === 'string' &&
          CONVEXITIES.includes(e['convexity']) &&
          isPoints(e['points'])
          ? [{ edge: e['edge'], faces: e['faces'] as number[], convexity: e['convexity'] as EdgeConvexity, points: e['points'] }]
          : [];
      })
    : null;
  const truncated = (d['truncated'] ?? {}) as Record<string, unknown>;
  const notes = [
    ...(typeof d['edgesNote'] === 'string' ? [`edges not drawn: ${d['edgesNote']}`] : []),
    ...(typeof truncated['curves'] === 'number' && truncated['curves'] > 0
      ? [`${truncated['curves']} curve(s) left out (only the first 64 are drawn)`]
      : []),
    ...(typeof truncated['edges'] === 'number' && truncated['edges'] > 0
      ? [`${truncated['edges']} edge(s) left out (only the first 400 are drawn)`]
      : []),
  ];
  return { curves, edges, notes };
}

/** The curves of one origin as line segments. */
export function curveSegments(view: WrapOverlayView, source: 'solid' | 'earlier'): Float32Array {
  return chainsSegments(view.curves.filter((c) => c.source === source).map((c) => c.points));
}

/** The edges of one convexity as line segments (empty when the kernel gave none). */
export function edgeSegments(view: WrapOverlayView, convexity: EdgeConvexity): Float32Array {
  return chainsSegments((view.edges ?? []).filter((e) => e.convexity === convexity).map((e) => e.points));
}
