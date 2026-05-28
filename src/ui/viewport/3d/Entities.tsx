/**
 * @layer ui/viewport/3d
 *
 * Maps `document.order` → a render branch per entity `kind`.
 * Every kind has exactly one branch (OCP / architecture L7).
 * Hidden layers are not rendered; selection state is passed to each branch.
 * Hidden-entity override (render-only, UI store) is also respected here.
 *
 * Click wiring: plain click → select([id]); Shift/Ctrl/Meta click → toggleSelection(id).
 * The `onSelect` callback is threaded from the store down to each mesh via EntityRenderer.
 *
 * ## Instanced rendering (P2)
 * Entities whose kind is batchable (box / cylinder / sphere) are grouped by
 * `groupEntitiesForInstancing` and rendered as InstancedMesh batches via
 * `<InstancedRenderer>`. This collapses N identical-geometry entities into 1
 * draw call per geometry+color group.
 *
 * Non-batchable entities (extrusion, mesh, cone, torus, wedge, pyramid, and all
 * 2D kinds) continue to use per-entity mesh branches (EntityRenderer).
 *
 * Expected draw-call delta: 100 identical boxes → 100 draw calls (before) vs
 * 1 draw call (after). Mixed scenes with N distinct groups → N draw calls.
 */

import { useCallback, useMemo } from 'react';
import type { CadDocument, Entity, EntityId, InstanceEntity, Material } from '@core/model/types';
import { useStore } from '@ui/store';
import { useViewportStore } from '@ui/store';
import { findClickAnimationsForEntity } from './animationClickHelpers';
import { BoxMesh } from './entities/BoxMesh';
import { CylinderMesh } from './entities/CylinderMesh';
import { SphereMesh } from './entities/SphereMesh';
import { ExtrusionMesh } from './entities/ExtrusionMesh';
import { MeshSolidMesh } from './entities/MeshSolidMesh';
import { ConeMesh } from './entities/ConeMesh';
import { TorusMesh } from './entities/TorusMesh';
import { WedgeMesh } from './entities/WedgeMesh';
import { PyramidMesh } from './entities/PyramidMesh';
import { RevolutionMesh } from './entities/RevolutionMesh';
import { TextMesh } from './entities/TextMesh';
import { isBatchable, groupEntitiesForInstancing } from './grouping';
import { InstancedRenderer } from './InstancedRenderer';
import { expandInstance } from '@core/commands/assemblies';

interface EntitiesProps {
  document: CadDocument;
}

// ---------------------------------------------------------------------------
// InstanceEntityRenderer — renders one InstanceEntity as its expanded children
// ---------------------------------------------------------------------------

/**
 * Renders a single InstanceEntity by expanding it into world-space entities via
 * `expandInstance` and delegating to the same per-kind EntityRenderer branches.
 *
 * All sub-mesh clicks are intercepted and re-routed to the INSTANCE id so that
 * selection always targets the instance as a unit (not its expanded children).
 *
 * The expanded entity list is memoized on (componentId, position, rotation, scale)
 * so it is only recomputed when the instance transform or component changes (R9 / R7).
 *
 * @layer ui/viewport/3d
 * @pure of props — given the same instance + components, produces the same tree.
 */
function InstanceEntityRenderer({
  instance,
  document,
  selected,
  onSelect,
}: {
  instance: InstanceEntity;
  document: CadDocument;
  selected: boolean;
  onSelect: (id: EntityId, additive: boolean) => void;
}): React.ReactElement | null {
  const component = document.components[instance.componentId];

  // Route all sub-entity clicks to the instance id so the gizmo and selection
  // operate on the instance as a unit. Must be declared before any early return
  // to satisfy the Rules of Hooks (react-hooks/rules-of-hooks).
  const handleSubSelect = useCallback(
    (_childId: EntityId, additive: boolean): void => {
      onSelect(instance.id, additive);
    },
    [instance.id, onSelect],
  );

  // Expand the instance into world-space entities, memoized on the instance
  // transform fields + componentId.
  // Use a stable string key for position/rotation/scale since array references
  // are not stable across renders.
  const posKey = instance.position.join(',');
  const rotKey = instance.rotation.join(',');
  const scaleKey = (instance.scale ?? [1, 1, 1]).join(',');
  const expandedEntities = useMemo(() => {
    if (!component) return [];
    return expandInstance(instance, component);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component, instance.componentId, posKey, rotKey, scaleKey]);

  if (!component || expandedEntities.length === 0) return null;

  return (
    <group name={`instance-${instance.id}`}>
      {expandedEntities.map((entity) => (
        <EntityRenderer
          key={entity.id}
          entity={entity}
          selected={selected}
          onSelect={handleSubSelect}
        />
      ))}
    </group>
  );
}

/** PBR material override passed to entity mesh components (VNF4). */
interface PbrMaterial {
  color: string;
  metalness: number;
  roughness: number;
}

/**
 * Render a single entity; one pure branch per `kind`.
 * Used only for NON-batchable kinds — batchable kinds (box/cylinder/sphere)
 * are rendered by InstancedRenderer.
 *
 * The `document` prop is required only for the `instance` branch; other branches
 * ignore it. Passing it here keeps the signature uniform and avoids a separate
 * component-level store read inside each branch.
 */
function EntityRenderer({
  entity,
  selected,
  onSelect,
  pbrMaterial,
  document,
}: {
  entity: Entity;
  selected: boolean;
  onSelect: (id: EntityId, additive: boolean) => void;
  pbrMaterial?: PbrMaterial;
  document?: CadDocument;
}): React.ReactElement | null {
  const pbr = pbrMaterial ? { pbrMaterial } : {};
  switch (entity.kind) {
    case 'box':
      return <BoxMesh entity={entity} selected={selected} onSelect={onSelect} {...pbr} />;
    case 'cylinder':
      return <CylinderMesh entity={entity} selected={selected} onSelect={onSelect} {...pbr} />;
    case 'sphere':
      return <SphereMesh entity={entity} selected={selected} onSelect={onSelect} {...pbr} />;
    case 'extrusion':
      return <ExtrusionMesh entity={entity} selected={selected} onSelect={onSelect} {...pbr} />;
    case 'mesh':
      return <MeshSolidMesh entity={entity} selected={selected} onSelect={onSelect} {...pbr} />;
    case 'cone':
      return <ConeMesh entity={entity} selected={selected} onSelect={onSelect} {...pbr} />;
    case 'torus':
      return <TorusMesh entity={entity} selected={selected} onSelect={onSelect} {...pbr} />;
    case 'wedge':
      return <WedgeMesh entity={entity} selected={selected} onSelect={onSelect} {...pbr} />;
    case 'pyramid':
      return <PyramidMesh entity={entity} selected={selected} onSelect={onSelect} {...pbr} />;
    case 'revolution':
      return <RevolutionMesh entity={entity} selected={selected} onSelect={onSelect} {...pbr} />;
    case 'text':
      return <TextMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'instance':
      // `document` is required for the instance branch — it is always passed from Entities.
      if (!document) return null;
      return (
        <InstanceEntityRenderer
          instance={entity}
          document={document}
          selected={selected}
          onSelect={onSelect}
        />
      );
    default:
      // 2D shape kinds (line/arc/circle/…) are drawn by the 2D viewport (Lane 3 / D1),
      // not in the 3D scene. Keeping a tolerant default lets the Entity union grow
      // without breaking this branch (architecture L7).
      return null;
  }
}

export function Entities({ document }: EntitiesProps): React.ReactElement {
  const { order, entities, layers, selection, materials } = document;
  const selectionSet = useMemo(() => new Set<EntityId>(selection), [selection]);

  const select = useStore((s) => s.select);
  const toggleSelection = useStore((s) => s.toggleSelection);

  // Render-only visibility overrides — never touch the document (PRIME DIRECTIVE).
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const toggleClickAnimation = useViewportStore((s) => s.toggleClickAnimation);

  /**
   * Called by each mesh on click.
   * Plain click → single-select; Shift/Ctrl/Meta click → toggle (multi-select).
   * Also toggles any `trigger:'click'` animations that target this entity (directly
   * or via a group whose memberIds include it) — without removing select behaviour.
   */
  const handleSelect = useCallback(
    (id: EntityId, additive: boolean): void => {
      // 1. Normal selection behaviour.
      if (additive) {
        toggleSelection(id);
      } else {
        select([id]);
      }

      // 2. Toggle any click-triggered animations for this entity.
      const animations = useStore.getState().document.animations;
      const groups = useStore.getState().document.groups;
      const clickAnimIds = findClickAnimationsForEntity(id, animations, groups);
      for (const animId of clickAnimIds) {
        toggleClickAnimation(animId);
      }
    },
    [select, toggleSelection, toggleClickAnimation],
  );

  // --- Compute visible entity list (applies all visibility filters) ---
  const visibleEntities = useMemo(() => {
    return order
      .map((id) => entities[id])
      .filter((entity): entity is Entity => {
        if (!entity) return false;
        const layer = layers[entity.layerId];
        if (layer && !layer.visible) return false;
        if (hiddenLayerIds.has(entity.layerId)) return false;
        if (hiddenEntityIds.has(entity.id)) return false;
        return true;
      });
  }, [order, entities, layers, hiddenLayerIds, hiddenEntityIds]);

  // --- Split: batchable kinds (box/cylinder/sphere) go to InstancedRenderer ---
  const batchableEntities = useMemo(
    () => visibleEntities.filter(isBatchable),
    [visibleEntities],
  );

  // --- Non-batchable kinds continue as per-entity meshes ---
  const nonBatchableEntities = useMemo(
    () => visibleEntities.filter((e) => !isBatchable(e)),
    [visibleEntities],
  );

  // --- Group batchable entities into InstancedMesh batches ---
  // Pass the materials map so batches can carry per-batch PBR overrides (VNF4).
  const batches = useMemo(
    () => groupEntitiesForInstancing(batchableEntities, materials),
    [batchableEntities, materials],
  );

  return (
    <group name="entities">
      {/* Instanced rendering: box / cylinder / sphere — one draw call per batch */}
      <InstancedRenderer
        batches={batches}
        selectionSet={selectionSet}
        onSelect={handleSelect}
      />

      {/* Per-entity rendering: non-batchable kinds (extrusion, mesh, cone, torus, wedge, pyramid, instance) */}
      {nonBatchableEntities.map((entity) => {
        const mat: Material | undefined = entity.materialId ? materials[entity.materialId] : undefined;
        const pbrProp = mat
          ? { pbrMaterial: { color: mat.color, metalness: mat.metalness, roughness: mat.roughness } }
          : {};
        return (
          <EntityRenderer
            key={entity.id}
            entity={entity}
            selected={selectionSet.has(entity.id)}
            onSelect={handleSelect}
            document={document}
            {...pbrProp}
          />
        );
      })}
    </group>
  );
}
