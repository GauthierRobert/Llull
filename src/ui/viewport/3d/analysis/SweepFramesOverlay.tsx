// "Show frames" overlay (02 SWG, presentation only): for each selected sweep, the T/N/B frames and section outlines at the stations of
// `inspect_sweep` (a read-only host query, re-run when the entity changes); for a selected loft, its section rings. Drawn over the model.

import React, { useMemo } from 'react';
import type { LoftEntity, SweepEntity } from '@core/model/types';
import { loftSectionRings } from '@core/geometry/loft';
import { useStore } from '@ui/store';
import { useSurfaceOverlayStore } from '@ui/store/surfaceOverlayStore';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';
import { Segments } from '../overlays/Segments';
import { MAX_FRAME_ENTITIES, closedLoopSegments, frameSegments, parseFrameStations } from './sweepFramesGeometry';

const STATIONS = 13;
const AXIS_COLORS = { tangent: '#e5484d', normal: '#30a46c', binormal: '#3e63dd' } as const;
const OUTLINE_COLOR = '#f5a524';

function SweepFrames({ sweep }: { sweep: SweepEntity }): React.ReactElement | null {
  const params = useMemo(() => ({ id: sweep.id, samples: STATIONS, outline: true }), [sweep.id]);
  const query = useHostQuery('inspect_sweep', params, sweep);
  const segments = useMemo(() => {
    if (query.status !== 'done' || query.isError) return null;
    const stations = parseFrameStations(query.data);
    return stations === null ? null : frameSegments(stations);
  }, [query]);
  if (segments === null) return null;
  return (
    <group name={`sweep-frames-${sweep.id}`} position={sweep.position} rotation={[sweep.rotation[0], sweep.rotation[1], sweep.rotation[2]]}>
      <Segments positions={segments.outlines} color={OUTLINE_COLOR} />
      <Segments positions={segments.tangent} color={AXIS_COLORS.tangent} />
      <Segments positions={segments.normal} color={AXIS_COLORS.normal} />
      <Segments positions={segments.binormal} color={AXIS_COLORS.binormal} />
    </group>
  );
}

function LoftSections({ loft }: { loft: LoftEntity }): React.ReactElement {
  const positions = useMemo(() => closedLoopSegments(loftSectionRings(loft)), [loft]);
  return (
    <group name={`loft-sections-${loft.id}`} position={loft.position} rotation={[loft.rotation[0], loft.rotation[1], loft.rotation[2]]}>
      <Segments positions={positions} color={OUTLINE_COLOR} />
    </group>
  );
}

export function SweepFramesOverlay(): React.ReactElement | null {
  const enabled = useSurfaceOverlayStore((s) => s.frames);
  const entities = useStore((s) => s.document.entities);
  const selection = useStore((s) => s.document.selection);
  if (!enabled) return null;
  const drawn = selection
    .flatMap((id) => {
      const entity = entities[id];
      return entity?.kind === 'sweep' || entity?.kind === 'loft' ? [entity] : [];
    })
    .slice(0, MAX_FRAME_ENTITIES);
  return (
    <group name="sweep-frames-overlay">
      {drawn.map((entity) =>
        entity.kind === 'sweep' ? <SweepFrames key={entity.id} sweep={entity} /> : <LoftSections key={entity.id} loft={entity} />,
      )}
    </group>
  );
}
