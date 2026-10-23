/**
 * Document slice of the implicit plugin (05 IMP §3): a DAG of field nodes (design intent only: radii, cell sizes, entity references; never samples)
 * and the implicit bodies derived from it. A body's id is the id of its derived (read-only) mesh entity.
 * @invariant a node refers only to nodes created before it (ids `fld-<step>.<k>`), so the graph is acyclic by construction
 */

import type { CadDocument, Vec3 } from '@core/model/types';

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    implicit?: ImplicitModel;
  }
}

export type PrimitiveShape = 'sphere' | 'box' | 'cylinder' | 'capsule' | 'torus' | 'cone' | 'plane';
export type TpmsKind = 'gyroid' | 'schwarz_p' | 'diamond';
export type StrutCell = 'cubic' | 'bcc' | 'fcc' | 'octet';
type BlendKind = 'quadratic' | 'exponential' | 'chamfer';

interface Blend {
  readonly kind: BlendKind;
  readonly radius: number;
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
  readonly distance: number;
}

interface ShellNode extends NodeBase {
  readonly op: 'shell';
  readonly source: string;
  readonly thickness: number;
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
export type TpmsControl = { readonly kind: 'thickness'; readonly value: number } | { readonly kind: 'level'; readonly value: number };

/** Cells wrapped about an axis: `cellsAround` whole cells per turn (integer, else the seam jumps), axial cell size = cellSize[2], radial cell size `radialCellSize`. */
export interface CylindricalMap {
  readonly kind: 'cylindrical';
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly cellsAround: number;
  readonly radialCellSize: number;
}

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
  readonly map?: CylindricalMap;
  readonly region?: string;
}

export interface StrutsNode extends NodeBase {
  readonly op: 'struts';
  readonly cell: StrutCell;
  readonly cellSize: Vec3;
  readonly origin: Vec3;
  readonly rotation: Vec3;
  readonly radius: number;
  readonly nodeRadius?: number;
  readonly region?: string;
}

export type FieldNode = PrimitiveNode | SolidNode | BooleanNode | OffsetNode | ShellNode | TransformNode | TpmsNode | StrutsNode;

export interface ImplicitBody {
  readonly id: string;
  readonly field: string;
  readonly voxel: number;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly mesher: 'tetra';
  /** Name and colour of the derived entity (restored with it on load). */
  readonly name: string;
  readonly color: string;
  /** Engine that realised the mesh (part of the hash). */
  readonly engine: string;
  /** sha256 of (compiled program, grid, mesher, engine major version, engine name). */
  readonly contentHash: string;
  /** Source entities moved to the hidden layer when the body was created. */
  readonly hiddenSources: readonly string[];
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

/** Ids of the nodes a node reads directly. */
export function inputsOf(node: FieldNode): readonly string[] {
  switch (node.op) {
    case 'boolean':
      return node.operands;
    case 'offset':
    case 'shell':
    case 'transform':
      return [node.source];
    case 'tpms':
    case 'struts':
      return node.region === undefined ? [] : [node.region];
    default:
      return [];
  }
}
