// Which scene objects the screen-space effects (edge pass, ambient occlusion) leave out of their normal/depth render: anything that is not a
// solid surface (lines, points, sprites), meshes that are only overlays (not-drawn or depth-test-free materials: the TransformControls gizmo and pick plane) and the helper planes that carry `userData.noEdges` (infinite grid, contact-shadow patch).

import type * as THREE from 'three';

/** True when the object has materials and none is world geometry: not drawn (`visible = false`) an overlay (`depthTest = false`, as the
 *  TransformControls gizmo and its pick plane) or fully transparent (the live-FX pulse rings, opacity 0 between pulses). An override material would draw them as ordinary surfaces. */
function isOverlayOnly(object: THREE.Object3D): boolean {
  const material = (object as { material?: THREE.Material | THREE.Material[] }).material;
  if (material === undefined) return false;
  const materials = Array.isArray(material) ? material : [material];
  return (
    materials.length > 0 && materials.every((entry) => !entry.visible || !entry.depthTest || (entry.transparent && entry.opacity <= 0.01))
  );
}

export function isEdgeExcluded(object: THREE.Object3D): boolean {
  const kind = object as { isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return (
    kind.isLine === true || kind.isPoints === true || kind.isSprite === true || object.userData['noEdges'] === true || isOverlayOnly(object)
  );
}

/** Hides every visible object `excluded` accepts; returns the restore function. Hidden subtrees are not entered (their children stay as they are). */
export function hideEdgeExcluded(root: THREE.Object3D, excluded: (object: THREE.Object3D) => boolean = isEdgeExcluded): () => void {
  const hidden: THREE.Object3D[] = [];
  root.traverseVisible((object) => {
    if (object !== root && excluded(object)) hidden.push(object);
  });
  for (const object of hidden) object.visible = false;
  return () => {
    for (const object of hidden) object.visible = true;
  };
}
