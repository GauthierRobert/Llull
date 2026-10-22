/**
 * The one mass-property resolver (aerospace 01 KRN, TR-KRN-40a), read by `mass_properties` and by dynamics. Order per solid:
 *   1. exact: a 'mesh' entity that keeps its B-rep recipe, or a loft (the kernel skins its sections / ring curves) or a sweep without closed form (fitted faces, pipe), and a kernel with
 *      `massProperties` (OCC); for a 'mesh' entity only, a kernel with just `topology` gives an exact volume with mesh-integrated inertia
 *      scaled to it (`inertiaFromMesh`) — a loft's topology under a mesh kernel is only its display mesh;
 *   2. closed form: box / cylinder / sphere (closed-form inertia too); cone, torus, wedge, pyramid, extrusion, round sweep, revolution
 *      (closed-form VOLUME; inertia and centroid from the world triangles, scaled by closedFormVolume / meshVolume);
 *   3. mesh: the world triangles (loft without an exact kernel, subdivision, non-round sweep, mesh without a kernel shape), integrated in a part frame (TR-KRN-41).
 * Instances combine their baked children (`combineMassProperties`); the method of a combination is its least exact part.
 */

import type { CadDocument, Entity } from '../model/types';
import type { Bounds } from './bounds';
import type { GeometryKernel } from './kernel';
import { expandInstance } from './instanceExpansion';
import { closedFormVolume } from './closedFormVolume';
import { combineMassProperties, meshMassProperties, type InertiaTensor, type MassProperties } from './massProperties';
import { primitiveArea, primitiveMassProperties } from './primitiveMass';
import { solidTriangles } from './solidTriangles';
import { recipeOf } from './shapeRecipe';
import { sweepAnalyticVolume } from './sweepEval/volume';
import type { Triangle } from './triangles';

type MassMethod = 'exact' | 'closed-form' | 'mesh';

/** What the resolver reads from the execution context: only the kernel (`ExecutionContext` satisfies it). */
export interface MassContext {
  readonly kernel?: GeometryKernel | null;
}

export interface ResolvedMass {
  readonly method: MassMethod;
  /** Document units; mass = density x volume, inertia about the centre of mass in world axes, mass-weighted. */
  readonly properties: MassProperties;
  /** Surface area (document units²) when known. */
  readonly area?: number;
  /** World bounds, when the method reports them (exact). */
  readonly bounds?: Bounds;
  /** Relative error estimate of the exact volume integration. */
  readonly relError?: number;
  /** The inertia (not the volume) was integrated from the display mesh although `method` is 'exact'. */
  readonly inertiaFromMesh: boolean;
  /** A 'mesh' entity without a B-rep recipe: a faceted body. */
  readonly facetedBody: boolean;
  /** Set when the volume is a bounding-box approximation (revolution profile crossing its axis). */
  readonly approximation?: string;
}

const RANK: Record<MassMethod, number> = { exact: 0, 'closed-form': 1, mesh: 2 };

function triangleArea(triangles: readonly Triangle[]): number {
  let area = 0;
  for (const [a, b, c] of triangles) {
    const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return area;
}

/** `props` with volume, mass and inertia scaled so that its volume is `volume` (centre of mass unchanged). */
function scaledToVolume(props: MassProperties, volume: number): MassProperties {
  const factor = props.volume > 0 ? volume / props.volume : 0;
  return {
    mass: props.mass * factor,
    volume,
    centerOfMass: props.centerOfMass,
    inertia: props.inertia.map((value) => value * factor) as unknown as InertiaTensor,
  };
}

/** Kinds the exact kernel builds as a B-rep from their own definition (not from the display mesh): integrated by `massProperties` only. */
/** A loft, or a sweep with no closed form (laws, a frame mode, a non-round section): the kernel builds and integrates the B-rep. */
function isExactLeaf(e: Entity): boolean {
  return e.kind === 'loft' || (e.kind === 'sweep' && sweepAnalyticVolume(e) === null);
}

/** Exact B-rep volume of a loft from the kernel's `massProperties` (OCC), or null (other kind, no kernel / port, kernel failure). */
export function exactLeafVolume(e: Entity, kernel: GeometryKernel | null | undefined): number | null {
  if (!isExactLeaf(e) || kernel?.massProperties === undefined) return null;
  const shape = kernel.evaluate(recipeOf(e));
  const volume = shape === null ? 0 : (kernel.massProperties(shape)?.volume ?? 0);
  return volume > 0 ? volume : null;
}

function exactMass(e: Entity, density: number, kernel: GeometryKernel): ResolvedMass | null {
  const brepResult = e.kind === 'mesh' && e.brep !== undefined;
  if (!brepResult && !(isExactLeaf(e) && kernel.massProperties !== undefined)) return null;
  const shape = kernel.evaluate(recipeOf(e));
  if (shape === null) return null;
  const exact = kernel.massProperties?.(shape) ?? null;
  if (exact !== null && exact.volume > 0) {
    return {
      method: 'exact',
      properties: {
        mass: exact.volume * density,
        volume: exact.volume,
        centerOfMass: exact.centroid,
        inertia: exact.inertiaAtCentroid.map((value) => value * density) as unknown as InertiaTensor,
      },
      area: exact.area,
      bounds: exact.bounds,
      ...(exact.relError === undefined ? {} : { relError: exact.relError }),
      inertiaFromMesh: false,
      facetedBody: false,
    };
  }
  if (!brepResult) return null;
  const volume = kernel.topology(shape)?.volume ?? 0;
  const triangles = solidTriangles(e);
  const mesh = volume > 0 ? meshMassProperties(triangles, density) : null;
  if (mesh === null) return null;
  return {
    method: 'exact',
    properties: scaledToVolume(mesh, volume),
    area: triangleArea(triangles),
    inertiaFromMesh: true,
    facetedBody: false,
  };
}

function solidMass(e: Entity, density: number, ctx: MassContext): ResolvedMass | null {
  const kernel = ctx.kernel ?? null;
  const exact = kernel === null ? null : exactMass(e, density, kernel);
  if (exact !== null) return exact;
  const primitive = primitiveMassProperties(e, density);
  if (primitive !== null)
    return { method: 'closed-form', properties: primitive, ...optionalArea(primitiveArea(e)), inertiaFromMesh: false, facetedBody: false };
  const triangles = solidTriangles(e);
  const mesh = meshMassProperties(triangles, density);
  if (mesh === null) return null;
  const closed = closedFormVolume(e);
  const area = primitiveArea(e) ?? triangleArea(triangles);
  if (closed !== null && closed.analytic && closed.approximation === undefined)
    return { method: 'closed-form', properties: scaledToVolume(mesh, closed.volume), area, inertiaFromMesh: true, facetedBody: false };
  return {
    method: 'mesh',
    properties: mesh,
    area,
    inertiaFromMesh: false,
    facetedBody: e.kind === 'mesh' && e.brep === undefined,
    ...(closed?.approximation === undefined ? {} : { approximation: closed.approximation }),
  };
}

const optionalArea = (area: number | null): { area?: number } => (area === null ? {} : { area });

/** Combination of several resolved parts: sums, least exact method. */
function combined(parts: readonly ResolvedMass[]): ResolvedMass | null {
  const properties = combineMassProperties(parts.map((part) => part.properties));
  if (properties === null) return null;
  const method = parts.reduce<MassMethod>((worst, part) => (RANK[part.method] > RANK[worst] ? part.method : worst), 'exact');
  const areas = parts.map((part) => part.area);
  const approximation = parts.find((part) => part.approximation !== undefined)?.approximation;
  return {
    method,
    properties,
    ...(areas.every((area): area is number => area !== undefined) ? { area: areas.reduce((sum, area) => sum + area, 0) } : {}),
    inertiaFromMesh: parts.some((part) => part.inertiaFromMesh),
    facetedBody: parts.some((part) => part.facetedBody),
    ...(approximation === undefined ? {} : { approximation }),
  };
}

/**
 * Mass properties of a 3D entity in its world pose; `densityOf` gives each solid's density (instance children are passed through it, each
 * inheriting the instance's material when it has none). Returns null for 2D shapes, empty meshes, or an instance with a missing component
 * or no mass. Pure; reads the kernel only from `ctx.kernel`.
 * @failure a kernel that cannot integrate the shape -> falls through to the closed form / mesh path
 */
export function resolveMassProperties(
  doc: Pick<CadDocument, 'components'>,
  e: Entity,
  densityOf: (solid: Entity) => number,
  ctx: MassContext,
): ResolvedMass | null {
  if (e.kind !== 'instance') return solidMass(e, densityOf(e), ctx);
  const component = doc.components[e.componentId];
  if (!component) return null;
  const parts: ResolvedMass[] = [];
  for (const baked of expandInstance(e, component)) {
    const child = baked.materialId === undefined && e.materialId !== undefined ? { ...baked, materialId: e.materialId } : baked;
    const part = resolveMassProperties(doc, child, densityOf, ctx);
    if (part !== null) parts.push(part);
  }
  return combined(parts);
}
