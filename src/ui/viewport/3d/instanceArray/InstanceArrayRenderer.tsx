// `doc.instanceArrays` in the viewport (RV-M4, G16): each array is drawn as InstancedMeshes per (child solid of its component x LOD tier),
// straight from the packed transform table. The camera decides, in typed-array passes (`arrayVisibility`), which members are in the frustum
// and which tier each takes (real mesh / decimated / box / culled under one pixel), so a 4,000,000-member array costs a handful of draw
// calls and only the visible members' matrices. Members are not entities: a click reports `instanceMemberId(arrayId, index)`.

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { instanceLocalCorners } from '@core/geometry/bounds';
import { solidTriangles } from '@core/geometry/solidTriangles';
import { decodedTransforms } from '@core/geometry/instanceArrays';
import type { InstanceArray } from '@core/model/instanceArray';
import { type CadDocument, type Entity, is3D } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { useDisposable } from '../../useDisposable';
import { buildTriangleSoupGeometry } from '../entities/meshSolidGeometry';
import { makeMaterialArgs } from '../InstancedRenderer';
import { buildBoxGeometry, buildCoarseGeometry } from '../componentBatch/componentLodGeometry';
import { usePlantCameraView } from '../plant/PlantCameraProvider';
import { motionCamera, planCameraOf } from '../plant/plantPlanCamera';
import type { PlanCamera } from '@core/geometry/renderPlanCamera';
import { ArrayTierMesh } from './ArrayTierMesh';
import { assignMemberTiers, groupTiers, memberShape } from './arrayVisibility';

interface ChildGeometry {
  readonly full: THREE.BufferGeometry;
  readonly coarse: THREE.BufferGeometry | undefined;
  readonly box: THREE.BufferGeometry;
}

/** The three tier geometries of every plain 3D solid child of a component (2D shapes and nested instances are not drawn by arrays). */
class ChildGeometries {
  readonly children: readonly ChildGeometry[];
  constructor(solids: readonly Entity[]) {
    this.children = solids.map((child) => {
      const full = buildTriangleSoupGeometry(solidTriangles(child)) ?? new THREE.BufferGeometry();
      return { full, coarse: buildCoarseGeometry(child), box: buildBoxGeometry(full) };
    });
  }
  get hasCoarse(): boolean {
    return this.children.some((child) => child.coarse !== undefined);
  }
  dispose(): void {
    for (const { full, coarse, box } of this.children) for (const geometry of [full, coarse, box]) geometry?.dispose();
  }
}

interface ArrayDrawProps {
  array: InstanceArray;
  document: CadDocument;
  camera: PlanCamera | null;
  onPickMember: (memberId: string, additive: boolean) => void;
}

function ArrayDraw({ array, document, camera, onPickMember }: ArrayDrawProps): React.ReactElement | null {
  const displayMode = useViewportStore((s) => s.displayMode);
  const table = useMemo(() => decodedTransforms(array), [array]);
  const { components } = document;
  const solids = useMemo(() => {
    const component = components[array.componentId];
    const children = (component?.order ?? []).map((id) => component?.entities[id]);
    return children.filter((child): child is Entity => child !== undefined && is3D(child) && child.kind !== 'instance');
  }, [components, array.componentId]);
  const geometries = useDisposable(() => new ChildGeometries(solids), [solids]);
  const shape = useMemo(
    () => memberShape(instanceLocalCorners(document, array.componentId), array.scale),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the component bag is the only slice the corners read
    [components, array.componentId, array.scale],
  );
  const { materials } = document;
  // One surface per child, as render_realistic resolves a member: the child's material, else the array's, else the array colour.
  const surfaces = useDisposable(() => {
    const list = solids.map((child) => {
      const material = materials[child.materialId ?? array.materialId ?? ''];
      return new THREE.MeshStandardMaterial({ ...makeMaterialArgs(displayMode, material), color: material?.color ?? array.color });
    });
    return { list, dispose: () => list.forEach((surface) => surface.dispose()) };
  }, [displayMode, materials, solids, array.materialId, array.color]);
  const held = useRef<Uint8Array | undefined>(undefined);
  const grouped = useMemo(() => {
    if (table === null || shape === null) return null;
    const tiers =
      camera === null
        ? new Uint8Array(array.count)
        : assignMemberTiers(table, array.count, shape, camera, { hasCoarse: geometries.hasCoarse, held: held.current });
    held.current = tiers;
    return groupTiers(tiers);
  }, [table, shape, camera, array.count, geometries]);
  const dropped = grouped?.dropped ?? 0;
  useEffect(() => {
    if (dropped > 0) console.warn(`[viewport] instance array ${array.id}: ${dropped} visible members over the drawn cap are not drawn`);
  }, [dropped, array.id]);
  if (table === null || shape === null || grouped === null) return null;
  return (
    <group name={`instance-array-${array.id}`}>
      {geometries.children.map((child, childIndex) =>
        ([0, 1, 2] as const).map((tier) => (
          <ArrayTierMesh
            key={`${childIndex}|${tier}`}
            arrayId={array.id}
            tier={tier}
            geometry={tier === 0 ? child.full : tier === 1 ? (child.coarse ?? child.full) : child.box}
            material={surfaces.list[childIndex] as THREE.Material}
            table={table}
            members={grouped.members[tier]}
            scale={array.scale}
            radius={shape.radius}
            onPickMember={onPickMember}
          />
        )),
      )}
    </group>
  );
}

interface InstanceArrayRendererProps {
  /** The visible arrays (`visibleInstanceArrays`). */
  arrays: readonly InstanceArray[];
  document: CadDocument;
  onPickMember: (memberId: string, additive: boolean) => void;
}

export function InstanceArrayRenderer({ arrays, document, onPickMember }: InstanceArrayRendererProps): React.ReactElement | null {
  const view = usePlantCameraView(arrays.length > 0);
  // Document-space plan camera; the widened frustum while the camera moves keeps nothing from blinking out at the edges.
  const camera = useMemo(() => {
    if (view === null) return null;
    const base = planCameraOf(view.camera, useStore.getState().renderOrigin, view.width, view.height);
    return base === null ? null : view.moving ? motionCamera(base) : base;
  }, [view]);
  if (arrays.length === 0) return null;
  return (
    <group name="instance-arrays">
      {arrays.map((array) => (
        <ArrayDraw key={array.id} array={array} document={document} camera={camera} onPickMember={onPickMember} />
      ))}
    </group>
  );
}
