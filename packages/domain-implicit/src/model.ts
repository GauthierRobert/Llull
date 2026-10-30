/**
 * Document slice of the implicit plugin (05 IMP §3): a DAG of field nodes (design intent only: radii, cell sizes, entity references; never samples)
 * and the implicit bodies derived from it. A body's id is the id of its derived (read-only) mesh entity.
 * @invariant a node refers only to nodes created before it (ids `fld-<step>.<k>`), so the graph is acyclic by construction
 */

import type { MeshAssetRef } from '@core/model/meshProvenance';
import type { CadDocument, Vec3 } from '@core/model/types';

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    implicit?: ImplicitModel;
  }
}

export type PrimitiveShape = 'sphere' | 'box' | 'cylinder' | 'capsule' | 'torus' | 'cone' | 'plane';
export type TpmsKind = 'gyroid' | 'schwarz_p' | 'diamond' | 'neovius' | 'iwp' | 'lidinoid' | 'fischer_koch_s' | 'split_p';
export type StrutCell = 'cubic' | 'bcc' | 'fcc' | 'octet' | 'kelvin' | 'diamond' | 'bccz' | 'fccz' | 'reentrant';
/** A number, or the id of a scalar field node (graded law: evaluated at every point). */
export type Law = number | string;
type BlendKind = 'quadratic' | 'exponential' | 'chamfer';

interface Blend {
  readonly kind: BlendKind;
  readonly radius: Law;
}

interface NodeBase {
  readonly id: string;
  readonly name?: string;
}

export interface PrimitiveNode extends NodeBase {
  readonly op: 'primitive';
  readonly shape: PrimitiveShape;
  /** Shape dimensions by name (radius, size, height, ringRadius, tubeRadius, normal, offset). */
  readonly dims: Readonly<Record<string, number | Vec3>>;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly rounding?: number;
}

export interface SolidNode extends NodeBase {
  readonly op: 'solid';
  readonly entityId: string;
}

export interface BooleanNode extends NodeBase {
  readonly op: 'boolean';
  readonly kind: 'union' | 'intersect' | 'subtract';
  readonly operands: readonly string[];
  readonly blend?: Blend;
}

interface OffsetNode extends NodeBase {
  readonly op: 'offset';
  readonly source: string;
  readonly distance: Law;
}

interface ShellNode extends NodeBase {
  readonly op: 'shell';
  readonly source: string;
  readonly thickness: Law;
  readonly side: 'inside' | 'outside' | 'centred';
}

interface TransformNode extends NodeBase {
  readonly op: 'transform';
  readonly source: string;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: number;
}

/** Resolved control of a TPMS: sheet half-width `thickness` (mm when normalised, raw F units otherwise) or network `level` (F units). */
export type TpmsControl = { readonly kind: 'thickness'; readonly value: Law } | { readonly kind: 'level'; readonly value: Law };

/** Cells wrapped about an axis: `cellsAround` whole cells per turn (integer, else the seam jumps), axial cell size = cellSize[2], radial cell size `radialCellSize`. */
interface CylindricalMap {
  readonly kind: 'cylindrical';
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly cellsAround: number;
  readonly radialCellSize: number;
}

/** Cells on spheres: `cellsAround` whole cells per turn of longitude, `cellsPolar` per half turn of colatitude, radial cell size `radialCellSize`. The poles are singular cells (IMP_MAP_POLE). */
interface SphericalMap {
  readonly kind: 'spherical';
  readonly origin: Vec3;
  readonly cellsAround: number;
  readonly cellsPolar: number;
  readonly radialCellSize: number;
}

/** Cells along a `nurbs_surface` sheet: `cellsU` x `cellsV` cells over its (u, v) patch, `layers` cells of size `depth` along its normal (signed distance / depth is the third coordinate). */
export interface SurfaceUvMap {
  readonly kind: 'surface_uv';
  readonly sheetId: string;
  readonly cellsU: number;
  readonly cellsV: number;
  readonly depth: number;
  readonly layers: number;
}

export type CellMap = CylindricalMap | SphericalMap | SurfaceUvMap;

export interface TpmsNode extends NodeBase {
  readonly op: 'tpms';
  readonly kind: TpmsKind;
  readonly cellSize: Vec3;
  readonly origin: Vec3;
  readonly rotation: Vec3;
  readonly form: 'sheet' | 'network';
  readonly control: TpmsControl;
  /** Target the control was solved from (stored next to the resolved value, 5.4). */
  readonly relativeDensityTarget?: number;
  readonly normalize: 'gradient' | 'none';
  /** When set, replaces origin / rotation: cells follow the cylinder. */
  readonly map?: CellMap;
  readonly region?: string;
}

export interface StrutsNode extends NodeBase {
  readonly op: 'struts';
  readonly cell: StrutCell;
  readonly cellSize: Vec3;
  readonly origin: Vec3;
  readonly rotation: Vec3;
  readonly radius: Law;
  readonly nodeRadius?: number;
  /** When set, replaces origin / rotation: the periodic cell is mapped onto the cells of the map (a mapped field is approximate, not a distance). */
  readonly map?: CellMap;
  readonly region?: string;
}

/** Beams between the nodes of sketched curves (lines, polylines, arcs, NURBS curves sampled every `chord`), referenced by id, never copied. */
export interface GraphNode extends NodeBase {
  readonly op: 'graph';
  readonly sourceIds: readonly string[];
  readonly radiusStart: number;
  readonly radiusEnd: number;
  readonly cap: 'sphere' | 'butt';
  readonly chord: number;
  readonly mergeTolerance: number;
  readonly region?: string;
}

/** Beams along the edges of the Voronoi diagram of a seeded point set filling the box [min, max] (re-derived from the seed, never stored). */
export interface VoronoiNode extends NodeBase {
  readonly op: 'voronoi';
  readonly min: Vec3;
  readonly max: Vec3;
  readonly density: number;
  readonly seed: number;
  readonly radius: number;
  readonly cap: 'sphere' | 'butt';
  readonly region?: string;
}

/** Where a distance scalar measures to: a point, a plane (signed, positive on the normal side), the closed solid of an entity, or another field's value. */
export type DistanceTarget =
  | { readonly point: Vec3 }
  | { readonly plane: { readonly origin: Vec3; readonly normal: Vec3 } }
  | { readonly entityId: string }
  | { readonly field: string };

export type ScalarNode = NodeBase & { readonly op: 'scalar' } & (
    | { readonly kind: 'coordinate'; readonly axis: 'x' | 'y' | 'z' }
    | { readonly kind: 'distance'; readonly to: DistanceTarget }
    | {
        readonly kind: 'ramp';
        readonly input: string;
        readonly inMin: number;
        readonly inMax: number;
        readonly outMin: number;
        readonly outMax: number;
        readonly clamp: boolean;
        readonly easing: 'linear' | 'smoothstep';
      }
    | { readonly kind: 'mix'; readonly a: Law; readonly b: Law; readonly factor: Law }
    | {
        readonly kind: 'arith';
        readonly operation: 'add' | 'subtract' | 'multiply' | 'divide' | 'min' | 'max';
        readonly a: Law;
        readonly b: Law;
      }
    | { readonly kind: 'noise'; readonly seed: number; readonly frequency: number; readonly octaves: number }
    | { readonly kind: 'topology_density'; readonly studyId: string }
    | { readonly kind: 'fea_result'; readonly caseId: string; readonly quantity: 'von_mises' | 'u_mag'; readonly step?: number }
  );

export type FieldNode =
  | PrimitiveNode
  | SolidNode
  | BooleanNode
  | OffsetNode
  | ShellNode
  | TransformNode
  | TpmsNode
  | StrutsNode
  | GraphNode
  | VoronoiNode
  | ScalarNode;

const isLawId = (law: Law | undefined): law is string => typeof law === 'string';

export interface ImplicitBody {
  readonly id: string;
  readonly field: string;
  readonly voxel: number;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  /** tetra: marching tetrahedra; dual_contouring: sharp features kept (falls back to tetra, and is then recorded as tetra, when not manifold). */
  readonly mesher: 'tetra' | 'dual_contouring';
  /** Name and colour of the derived entity (restored with it on load). */
  readonly name: string;
  readonly color: string;
  /** Engine that realised the mesh (part of the hash). */
  readonly engine: string;
  /** sha256 of (compiled program, grid, mesher, engine major version, determinism class). */
  readonly contentHash: string;
  /** Source entities moved to the hidden layer when the body was created. */
  readonly hiddenSources: readonly string[];
  /** True when the caller gave `bounds` to create_implicit_body (kept when the body is re-derived; otherwise the field's own support box is used). */
  readonly explicitBounds?: boolean;
  /** Full-resolution mesh in the host's mesh asset store (05 IMP D3 host cache); the entity then holds a display level of detail. */
  readonly asset?: MeshAssetRef;
}

export interface ImplicitModel {
  readonly version: 1;
  readonly fields: Readonly<Record<string, FieldNode>>;
  readonly bodies: Readonly<Record<string, ImplicitBody>>;
}

const EMPTY_IMPLICIT: ImplicitModel = { version: 1, fields: {}, bodies: {} };

export const implicitOf = (doc: CadDocument): ImplicitModel =>
  doc.implicit?.fields !== undefined && doc.implicit.bodies !== undefined ? doc.implicit : EMPTY_IMPLICIT;

export const fieldOf = (doc: CadDocument, id: string): FieldNode | undefined => {
  const fields = implicitOf(doc).fields;
  return Object.hasOwn(fields, id) ? fields[id] : undefined;
};

export const bodyOf = (doc: CadDocument, id: string): ImplicitBody | undefined => {
  const bodies = implicitOf(doc).bodies;
  return Object.hasOwn(bodies, id) ? bodies[id] : undefined;
};

export const withField = (doc: CadDocument, node: FieldNode): CadDocument => {
  const model = implicitOf(doc);
  return { ...doc, implicit: { ...model, fields: { ...model.fields, [node.id]: node } } };
};

export const withBody = (doc: CadDocument, body: ImplicitBody): CadDocument => {
  const model = implicitOf(doc);
  return { ...doc, implicit: { ...model, bodies: { ...model.bodies, [body.id]: body } } };
};

const lawInputs = (...laws: ReadonlyArray<Law | undefined>): string[] => laws.filter(isLawId);

/** Ids of the nodes a node reads directly. */
export function inputsOf(node: FieldNode): readonly string[] {
  switch (node.op) {
    case 'boolean':
      return [...node.operands, ...lawInputs(node.blend?.radius)];
    case 'offset':
      return [node.source, ...lawInputs(node.distance)];
    case 'shell':
      return [node.source, ...lawInputs(node.thickness)];
    case 'transform':
      return [node.source];
    case 'tpms':
      return [...lawInputs(node.control.value), ...(node.region === undefined ? [] : [node.region])];
    case 'struts':
      return [...lawInputs(node.radius), ...(node.region === undefined ? [] : [node.region])];
    case 'graph':
    case 'voronoi':
      return node.region === undefined ? [] : [node.region];
    case 'scalar':
      switch (node.kind) {
        case 'ramp':
          return [node.input];
        case 'mix':
          return lawInputs(node.a, node.b, node.factor);
        case 'arith':
          return lawInputs(node.a, node.b);
        case 'distance':
          return 'field' in node.to ? [node.to.field] : [];
        default:
          return [];
      }
    default:
      return [];
  }
}

/** Document entities a node reads (solids it measures, curves it sketches from): they cannot change while a body depends on the node. */
export function entitySources(node: FieldNode): readonly string[] {
  if (node.op === 'solid') return [node.entityId];
  if (node.op === 'graph') return node.sourceIds;
  if (node.op === 'scalar' && node.kind === 'distance' && 'entityId' in node.to) return [node.to.entityId];
  return [];
}
