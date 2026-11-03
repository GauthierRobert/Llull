// An arrow at the flange face of every equipment nozzle, pointing away from the equipment (toward the pipe). Ports come from the
// read-only query `equipment_ports`, recomputed when the document changes (never on selection). Inside the floating-origin group;
// toggled in the equipment data-sheet section (usePortGlyphStore).

import React, { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { MM_PER_UNIT } from '@core/model/units';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { usePortGlyphStore } from '@ui/store/portGlyphStore';
import { runQuery } from '@ui/services/localQuery';
import { useDisposable } from '../../useDisposable';
import { ArrowShape } from '../ArrowShape';
import { arrowQuaternion, glyphLength, parsePortGlyphs, type PortGlyph } from './portGlyphs';

const PORT_COLOR = '#22d3ee';
const RENDER_ORDER = 998;

function PortArrow({ port, mmPerUnit }: { port: PortGlyph; mmPerUnit: number }): React.ReactElement {
  const material = useDisposable(
    () => new THREE.MeshBasicMaterial({ color: PORT_COLOR, transparent: true, opacity: 0.9, depthTest: false }),
    [],
  );
  const length = glyphLength(port.dn, mmPerUnit);
  const quaternion = useMemo(() => new THREE.Quaternion(...arrowQuaternion(port.direction)), [port.direction]);
  return (
    <group name={`port-${port.id}`} position={port.position} quaternion={quaternion}>
      <ArrowShape material={material} length={length} head={length * 0.35} radius={length * 0.035} renderOrder={RENDER_ORDER} />
    </group>
  );
}

export function PortGlyphOverlay(): React.ReactElement | null {
  const document = useDocumentWithoutSelection();
  const shown = usePortGlyphStore((s) => s.shown);
  const invalidate = useThree((state) => state.invalidate);
  const hasEquipment = document.building !== undefined;
  const ports = useMemo(
    () => (shown && hasEquipment ? parsePortGlyphs(runQuery('equipment_ports').data) : []),
    // `document` drives the recomputation: the query reads it from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, hasEquipment, document],
  );
  useEffect(() => invalidate(), [ports, invalidate]);
  if (ports.length === 0) return null;
  const mmPerUnit = MM_PER_UNIT[document.units];
  return (
    <group name="equipment-ports">
      {ports.map((port) => (
        <PortArrow key={port.id} port={port} mmPerUnit={mmPerUnit} />
      ))}
    </group>
  );
}
