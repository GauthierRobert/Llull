// Review overlays of the selected deformed bodies (01 DEF M4, presentation only): the frame, the region slab, the lattice net, the base and target curves of a
// flow, the flow sheets and a reference shape, drawn from `deform_overlay` (a read-only host query, re-run when the entity or the reference changes).

import React, { useMemo } from 'react';
import type { MeshSolidEntity } from '@core/model/types';
import { useStore } from '@ui/store';
import { useDeformOverlayStore } from '@ui/store/deformOverlayStore';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';
import { Segments } from '../analysis/SweepFramesOverlay';
import {
  boxSegments,
  chainSegments,
  chainsSegments,
  frameSegments,
  gridSegments,
  netSegments,
  parseDeformOverlay,
  referenceParams,
  regionSegments,
} from './deformOverlayGeometry';

/** Bodies drawn at once. */
export const MAX_DEFORM_OVERLAYS = 4;
const COLORS = {
  x: '#e5484d',
  y: '#30a46c',
  z: '#3e63dd',
  region: '#f5a524',
  rest: '#8b8d98',
  moved: '#ff8f3c',
  box: '#d6d6d6',
  target: '#30a46c',
  base: '#00b8d9',
  reference: '#c678dd',
} as const;

function DeformedBody({ entity }: { entity: MeshSolidEntity }): React.ReactElement | null {
  const layers = useDeformOverlayStore((s) => s.layers);
  const draft = useDeformOverlayStore((s) => s.reference);
  const compareTo = useMemo(() => (layers.reference ? referenceParams(draft) : null), [layers.reference, draft]);
  const params = useMemo(() => ({ id: entity.id, ...(compareTo === null ? {} : { compareTo }) }), [entity.id, compareTo]);
  const query = useHostQuery('deform_overlay', params, entity);
  const view = useMemo(() => (query.status === 'done' && !query.isError ? parseDeformOverlay(query.data) : null), [query]);
  const parts = useMemo(() => {
    if (view === null) return null;
    return {
      frame: frameSegments(view.frame),
      region: view.region === null ? null : regionSegments(view.region, view.frame),
      rest: view.lattice === null ? null : netSegments(view.lattice.rest, view.lattice.degrees),
      moved: view.lattice === null ? null : netSegments(view.lattice.moved, view.lattice.degrees),
      box: view.lattice === null ? null : boxSegments(view.lattice.box),
      flowTarget: view.flow === null ? null : chainSegments(view.flow.target),
      flowBase: view.flow?.base == null ? null : chainSegments(view.flow.base),
      sheetTarget: view.sheet === null ? null : gridSegments(view.sheet.target, view.sheet.nx, view.sheet.ny),
      sheetBase: view.sheet?.base == null ? null : gridSegments(view.sheet.base, view.sheet.nx, view.sheet.ny),
      reference: view.reference === null ? null : chainsSegments(view.reference),
    };
  }, [view]);
  if (parts === null) return null;
  return (
    <group name={`deform-overlay-${entity.id}`}>
      {layers.frame && (
        <>
          <Segments positions={parts.frame.x} color={COLORS.x} />
          <Segments positions={parts.frame.y} color={COLORS.y} />
          <Segments positions={parts.frame.z} color={COLORS.z} />
        </>
      )}
      {layers.region && parts.region !== null && (
        <>
          <Segments positions={parts.region.slab} color={COLORS.region} />
          <Segments positions={parts.region.axis} color={COLORS.region} />
        </>
      )}
      {layers.lattice && parts.rest !== null && parts.moved !== null && parts.box !== null && (
        <>
          <Segments positions={parts.rest} color={COLORS.rest} />
          <Segments positions={parts.moved} color={COLORS.moved} />
          <Segments positions={parts.box} color={COLORS.box} />
        </>
      )}
      {layers.flow && parts.flowTarget !== null && <Segments positions={parts.flowTarget} color={COLORS.target} />}
      {layers.flow && parts.flowBase !== null && <Segments positions={parts.flowBase} color={COLORS.base} />}
      {layers.sheet && parts.sheetTarget !== null && <Segments positions={parts.sheetTarget} color={COLORS.target} />}
      {layers.sheet && parts.sheetBase !== null && <Segments positions={parts.sheetBase} color={COLORS.base} />}
      {layers.reference && parts.reference !== null && <Segments positions={parts.reference} color={COLORS.reference} />}
    </group>
  );
}

export function DeformOverlay(): React.ReactElement | null {
  const enabled = useDeformOverlayStore((s) => s.enabled);
  const entities = useStore((s) => s.document.entities);
  const selection = useStore((s) => s.document.selection);
  if (!enabled) return null;
  const drawn = selection
    .flatMap((id) => {
      const entity = entities[id];
      return entity?.kind === 'mesh' && entity.brep?.op === 'deform' ? [entity] : [];
    })
    .slice(0, MAX_DEFORM_OVERLAYS);
  return (
    <group name="deform-overlay">
      {drawn.map((entity) => (
        <DeformedBody key={entity.id} entity={entity} />
      ))}
    </group>
  );
}
