// In-Canvas control polygon / net and poles of the selected NURBS curve or surface (VC-37), inside the floating-origin group. The buffers are
// re-based on the first pole (float32 stays small); the dragged pole's dry-run entity is drawn while a drag is in flight. Input: useNetPointer.

import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useNurbsNetStore } from '@ui/store/nurbsNetStore';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { useDisposable } from '../../useDisposable';
import { useFloatGeometry } from '../cage/useFloatGeometry';
import { NET_COLORS } from './netPalette';
import { isNurbsNetEntity, netAnchor, netSegments, poleBuffer, selectedPoleBuffer } from './controlNet';
import { useNetPointer } from './useNetPointer';

const POLE_PX = 7;

function Segments({ positions, color }: { positions: Float32Array; color: string }): React.ReactElement | null {
  const geometry = useFloatGeometry(positions);
  const material = useDisposable(() => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 }), [color]);
  return positions.length === 0 ? null : (
    <lineSegments geometry={geometry} material={material} renderOrder={20} frustumCulled={false} raycast={() => null} />
  );
}

function Dots({ positions, color, size }: { positions: Float32Array; color: string; size: number }): React.ReactElement | null {
  const geometry = useFloatGeometry(positions);
  const material = useDisposable(
    () => new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, transparent: true }),
    [color, size],
  );
  return positions.length === 0 ? null : (
    <points geometry={geometry} material={material} renderOrder={22} frustumCulled={false} raycast={() => null} />
  );
}

export function NurbsNetLayer(): React.ReactElement | null {
  const visible = useNurbsNetStore((s) => s.visible);
  const hover = useNurbsNetStore((s) => s.hover);
  const drag = useNurbsNetStore((s) => s.drag);
  const selected = useNurbsNetStore((s) => s.selected);
  const sole = useSoleSelectedEntity();
  const invalidate = useThree((s) => s.invalidate);
  const target = visible && isNurbsNetEntity(sole) ? sole : undefined;
  useNetPointer(target);
  // the selected poles belong to one entity: another entity (or the net turned off) starts with none
  useEffect(() => {
    useNurbsNetStore.getState().setSelected([]);
  }, [target?.id]);
  useEffect(() => invalidate(), [hover, drag, selected, target, invalidate]);

  const shown = drag !== null && drag.entityId === target?.id && drag.preview !== null ? drag.preview : target;
  const buffers = useMemo(() => {
    if (shown === undefined) return null;
    const anchor = netAnchor(shown);
    return { anchor, lines: netSegments(shown, anchor), poles: poleBuffer(shown, anchor) };
  }, [shown]);
  const marked = useMemo(() => {
    if (shown === undefined || buffers === null) return null;
    const grabbed = drag?.pole ?? hover;
    return grabbed === null ? null : poleBuffer(shown, buffers.anchor, grabbed);
  }, [shown, buffers, drag?.pole, hover]);

  const chosen = useMemo(
    () => (shown === undefined || buffers === null ? null : selectedPoleBuffer(shown, buffers.anchor, selected)),
    [shown, buffers, selected],
  );

  if (target === undefined || buffers === null) return null;
  const { position, rotation } = target;
  return (
    <group name="nurbs-net" position={position} rotation={[rotation[0], rotation[1], rotation[2]]}>
      <group position={buffers.anchor}>
        <Segments positions={buffers.lines} color={NET_COLORS.net} />
        <Dots positions={buffers.poles} color={NET_COLORS.pole} size={POLE_PX} />
        {chosen !== null && <Dots positions={chosen} color={NET_COLORS.selected} size={POLE_PX + 4} />}
        {marked !== null && <Dots positions={marked} color={drag === null ? NET_COLORS.hover : NET_COLORS.drag} size={POLE_PX + 5} />}
      </group>
    </group>
  );
}
