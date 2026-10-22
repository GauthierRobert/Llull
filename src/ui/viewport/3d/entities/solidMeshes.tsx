// One render branch per SolidKind (L7); each memoizes its geometry, SolidMeshShell owns lifecycle (R9).
// Loft/sweep/subdivision draw the core tessellation (shared with export + kernels) with creased normals.

import { useMemo } from 'react';
import * as THREE from 'three';
import type { BaseEntity, Entity, SolidKind } from '@core/model/types';
import type { Triangle } from '@core/geometry/triangles';
import { loftTriangles } from '@core/geometry/loft';
import { sweepTriangles } from '@core/geometry/sweep';
import { subdivisionTriangles } from '@core/geometry/subdivision';
import { SolidMeshShell, type SolidMeshKindProps, type SolidSurface } from './SolidMeshShell';
import { buildFaceColoredGeometry, buildMeshSolidGeometry, buildTriangleSoupGeometry } from './meshSolidGeometry';
import { pointsKey, useStableByKey } from '../../useStableByKey';
import {
  buildConeGeometry,
  buildCylinderGeometry,
  buildPyramidGeometry,
  buildRevolutionGeometry,
  buildSphereGeometry,
  buildTorusGeometry,
  buildWedgeGeometry,
} from './primitiveGeometry';

type Props<K extends SolidKind> = SolidMeshKindProps<Extract<Entity, { kind: K }>>;
export type SolidMeshBranch<E extends Entity> = (props: SolidMeshKindProps<E>) => React.ReactElement | null;

const surface = (roughness: number, metalness: number, envMapIntensity: number): SolidSurface => ({
  roughness,
  metalness,
  envMapIntensity,
});

/** `triangles` must be referentially stable between renders. */
function TriangleSoupMesh<E extends BaseEntity>({
  triangles,
  ...shell
}: SolidMeshKindProps<E> & { triangles: readonly Triangle[]; surface: SolidSurface }): React.ReactElement | null {
  const geometry = useMemo(() => buildTriangleSoupGeometry(triangles), [triangles]);
  return geometry === null ? null : <SolidMeshShell geometry={geometry} {...shell} />;
}

function BoxMesh({ entity, ...shell }: Props<'box'>): React.ReactElement {
  const [sx, sy, sz] = entity.size;
  const geometry = useMemo(() => new THREE.BoxGeometry(sx, sy, sz), [sx, sy, sz]);
  return <SolidMeshShell entity={entity} geometry={geometry} {...shell} />;
}

function CylinderMesh({ entity, ...shell }: Props<'cylinder'>): React.ReactElement {
  const { radius, height } = entity;
  const geometry = useMemo(() => buildCylinderGeometry(radius, height), [radius, height]);
  return <SolidMeshShell entity={entity} geometry={geometry} {...shell} />;
}

function ConeMesh({ entity, ...shell }: Props<'cone'>): React.ReactElement {
  const { radius, height } = entity;
  const geometry = useMemo(() => buildConeGeometry(radius, height), [radius, height]);
  return <SolidMeshShell entity={entity} geometry={geometry} {...shell} />;
}

function SphereMesh({ entity, ...shell }: Props<'sphere'>): React.ReactElement {
  const { radius } = entity;
  const geometry = useMemo(() => buildSphereGeometry(radius), [radius]);
  return <SolidMeshShell entity={entity} geometry={geometry} surface={surface(0.35, 0.12, 1.0)} {...shell} />;
}

function TorusMesh({ entity, ...shell }: Props<'torus'>): React.ReactElement {
  const { ringRadius, tubeRadius } = entity;
  const geometry = useMemo(() => buildTorusGeometry(ringRadius, tubeRadius), [ringRadius, tubeRadius]);
  return <SolidMeshShell entity={entity} geometry={geometry} surface={surface(0.4, 0.1, 0.9)} {...shell} />;
}

function WedgeMesh({ entity, ...shell }: Props<'wedge'>): React.ReactElement {
  const [w, h, d] = entity.size;
  const geometry = useMemo(() => buildWedgeGeometry(w, h, d), [w, h, d]);
  return <SolidMeshShell entity={entity} geometry={geometry} surface={surface(0.5, 0.08, 0.8)} {...shell} />;
}

function PyramidMesh({ entity, ...shell }: Props<'pyramid'>): React.ReactElement {
  const { baseWidth, baseDepth, height } = entity;
  const geometry = useMemo(() => buildPyramidGeometry(baseWidth, baseDepth, height), [baseWidth, baseDepth, height]);
  return <SolidMeshShell entity={entity} geometry={geometry} {...shell} />;
}

function ExtrusionMesh({ entity, ...shell }: Props<'extrusion'>): React.ReactElement {
  const { depth } = entity;
  const profile = useStableByKey(entity.profile, pointsKey(entity.profile));
  const geometry = useMemo(() => {
    const [first, ...rest] = profile;
    if (!first) return new THREE.BufferGeometry();
    const shape = new THREE.Shape();
    shape.moveTo(first[0], first[1]);
    for (const pt of rest) shape.lineTo(pt[0], pt[1]);
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  }, [profile, depth]);
  return <SolidMeshShell entity={entity} geometry={geometry} {...shell} />;
}

/** Boolean results hold world-space meshes (position/rotation zero), still honored so the gizmo can move them. */
function MeshSolidMesh({ entity, ...shell }: Props<'mesh'>): React.ReactElement {
  const { mesh, faceColors } = entity;
  const baseColor = shell.pbrMaterial?.color ?? entity.color;
  const geometry = useMemo(
    () =>
      faceColors === undefined || faceColors.length === 0
        ? buildMeshSolidGeometry(mesh)
        : buildFaceColoredGeometry(mesh, faceColors, baseColor),
    [mesh, faceColors, baseColor],
  );
  const vertexColors = faceColors !== undefined && faceColors.length > 0;
  return <SolidMeshShell entity={entity} geometry={geometry} surface={surface(0.5, 0.15, 0.8)} vertexColors={vertexColors} {...shell} />;
}

function RevolutionSolid({ entity, ...shell }: Props<'revolution'>): React.ReactElement {
  const { angle, segments } = entity;
  const profile = useStableByKey(entity.profile, pointsKey(entity.profile));
  const axis = useStableByKey(entity.axis, pointsKey([entity.axis]));
  const geometry = useMemo(() => buildRevolutionGeometry(profile, axis, angle, segments), [profile, axis, angle, segments]);
  return <SolidMeshShell entity={entity} geometry={geometry} doubleSided boundsTree={false} {...shell} />;
}

function RevolutionMesh(props: Props<'revolution'>): React.ReactElement | null {
  return props.entity.profile.length < 3 ? null : <RevolutionSolid {...props} />;
}

function SweepMesh({ entity, ...shell }: Props<'sweep'>): React.ReactElement {
  const { path, section, stations } = entity;
  const triangles = useMemo(
    () => sweepTriangles(stations === undefined ? { path, section } : { path, section, stations }),
    [path, section, stations],
  );
  return <TriangleSoupMesh entity={entity} triangles={triangles} surface={surface(0.4, 0.3, 0.9)} {...shell} />;
}

function LoftMesh({ entity, ...shell }: Props<'loft'>): React.ReactElement {
  const { rings, ruled } = entity;
  const triangles = useMemo(() => loftTriangles({ rings, ruled }), [rings, ruled]);
  return <TriangleSoupMesh entity={entity} triangles={triangles} surface={surface(0.4, 0.2, 0.9)} {...shell} />;
}

function SubdivisionMesh({ entity, ...shell }: Props<'subdivision'>): React.ReactElement {
  const { vertices, faces, creases, levels, edgeSharpness, vertexSharpness, creaseMethod } = entity;
  const triangles = useMemo(
    () => subdivisionTriangles({ vertices, faces, creases, levels, edgeSharpness, vertexSharpness, creaseMethod }),
    [vertices, faces, creases, levels, edgeSharpness, vertexSharpness, creaseMethod],
  );
  return <TriangleSoupMesh entity={entity} triangles={triangles} surface={surface(0.45, 0.1, 0.9)} {...shell} />;
}

export const SOLID_MESHES: { [K in SolidKind]: SolidMeshBranch<Extract<Entity, { kind: K }>> } = {
  box: BoxMesh,
  cylinder: CylinderMesh,
  sphere: SphereMesh,
  extrusion: ExtrusionMesh,
  mesh: MeshSolidMesh,
  cone: ConeMesh,
  torus: TorusMesh,
  wedge: WedgeMesh,
  pyramid: PyramidMesh,
  revolution: RevolutionMesh,
  sweep: SweepMesh,
  loft: LoftMesh,
  subdivision: SubdivisionMesh,
};
