/**
 * @layer ui (type declarations only)
 *
 * r3f JSX augmentation for three.js primitives that are not included in the
 * stock @react-three/fiber ThreeElements map.
 *
 * `line_` — maps to THREE.Line. The underscore suffix is the r3f convention for
 * avoiding collision with the SVG `<line>` intrinsic element.
 */
import type * as THREE from 'three';
import type { Object3DNode } from '@react-three/fiber';

declare module '@react-three/fiber' {
  interface ThreeElements {
    line_: Object3DNode<THREE.Line, typeof THREE.Line>;
  }
}
