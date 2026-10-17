/** The two kernel-boundary types that both `kernel.ts` and `kernelPorts.ts` name (one file keeps their type imports acyclic). */

declare const shapeHandleBrand: unique symbol;

/**
 * Opaque reference to a kernel-owned shape. Core never inspects it: it only passes it back to the kernel that minted it. It stays valid
 * after the kernel evicts or restarts (it re-evaluates).
 */
export interface ShapeHandle {
  readonly [shapeHandleBrand]: true;
}

export type FaceSurface = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'revolution' | 'extrusion' | 'other';
