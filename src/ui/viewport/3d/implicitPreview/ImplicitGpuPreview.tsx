// GPU preview of the selected implicit bodies (05 IMP 14.x, presentation only): the support box of each body is drawn with a sphere-tracing fragment shader
// generated from the body's field (`implicit_gpu_program`, a read-only host query). Hits write their depth, so the preview composites with the real
// geometry, and the mesh of a body the GPU draws is not drawn. A parameter drag that keeps the shader structure only re-uploads the uniform constants; a
// field with no GPU path, a driver that cannot hold the shader, or a shader that fails to compile keeps the mesh and says why.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import { useStore } from '@ui/store';
import { useImplicitPreviewStore } from '@ui/store/implicitPreviewStore';
import { useHostQuery } from '@ui/panels/analysis/useHostQuery';
import { useShallow } from 'zustand/react/shallow';
import { useDisposable } from '../../useDisposable';
import {
  type GpuAnswer,
  type GpuProgram,
  MAX_CLIP_PLANES,
  stepScaleOf,
  VERTEX_SHADER,
  WRAPPER_UNIFORM_VECTORS,
  fragmentShader,
  parseGpuAnswer,
} from './gpuProgram';
import { watchShaderFailure } from './shaderErrors';

/** Bodies drawn at once. */
export const MAX_GPU_BODIES = 2;
const COLOR = new THREE.Color('#7fb6e8');

/** Is `id` an implicit body (the plugin's slice of the document)? */
function isImplicitBody(doc: CadDocument, id: string): boolean {
  const slice = (doc as { implicit?: { bodies?: Record<string, unknown> } }).implicit;
  return slice?.bodies?.[id] !== undefined;
}

/** What the renderer cannot do for this program: names for the fallback note (none when it is fine). */
function rendererLimits(gl: THREE.WebGLRenderer | undefined, program: GpuProgram): string[] {
  if (gl?.capabilities === undefined) return [];
  const blocked: string[] = [];
  if (gl.capabilities.logarithmicDepthBuffer) blocked.push('log_depth_buffer');
  const available = Number(gl.getContext().getParameter(gl.getContext().MAX_FRAGMENT_UNIFORM_VECTORS));
  if (Number.isFinite(available) && program.constants.length / 4 + WRAPPER_UNIFORM_VECTORS + MAX_CLIP_PLANES > available)
    blocked.push('too_many_uniforms');
  return blocked;
}

function GpuMesh({ program, onFailed }: { program: GpuProgram; onFailed: () => void }): React.ReactElement {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);
  const meshRef = useRef<THREE.Mesh>(null);
  const minKey = program.bounds.min.join(',');
  const maxKey = program.bounds.max.join(',');
  const diagonal = Math.hypot(...program.bounds.max.map((v, i) => v - (program.bounds.min[i] as number)));
  const geometry = useDisposable(() => {
    const [lo, hi] = [minKey.split(',').map(Number), maxKey.split(',').map(Number)] as [number[], number[]];
    const box = new THREE.BoxGeometry(
      (hi[0] as number) - (lo[0] as number),
      (hi[1] as number) - (lo[1] as number),
      (hi[2] as number) - (lo[2] as number),
    );
    box.translate(
      ((lo[0] as number) + (hi[0] as number)) / 2,
      ((lo[1] as number) + (hi[1] as number)) / 2,
      ((lo[2] as number) + (hi[2] as number)) / 2,
    );
    return box;
  }, [minKey, maxKey]);
  const material = useDisposable(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: fragmentShader(program.source, program.key),
        side: THREE.BackSide,
        uniforms: {
          uC: { value: Array.from({ length: program.constants.length / 4 }, () => new THREE.Vector4()) },
          uBoxMin: { value: new THREE.Vector3(...program.bounds.min) },
          uBoxMax: { value: new THREE.Vector3(...program.bounds.max) },
          uCamLocal: { value: new THREE.Vector3() },
          uDirLocal: { value: new THREE.Vector3() },
          uOrtho: { value: 0 },
          uDiagonal: { value: diagonal },
          uClipFromLocal: { value: new THREE.Matrix4() },
          uStepScale: { value: stepScaleOf(program) },
          uMaxStep: { value: Number.isFinite(program.maxStep) ? program.maxStep : 1e30 },
          uPixel: { value: 0 },
          uMinEps: { value: 1e-5 * diagonal },
          uColor: { value: COLOR },
          uClip: { value: Array.from({ length: MAX_CLIP_PLANES }, () => new THREE.Vector4()) },
          uClipCount: { value: 0 },
        },
      }),
    // the shader text (its key) and the box rebuild the material; the constants and the step policy are uploaded below
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [program.key, program.source, minKey, maxKey],
  );
  useEffect(() => watchShaderFailure(gl?.debug, program.key, onFailed), [gl, program.key, onFailed]);
  useEffect(() => {
    const slots = material.uniforms['uC']?.value as THREE.Vector4[];
    slots.forEach((slot, i) => slot.fromArray(program.constants, 4 * i));
    (material.uniforms['uStepScale'] as { value: number }).value = stepScaleOf(program);
    (material.uniforms['uMaxStep'] as { value: number }).value = Number.isFinite(program.maxStep) ? program.maxStep : 1e30;
    invalidate();
  }, [material, program.constants, program.lipschitz, program.quality, program.maxStep, invalidate]);

  const inverse = useMemo(() => new THREE.Matrix4(), []);
  const direction = useMemo(() => new THREE.Vector3(), []);
  const plane = useMemo(() => new THREE.Plane(), []);
  useFrame(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    mesh.updateWorldMatrix(true, false);
    inverse.copy(mesh.matrixWorld).invert();
    const u = material.uniforms;
    (u['uCamLocal']?.value as THREE.Vector3).copy(camera.position).applyMatrix4(inverse);
    (u['uDirLocal']?.value as THREE.Vector3).copy(camera.getWorldDirection(direction).transformDirection(inverse));
    (u['uClipFromLocal']?.value as THREE.Matrix4)
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(mesh.matrixWorld);
    const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
    const pixel = 2 / (camera.projectionMatrix.elements[5] as number) / Math.max(height, 1);
    (u['uOrtho'] as { value: number }).value = ortho ? 1 : 0;
    (u['uPixel'] as { value: number }).value = ortho ? 0 : pixel;
    (u['uMinEps'] as { value: number }).value = Math.max(1e-5 * diagonal, ortho ? pixel : 0);
    // the section planes of the viewport (render space) in the local space of the box: the preview is cut like the real geometry
    const planes = (gl?.clippingPlanes ?? []).slice(0, MAX_CLIP_PLANES);
    const slots = u['uClip']?.value as THREE.Vector4[];
    planes.forEach((world, i) => {
      plane.copy(world).applyMatrix4(inverse);
      slots[i]?.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    });
    (u['uClipCount'] as { value: number }).value = planes.length;
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
  const gl = useThree((s) => s.gl);
  const params = useMemo(() => ({ id: entity.id }), [entity.id]);
  const query = useHostQuery('implicit_gpu_program', params, entity);
  const answered: GpuAnswer | null = useMemo(
    () => (query.status === 'done' && !query.isError ? parseGpuAnswer(query.data) : null),
    [query],
  );
  // the last good program stays drawn while the next answer loads
  const last = useRef<GpuProgram | null>(null);
  if (answered !== null) last.current = answered.gpu ? answered.program : null;
  const program = answered === null && query.status !== 'done' ? last.current : answered?.gpu === true ? answered.program : null;
  const limits = useMemo(() => (program === null ? [] : rendererLimits(gl, program)), [gl, program]);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const failed = program !== null && failedKey === program.key;
  const { setFallback, setDrawn, clearBody } = useImplicitPreviewStore.getState();
  useEffect(() => {
    if (answered === null) return;
    if (!answered.gpu) setFallback(entity.id, answered.unsupported.length > 0 ? answered.unsupported : ['unsupported']);
    else if (limits.length > 0) setFallback(entity.id, limits);
    else setFallback(entity.id, failed ? ['shader_compile_failed'] : []);
  }, [answered, entity.id, limits, failed, setFallback]);
  const drawing = program !== null && limits.length === 0 && !failed;
  useEffect(() => {
    setDrawn(entity.id, drawing);
  }, [drawing, entity.id, setDrawn]);
  useEffect(() => () => clearBody(entity.id), [entity.id, clearBody]);
  const programKey = program?.key ?? null;
  const onFailed = useMemo(() => () => setFailedKey(programKey), [programKey]);
  if (program === null || !drawing) return null;
  return (
    <group name={`implicit-gpu-${entity.id}`}>
      <GpuMesh key={program.key} program={program} onFailed={onFailed} />
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
