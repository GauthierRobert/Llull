// Review overlays of the wrap results of the selected solids (03 WRP, presentation only): the curves lying on faces and the edges coloured by convexity,
// drawn from `wrap_overlay` (a read-only host query, re-run when the solid or the document changes).

import React, { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { is3D, type Entity } from '@core/model/types';
import { useStore } from '@ui/store';
import { useWrapOverlayStore } from '@ui/store/wrapOverlayStore';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';
import { Segments } from './Segments';
import { curveSegments, edgeSegments, parseWrapOverlay } from './wrapOverlayGeometry';

/** Solids drawn at once. */
export const MAX_WRAP_OVERLAYS = 4;
export const WRAP_COLORS = {
  curve: '#ff8f3c',
  earlier: '#ffd43b',
  smooth: '#30a46c',
  convex: '#f5a524',
  concave: '#3e63dd',
  unknown: '#8b8d98',
} as const;

function WrapSolid({ entity }: { entity: Entity }): React.ReactElement | null {
  const layers = useWrapOverlayStore((s) => s.layers);
  const params = useMemo(() => ({ id: entity.id }), [entity.id]);
  // the answer depends on the solid, the curves lying on faces and the history (which solids it was made from), not on the rest of the document
  const inputs = useStore(
    useShallow((s) => [
      s.document.entities[entity.id],
      s.document.featureHistory,
      ...Object.values(s.document.entities).filter((other) => other.kind === 'nurbs_curve' && other.onFace !== undefined),
    ]),
  );
  const query = useHostQuery('wrap_overlay', params, inputs);
  const view = useMemo(() => (query.status === 'done' && !query.isError ? parseWrapOverlay(query.data) : null), [query]);
  const setStatus = useWrapOverlayStore((s) => s.setStatus);
  const lines = useMemo(
    () =>
      query.status === 'done' && query.isError
        ? [`${entity.id}: the overlay could not be read (${query.summary})`]
        : (view?.notes ?? []).map((note) => `${entity.id}: ${note}`),
    [query, view, entity.id],
  );
  useEffect(() => {
    setStatus(entity.id, lines);
    return () => setStatus(entity.id, []);
  }, [entity.id, lines, setStatus]);
  const parts = useMemo(
    () =>
      view === null
        ? null
        : {
            curve: curveSegments(view, 'solid'),
            earlier: curveSegments(view, 'earlier'),
            smooth: edgeSegments(view, 'smooth'),
            convex: edgeSegments(view, 'convex'),
            concave: edgeSegments(view, 'concave'),
            unknown: edgeSegments(view, 'unknown'),
          },
    [view],
  );
  if (parts === null) return null;
  return (
    <group name={`wrap-overlay-${entity.id}`}>
      {layers.curves && (
        <>
          <Segments positions={parts.curve} color={WRAP_COLORS.curve} />
          <Segments positions={parts.earlier} color={WRAP_COLORS.earlier} />
        </>
      )}
      {layers.edges && (
        <>
          <Segments positions={parts.smooth} color={WRAP_COLORS.smooth} />
          <Segments positions={parts.convex} color={WRAP_COLORS.convex} />
          <Segments positions={parts.concave} color={WRAP_COLORS.concave} />
          <Segments positions={parts.unknown} color={WRAP_COLORS.unknown} />
        </>
      )}
    </group>
  );
}

export function WrapOverlay(): React.ReactElement | null {
  const enabled = useWrapOverlayStore((s) => s.enabled);
  const drawn = useStore(
    useShallow((s) =>
      s.document.selection
        .flatMap((id) => {
          const entity = s.document.entities[id];
          return entity !== undefined && is3D(entity) && entity.kind !== 'instance' ? [entity] : [];
        })
        .slice(0, MAX_WRAP_OVERLAYS),
    ),
  );
  if (!enabled) return null;
  return (
    <group name="wrap-overlay">
      {drawn.map((entity) => (
        <WrapSolid key={entity.id} entity={entity} />
      ))}
    </group>
  );
}
