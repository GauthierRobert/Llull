// Jacobian colour map of a deformed body (01 DEF M4, presentation only): the vertices of `deform_jacobian_map` drawn as a vertex-coloured mesh on the body
// (neutral = volume kept, red = stretched, blue = compressed, magenta = folded). Queried only while the layer is on; the summary goes to the control.

import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { MeshSolidEntity } from '@core/model/types';
import { useDeformOverlayStore } from '@ui/store/deformOverlayStore';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';
import { useDisposable } from '../../useDisposable';
import { parseJacobianMap } from './jacobianColors';

const RENDER_ORDER = 996;
const OPACITY = 0.88;

export function JacobianMap({ entity }: { entity: MeshSolidEntity }): React.ReactElement | null {
  const setStats = useDeformOverlayStore((s) => s.setJacobian);
  const params = useMemo(() => ({ id: entity.id }), [entity.id]);
  const query = useHostQuery('deform_jacobian_map', params, entity);
  const view = useMemo(() => (query.status === 'done' && !query.isError ? parseJacobianMap(query.data) : null), [query]);
  const failure = query.status === 'done' && view === null ? query.summary : null;
  useEffect(() => {
    setStats(entity.id, view === null ? (failure === null ? null : { failure }) : { min: view.min, max: view.max, folded: view.folded });
    return () => setStats(entity.id, null);
  }, [entity.id, view, failure, setStats]);
  const geometry = useDisposable(() => {
    const built = new THREE.BufferGeometry();
    if (view === null) return built;
    built.setAttribute('position', new THREE.BufferAttribute(view.positions, 3));
    built.setAttribute('color', new THREE.BufferAttribute(view.colors, 3));
    built.setIndex(new THREE.BufferAttribute(view.indices, 1));
    return built;
  }, [view]);
  const material = useDisposable(
    () =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: OPACITY,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    [],
  );
  if (view === null) return null;
  return (
    <mesh name={`jacobian-map-${entity.id}`} geometry={geometry} material={material} renderOrder={RENDER_ORDER} frustumCulled={false} />
  );
}
