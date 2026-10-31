// Review overlay of the blends of the selected solids (06 BLD M5, presentation only): the contact lines, junctions, corner patches and chamfer legs that
// `check_blends` measured, drawn from `blend_overlay` (a read-only host query, re-run when the solid changes) and coloured by their status.

import React, { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { is3D, type Entity } from '@core/model/types';
import { useStore } from '@ui/store';
import { useBlendOverlayStore } from '@ui/store/blendOverlayStore';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';
import { Segments } from './Segments';
import { OVERLAY_STATUSES, junctionMarkers, lineSegments, parseBlendOverlay, statusLine } from './blendOverlayGeometry';

/** Solids drawn at once. */
export const MAX_BLEND_OVERLAYS = 4;
export const BLEND_STATUS_COLORS = { pass: '#30a46c', warn: '#f5a524', fail: '#e5484d', not_run: '#8b8d98' } as const;
/** Outline of a corner patch that passes: its profile, an exact star or the plate patch of the fallback. */
export const CORNER_COLORS = { star: '#8e4ec6', patch: '#12a594' } as const;

function BlendSolid({ entity }: { entity: Entity }): React.ReactElement | null {
  const layers = useBlendOverlayStore((s) => s.layers);
  const params = useMemo(() => ({ id: entity.id }), [entity.id]);
  // the readings depend on the solid (its recipe), not on the rest of the document
  const solid = useStore((s) => s.document.entities[entity.id]);
  const query = useHostQuery('blend_overlay', params, solid);
  const view = useMemo(() => (query.status === 'done' && !query.isError ? parseBlendOverlay(query.data) : null), [query]);
  const setStatus = useBlendOverlayStore((s) => s.setStatus);
  const line = useMemo(
    () =>
      query.status !== 'done'
        ? null
        : view === null
          ? `${entity.id}: the blends could not be read (${query.summary})`
          : statusLine(entity.id, view),
    [query, view, entity.id],
  );
  useEffect(() => {
    setStatus(entity.id, line === null ? [] : [line]);
    return () => setStatus(entity.id, []);
  }, [entity.id, line, setStatus]);
  const parts = useMemo(
    () =>
      view === null
        ? null
        : OVERLAY_STATUSES.map((status) => ({
            status,
            contact: lineSegments(view, 'contact', status),
            junction: lineSegments(view, 'junction', status),
            marker: junctionMarkers(view, status),
            chamfer: lineSegments(view, 'chamfer', status),
            star: lineSegments(view, 'corner', status, 'star'),
            patch: lineSegments(view, 'corner', status, 'patch'),
          })),
    [view],
  );
  if (parts === null) return null;
  return (
    <group name={`blend-overlay-${entity.id}`}>
      {parts.map((part) => {
        const color = BLEND_STATUS_COLORS[part.status];
        // a corner outline that passes shows its profile; a warning or failure shows the status
        const star = part.status === 'pass' ? CORNER_COLORS.star : color;
        const patch = part.status === 'pass' ? CORNER_COLORS.patch : color;
        return (
          <React.Fragment key={part.status}>
            {layers.contacts && <Segments positions={part.contact} color={color} />}
            {layers.junctions && (
              <>
                <Segments positions={part.junction} color={color} />
                <Segments positions={part.marker} color={color} />
              </>
            )}
            {layers.corners && (
              <>
                <Segments positions={part.star} color={star} />
                <Segments positions={part.patch} color={patch} />
              </>
            )}
            {layers.chamfers && <Segments positions={part.chamfer} color={color} />}
          </React.Fragment>
        );
      })}
    </group>
  );
}

export function BlendOverlay(): React.ReactElement | null {
  const enabled = useBlendOverlayStore((s) => s.enabled);
  const drawn = useStore(
    useShallow((s) =>
      s.document.selection
        .flatMap((id) => {
          const entity = s.document.entities[id];
          return entity !== undefined && is3D(entity) && entity.kind !== 'instance' ? [entity] : [];
        })
        .slice(0, MAX_BLEND_OVERLAYS),
    ),
  );
  if (!enabled) return null;
  return (
    <group name="blend-overlay">
      {drawn.map((entity) => (
        <BlendSolid key={entity.id} entity={entity} />
      ))}
    </group>
  );
}
