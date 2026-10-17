/** Leaf types shared by `kernel.ts` and `kernelPorts.ts` (which import each other's consumers): defined here to keep the import graph acyclic. */

declare const shapeHandleBrand: unique symbol;

/**
 * Opaque reference to a kernel-owned shape. Core never inspects it: it only passes it back to the kernel that minted it. It stays valid
 * after the kernel evicts or restarts (it re-evaluates).
 */
export interface ShapeHandle {
  readonly [shapeHandleBrand]: true;
}

export type FaceSurface = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'revolution' | 'extrusion' | 'other';
