/**
 * 3D pipe-frame solver types. Units are the caller's but MUST be consistent (llull plant stress: N, mm, MPa, rad).
 * DOF order per node: [ux, uy, uz, rx, ry, rz] in the global frame (Z up).
 */

export type FramePoint = readonly [number, number, number];

/** Section and material of a straight Timoshenko element; `shearArea` 0 selects Euler-Bernoulli. */
export interface FrameProperties {
  readonly youngs: number;
  readonly shear: number;
  readonly area: number;
  /** Second moment of area (both bending planes). */
  readonly inertia: number;
  readonly torsion: number;
  readonly shearArea: number;
}

export interface FrameElement {
  /** Node indices into `FrameModel.nodes`. */
  readonly a: number;
  readonly b: number;
  readonly properties: FrameProperties;
  /** Bend flexibility factor k >= 1: bending stiffness EI / k (axial, shear, torsion unchanged). Default 1. */
  readonly flexibility?: number;
  /** Reference direction for the local z axis (default global Z, or global X when the element is vertical). */
  readonly up?: FramePoint;
}

export interface FrameRestraint {
  readonly node: number;
  /** 0..2 translations, 3..5 rotations. */
  readonly dof: number;
  /** Prescribed displacement (rigid restraint) or ground offset (spring). Default 0. */
  readonly value?: number;
  /** Omitted: rigid (DOF eliminated). Given: linear spring to ground, force = stiffness x (u - value). */
  readonly stiffness?: number;
}

export interface FrameModel {
  readonly nodes: readonly FramePoint[];
  readonly elements: readonly FrameElement[];
  readonly restraints: readonly FrameRestraint[];
}

interface FrameNodalLoad {
  readonly node: number;
  readonly force?: FramePoint;
  readonly moment?: FramePoint;
}

interface FrameElementLoad {
  readonly element: number;
  /** Uniform load per unit length, global components. */
  readonly uniform?: FramePoint;
  /** Free axial strain (thermal alpha x dT): equivalent end forces +-E A strain along the element axis. */
  readonly freeStrain?: number;
}

export interface FrameLoadCase {
  readonly name: string;
  readonly nodal?: readonly FrameNodalLoad[];
  readonly elemental?: readonly FrameElementLoad[];
}

export interface FrameDof {
  readonly node: number;
  readonly dof: number;
}

export interface FrameCaseResult {
  readonly name: string;
  /** 6 per node, global. */
  readonly displacements: Float64Array;
  /** 6 per node, global: force the support exerts on the pipe at restrained / spring DOFs (about zero elsewhere). */
  readonly reactions: Float64Array;
  /**
   * 12 per element, LOCAL axes (x along a to b): [N, Vy, Vz, T, My, Mz] applied to the element by node a, then by node b
   * (so a tensile member has N < 0 at a and N > 0 at b).
   */
  readonly elementForces: Float64Array;
  /** Equilibrium residual over the free DOFs, relative to the load norm. */
  readonly residual: number;
}

interface FrameStats {
  readonly nodes: number;
  readonly dofs: number;
  readonly freeDofs: number;
  /** Largest row envelope (half bandwidth) after reverse Cuthill-McKee. */
  readonly bandwidth: number;
  /** Stored entries of the skyline factor. */
  readonly profile: number;
}

export type FrameErrorCode = 'FRAME_INVALID_MODEL' | 'FRAME_INVALID_LOAD' | 'FRAME_UNSTABLE';

export type FrameAnalysis =
  | { readonly ok: true; readonly cases: readonly FrameCaseResult[]; readonly stats: FrameStats }
  | { readonly ok: false; readonly code: FrameErrorCode; readonly message: string; readonly dofs: readonly FrameDof[] };
