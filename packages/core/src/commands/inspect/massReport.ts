/**
 * Payload of `mass_properties` beyond volume and mass (aerospace 01 KRN, TR-KRN-40, 102..104): centroid, area, inertia tensors in the
 * requested frame, principal moments and axes, provenance, precision-envelope warning, `reviewRequired`.
 */

import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { ExecutionContext } from '../types';
import { applyMat3, matFromEulerXYZ, mulMat3, type Mat3 } from '../../lib/axisRotation';
import { symmetricEigen } from '../../lib/symmetricEigen';
import { entityBoundsInDoc, type Bounds } from '../../geometry/bounds';
import { shiftInertia, type InertiaTensor } from '../../geometry/massProperties';
import { recipeKey } from '../../geometry/shapeRecipe';
import type { ResolvedMass } from '../../geometry/resolveMassProperties';
import { toMetres } from '../../model/units';

export type MassFrame = 'document' | 'entity';
export type MassPurpose = 'general' | 'weight-and-balance';

/** 3x3 symmetric matrix, row-major rows; off-diagonals are the tensor terms (-integral xy dm). */
export type Matrix3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

/** Geometry beyond |x|, |y|, |z| <= 1e5 mm loses precision in the kernels (TR-KRN-70). */
const ENVELOPE_MM = 1e5;

const matrixOf = ([xx, yy, zz, xy, xz, yz]: InertiaTensor): Matrix3 => [
  [xx, xy, xz],
  [xy, yy, yz],
  [xz, yz, zz],
];

const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Rᵀ · I · R for the symmetric tensor `inertia`. */
function rotateTensor(inertia: InertiaTensor, rotation: Mat3): InertiaTensor {
  const [xx, yy, zz, xy, xz, yz] = inertia;
  const full: Mat3 = [xx, xy, xz, xy, yy, yz, xz, yz, zz];
  const m = mulMat3(mulMat3(transpose(rotation), full), rotation);
  return [m[0], m[4], m[8], m[1], m[2], m[5]];
}

export interface InertiaReport {
  readonly atCentroid: Matrix3;
  readonly atOrigin: Matrix3;
  /** Point the `atOrigin` tensor is taken about, in the report frame. */
  readonly about: Vec3;
  readonly principal: { readonly moments: Vec3; readonly axes: readonly [Vec3, Vec3, Vec3] };
  /** Square roots of principal moment / mass, in document units; absent for zero mass. */
  readonly radiiOfGyration?: Vec3;
  readonly unit: string;
  readonly frame: MassFrame;
}

export interface MassDetail {
  readonly centroid: Vec3;
  readonly area?: number;
  readonly areaUnit?: string;
  readonly inertia: InertiaReport;
  readonly relErrorEstimate?: number;
}

/** Centroid and inertia of `resolved` in the requested frame ('entity': the entity's position and rotation), about `about` (that frame). */
export function massDetail(
  doc: Pick<CadDocument, 'units'>,
  e: Entity,
  resolved: ResolvedMass,
  frame: MassFrame,
  about: Vec3 | undefined,
  weighted: boolean,
): MassDetail {
  const { mass, centerOfMass, inertia } = resolved.properties;
  const rotation = matFromEulerXYZ(e.rotation);
  const toFrame = (v: Vec3): Vec3 =>
    frame === 'entity' ? applyMat3(transpose(rotation), [v[0] - e.position[0], v[1] - e.position[1], v[2] - e.position[2]]) : v;
  const centroid = toFrame(centerOfMass);
  const tensor = frame === 'entity' ? rotateTensor(inertia, rotation) : inertia;
  const point: Vec3 = about ?? [0, 0, 0];
  const principal = symmetricEigen(tensor);
  return {
    centroid,
    ...(resolved.area === undefined ? {} : { area: resolved.area, areaUnit: `${doc.units}²` }),
    inertia: {
      atCentroid: matrixOf(tensor),
      atOrigin: matrixOf(shiftInertia(tensor, mass, centroid, point)),
      about: point,
      principal: principal ?? {
        moments: [0, 0, 0],
        axes: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
      },
      ...(principal !== null && mass > 0
        ? { radiiOfGyration: principal.moments.map((moment) => Math.sqrt(Math.max(moment, 0) / mass)) as unknown as Vec3 }
        : {}),
      unit: weighted ? `g·${doc.units}²` : `${doc.units}⁵ (per unit density)`,
      frame,
    },
    ...(resolved.relError === undefined ? {} : { relErrorEstimate: resolved.relError }),
  };
}

export interface MassWarning {
  readonly code: 'KRN_PRECISION_ENVELOPE';
  readonly message: string;
  readonly entityIds: readonly string[];
  readonly bbox: Bounds;
}

/** `KRN_PRECISION_ENVELOPE` when the entity's bounds exceed |x|, |y|, |z| <= 1e5 mm. */
export function precisionWarnings(doc: CadDocument, e: Entity, resolved: ResolvedMass): MassWarning[] {
  const bbox = resolved.bounds ?? entityBoundsInDoc(doc, e);
  const limit = ENVELOPE_MM / 1000 / toMetres(doc, 1);
  if (![...bbox.min, ...bbox.max].some((value) => Math.abs(value) > limit)) return [];
  return [
    {
      code: 'KRN_PRECISION_ENVELOPE',
      message: `entity '${e.id}' extends beyond |x|, |y|, |z| <= 1e5 mm; kernel precision degrades there (the integration runs in a part frame, but other operations do not)`,
      entityIds: [e.id],
      bbox,
    },
  ];
}

export interface MassProvenance {
  readonly method: ResolvedMass['method'];
  readonly kernel: { readonly name: string } & Record<string, unknown>;
  readonly inputs: { readonly entityIds: readonly string[]; readonly recipeKey?: string; readonly densitySource: string };
}

export function massProvenance(e: Entity, resolved: ResolvedMass, ctx: ExecutionContext, densitySource: string): MassProvenance {
  const kernel = ctx.kernel;
  return {
    method: resolved.method,
    kernel: { name: kernel?.name ?? 'none', ...(kernel?.info?.() ?? {}) },
    inputs: { entityIds: [e.id], ...(e.kind === 'mesh' && e.brep !== undefined ? { recipeKey: recipeKey(e.brep) } : {}), densitySource },
  };
}

/** `unverified` reasons that come from how the figure was computed (TR-KRN-103). */
export const methodReasons = (resolved: ResolvedMass): string[] => [
  ...(resolved.method === 'mesh' || resolved.inertiaFromMesh ? ['method_mesh'] : []),
  ...(resolved.facetedBody ? ['faceted_body'] : []),
];

export interface ReviewRequired {
  readonly value: boolean;
  readonly reasons: readonly string[];
}

/** TR-KRN-104: true for weight-and-balance, any unverified reason, or a geometry outside the precision envelope. */
export function reviewRequired(
  purpose: MassPurpose,
  unverifiedReasons: readonly string[],
  warnings: readonly MassWarning[],
): ReviewRequired {
  const reasons = [
    ...(purpose === 'weight-and-balance' ? ['purpose_weight_and_balance'] : []),
    ...unverifiedReasons,
    ...(warnings.length > 0 ? ['outside_precision_envelope'] : []),
  ];
  return { value: reasons.length > 0, reasons };
}

export const NOT_APPROVED = 'computed by llull, not approved — needs a qualified engineer';
