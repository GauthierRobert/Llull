// Paints the building pipes of the reviewed stress model by their worst code-stress ratio (green below 0.8, amber to 1, red above 1), over the
// load case chosen in the pipe stress panel. Data: the read-only `analyze_pipe_stress`, recomputed when the document changes (never on
// selection) and shared with the panel. Inside the floating-origin group. Runs (02 RTE) are not drawn: their centreline derives inside the
// plugin and no read-only query exposes it yet.

import React, { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { usePipeStressStore } from '@ui/store/pipeStressStore';
import { useDisposable } from '../../useDisposable';
import { paintedPipes, type PaintedPipe } from './paintedPipes';
import { stressOutcome } from './stressQuery';
import { TONE_COLOR, type RatioTone } from './stressView';

const RENDER_ORDER = 997;

function toneMaterial(tone: RatioTone): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: TONE_COLOR[tone], transparent: true, opacity: 0.85, depthTest: false });
}

export function PipeStressOverlay(): React.ReactElement | null {
  const document = useDocumentWithoutSelection();
  const modelId = usePipeStressStore((s) => s.modelId);
  const caseName = usePipeStressStore((s) => s.caseName);
  const shown = usePipeStressStore((s) => s.shown);
  const invalidate = useThree((state) => state.invalidate);
  const pass = useDisposable(() => toneMaterial('pass'), []);
  const warn = useDisposable(() => toneMaterial('warn'), []);
  const fail = useDisposable(() => toneMaterial('fail'), []);
  const materials: Record<RatioTone, THREE.Material> = { pass, warn, fail, unknown: warn };
  const painted = useMemo((): PaintedPipe[] => {
    if (!shown || modelId === null) return [];
    return paintedPipes(document, stressOutcome(document, modelId), caseName);
  }, [shown, modelId, caseName, document]);
  useEffect(() => invalidate(), [painted, invalidate]);
  if (painted.length === 0) return null;
  return (
    <group name="pipe-stress">
      {painted.map((pipe) => (
        <group key={pipe.pipeId} name={`pipe-stress-${pipe.pipeId}`} userData={{ tone: pipe.tone }}>
          {pipe.segments.map((segment, i) => (
            <mesh
              key={i}
              material={materials[pipe.tone]}
              position={segment.center}
              quaternion={segment.quaternion}
              renderOrder={RENDER_ORDER}
            >
              <cylinderGeometry args={[pipe.radius, pipe.radius, segment.length, 12]} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}
