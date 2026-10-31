// Ghost of the footprint / knurl preview of the wrap command being edited (03 WRP, spec §14.17): the sketch loops on the face, the holes and the groove lines, drawn from
// the read-only preview query through the footprint store. Not pickable, not in the document.

import React, { useMemo } from 'react';
import { useFootprintPreviewStore } from '@ui/store/footprintPreviewStore';
import { polylineSegments } from '@ui/preview/footprintPreview';
import { Segments } from '../overlays/Segments';

const FOOTPRINT_COLORS = { footprint: '#22d3ee', hole: '#e879f9', knurl: '#f5a524' } as const;

export function FootprintPreviewLayer(): React.ReactElement | null {
  const view = useFootprintPreviewStore((s) => s.view);
  const parts = useMemo(
    () =>
      view === null
        ? null
        : { outlines: polylineSegments(view.outlines, view.kind === 'footprint'), holes: polylineSegments(view.holes, true) },
    [view],
  );
  if (view === null || parts === null) return null;
  return (
    <group name="footprint-preview">
      <Segments positions={parts.outlines} color={view.kind === 'knurl' ? FOOTPRINT_COLORS.knurl : FOOTPRINT_COLORS.footprint} />
      <Segments positions={parts.holes} color={FOOTPRINT_COLORS.hole} />
    </group>
  );
}
