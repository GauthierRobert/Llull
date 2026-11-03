// Geometry per prototype key x LOD for the plant batch renderer: LOD0 the real entity-local geometry (same builders as the per-entity
// branches), LOD1 a coarse tessellation within the plan's triangle caps (cylinder 32, cone 24, sphere 112, torus 128; other kinds
// keep LOD0), LOD2 one shared unit box (instances are scaled onto each prototype's local box). Disposed on prototype removal / unmount.

import * as THREE from 'three';
import type { Entity } from '@core/model/types';
import { buildMeshSolidGeometry } from '../entities/meshSolidGeometry';
import {
  buildConeGeometry,
  buildCylinderGeometry,
  buildPyramidGeometry,
  buildRevolutionGeometry,
  buildSphereGeometry,
  buildTorusGeometry,
  buildWedgeGeometry,
} from '../entities/primitiveGeometry';
import type { LocalBox } from './plantMatrices';

export type PlantLod = 0 | 1 | 2;

/** Segment count of the LOD1 curved kinds: 8 gives 32 / 24 / 112 / 128 triangles for cylinder / cone / sphere / torus (the plan's caps). */
const LOD1_SEGMENTS = 8;

function buildLod0(entity: Entity): THREE.BufferGeometry {
  switch (entity.kind) {
    case 'box':
      return new THREE.BoxGeometry(...entity.size);
    case 'cylinder':
      return buildCylinderGeometry(entity.radius, entity.height);
    case 'cone':
      return buildConeGeometry(entity.radius, entity.height);
    case 'sphere':
      return buildSphereGeometry(entity.radius);
    case 'torus':
      return buildTorusGeometry(entity.ringRadius, entity.tubeRadius);
    case 'wedge':
      return buildWedgeGeometry(...entity.size);
    case 'pyramid':
      return buildPyramidGeometry(entity.baseWidth, entity.baseDepth, entity.height);
    case 'revolution':
      return buildRevolutionGeometry(entity.profile, entity.axis, entity.angle, entity.segments);
    case 'mesh':
      return buildMeshSolidGeometry(entity.mesh);
    default:
      return new THREE.BufferGeometry();
  }
}

/** Coarse tessellation of the curved kinds, in the same local frame as the LOD0 builders; undefined for kinds without one. */
function buildLod1(entity: Entity): THREE.BufferGeometry | undefined {
  switch (entity.kind) {
    case 'cylinder': {
      const geometry = new THREE.CylinderGeometry(entity.radius, entity.radius, entity.height, LOD1_SEGMENTS);
      return geometry.rotateX(Math.PI / 2);
    }
    case 'cone': {
      const geometry = new THREE.ConeGeometry(entity.radius, entity.height, LOD1_SEGMENTS);
      return geometry.rotateX(Math.PI / 2).translate(0, 0, entity.height / 2);
    }
    case 'sphere':
      return new THREE.SphereGeometry(entity.radius, LOD1_SEGMENTS, LOD1_SEGMENTS).rotateX(Math.PI / 2);
    case 'torus':
      return new THREE.TorusGeometry(entity.ringRadius, entity.tubeRadius, LOD1_SEGMENTS, LOD1_SEGMENTS);
    default:
      return undefined;
  }
}

/**
 * @invariant a geometry is built once per (prototype key, LOD) until `retain` drops its prototype or `dispose` runs; `dispose` empties the
 *   cache, which stays usable (geometries are rebuilt on demand)
 */
export class LodGeometryCache {
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly boxes = new Map<string, LocalBox>();
  private unitBox: THREE.BoxGeometry | undefined;

  /** Geometry of `prototypeKey` at `lod`; `entity` (any instance of the prototype) is read only on a miss. */
  geometry(prototypeKey: string, lod: PlantLod, entity: Entity): THREE.BufferGeometry {
    if (lod === 2) return (this.unitBox ??= new THREE.BoxGeometry(1, 1, 1));
    const key = `${prototypeKey}#${lod}`;
    let geometry = this.geometries.get(key);
    if (geometry === undefined) {
      geometry = (lod === 1 ? buildLod1(entity) : undefined) ?? (lod === 1 ? this.geometry(prototypeKey, 0, entity) : buildLod0(entity));
      if (lod === 0) this.rememberBox(prototypeKey, geometry);
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  /** Local bounding box of the prototype (the LOD2 box); builds LOD0 when it has not been needed yet. */
  localBox(prototypeKey: string, entity: Entity): LocalBox {
    let box = this.boxes.get(prototypeKey);
    if (box === undefined) {
      this.geometry(prototypeKey, 0, entity);
      box = this.boxes.get(prototypeKey) ?? { min: [0, 0, 0], max: [0, 0, 0] };
    }
    return box;
  }

  /** Disposes the geometries of every prototype not in `liveKeys` (a prototype whose last instance left the scene). */
  retain(liveKeys: ReadonlySet<string>): void {
    for (const [key, geometry] of this.geometries) {
      const prototypeKey = key.slice(0, key.lastIndexOf('#'));
      if (liveKeys.has(prototypeKey)) continue;
      // LOD1 of a kind without a coarse build aliases LOD0: dispose once.
      geometry.dispose();
      this.geometries.delete(key);
    }
    for (const key of this.boxes.keys()) if (!liveKeys.has(key)) this.boxes.delete(key);
  }

  get size(): number {
    return this.geometries.size;
  }

  dispose(): void {
    for (const geometry of new Set(this.geometries.values())) geometry.dispose();
    this.geometries.clear();
    this.boxes.clear();
    this.unitBox?.dispose();
    this.unitBox = undefined;
  }

  private rememberBox(prototypeKey: string, geometry: THREE.BufferGeometry): void {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box !== null) this.boxes.set(prototypeKey, { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] });
  }
}
