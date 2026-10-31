// GPU preview of the selected implicit bodies (05 IMP 14.x, presentation only): the support box of each body is drawn with a sphere-tracing fragment shader
// generated from the body's field (`implicit_gpu_program`, a read-only host query). Hits write their depth, so the preview composites with the real
// geometry. A parameter drag that keeps the shader structure only re-uploads the uniform constants; a field with no GPU path keeps the mesh and says why.

import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import { useStore } from '@ui/store';
import { useImplicitPreviewStore } from '@ui/store/implicitPreviewStore';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';
import { useShallow } from 'zustand/react/shallow';
import { useDisposable } from '../../useDisposable';
import { type GpuAnswer, type GpuProgram, STEP_SAFETY, VERTEX_SHADER, fragmentShader, parseGpuAnswer } from './gpuProgram';

/** Bodies drawn at once. */
export const MAX_GPU_BODIES = 2;
const COLOR = new THREE.Color('#7fb6e8');

/** Is `id` an implicit body (the plugin's slice of the document)? */
function isImplicitBody(doc: CadDocument, id: string): boolean {
  const slice = (doc as { implicit?: { bodies?: Record<string, unknown> } }).implicit;
  return slice?.bodies?.[id] !== undefined;
}

function GpuMesh({ program }: { program: GpuProgram }): React.ReactElement {
  const camera = useThree((s) => s.camera);
  const height = useThree((s) => s.size.height);
  const meshRef = useRef<THREE.Mesh>(null);
  const { min, max } = program.bounds;
  const geometry = useDisposable(() => {
    const box = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    box.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    return box;
  }, [min, max]);
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const material = useDisposable(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: fragmentShader(program.source),
        side: THREE.BackSide,
        uniforms: {
          uC: { value: Array.from({ length: program.constants.length / 4 }, () => new THREE.Vector4()) },
          uBoxMin: { value: new THREE.Vector3(...min) },
          uBoxMax: { value: new THREE.Vector3(...max) },
          uCamLocal: { value: new THREE.Vector3() },
          uClipFromLocal: { value: new THREE.Matrix4() },
          uStepScale: { value: STEP_SAFETY[program.quality] / program.lipschitz },
          uPixel: { value: 0 },
          uMinEps: { value: 1e-5 * diagonal },
          uColor: { value: COLOR },
        },
      }),
    // the shader text (its key) and the box rebuild the material; the constants are uploaded below
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [program.key, program.source, min, max, program.lipschitz, program.quality],
  );
  useEffect(() => {
    const slots = material.uniforms['uC']?.value as THREE.Vector4[];
    slots.forEach((slot, i) => slot.fromArray(program.constants, 4 * i));
  }, [material, program.constants]);

  const inverse = useMemo(() => new THREE.Matrix4(), []);
  useFrame(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    mesh.updateWorldMatrix(true, false);
    inverse.copy(mesh.matrixWorld).invert();
    const u = material.uniforms;
    (u['uCamLocal']?.value as THREE.Vector3).copy(camera.position).applyMatrix4(inverse);
    (u['uClipFromLocal']?.value as THREE.Matrix4)
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(mesh.matrixWorld);
    const pixel = 2 / (camera.projectionMatrix.elements[5] as number) / Math.max(height, 1);
    const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
    (u['uPixel'] as { value: number }).value = ortho ? 0 : pixel;
    (u['uMinEps'] as { value: number }).value = Math.max(1e-5 * diagonal, ortho ? pixel : 0);
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      renderOrder={1}
      frustumCulled={false}
      raycast={() => null}
      name="implicit-gpu-preview"
    />
  );
}

function GpuBody({ entity }: { entity: MeshSolidEntity }): React.ReactElement | null {
  const params = useMemo(() => ({ id: entity.id }), [entity.id]);
  const query = useHostQuery('implicit_gpu_program', params, entity);
  const answered: GpuAnswer | null = useMemo(
    () => (query.status === 'done' && !query.isError ? parseGpuAnswer(query.data) : null),
    [query],
  );
  // the last good program stays drawn while the next answer loads
  const last = useRef<GpuProgram | null>(null);
  if (answered !== null) last.current = answered.gpu ? answered.program : null;
  const setFallback = useImplicitPreviewStore((s) => s.setFallback);
  useEffect(() => {
    if (answered !== null)
      setFallback(entity.id, answered.gpu ? [] : answered.unsupported.length > 0 ? answered.unsupported : ['unsupported']);
  }, [answered, entity.id, setFallback]);
  const program = answered === null && query.status !== 'done' ? last.current : answered?.gpu === true ? answered.program : null;
  if (program === null) return null;
  return (
    <group name={`implicit-gpu-${entity.id}`}>
      <GpuMesh key={program.key} program={program} />
    </group>
  );
}

export function ImplicitGpuPreview(): React.ReactElement | null {
  const enabled = useImplicitPreviewStore((s) => s.enabled);
  const drawn = useStore(
    useShallow((s) =>
      s.document.selection
        .flatMap((id) => {
          const entity = s.document.entities[id];
          return entity?.kind === 'mesh' && isImplicitBody(s.document, id) ? [entity] : [];
        })
        .slice(0, MAX_GPU_BODIES),
    ),
  );
  if (!enabled) return null;
  return (
    <group name="implicit-gpu-preview">
      {drawn.map((entity) => (
        <GpuBody key={entity.id} entity={entity} />
      ))}
    </group>
  );
}
