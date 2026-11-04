// Which scene objects the screen-space effects (edge pass, ambient occlusion) leave out of their normal/depth render: anything that is not a
// solid surface (lines, points, sprites) and the helper planes that carry `userData.noEdges` (infinite grid, contact-shadow patch).

import type * as THREE from 'three';

export function isEdgeExcluded(object: THREE.Object3D): boolean {
  const kind = object as { isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return kind.isLine === true || kind.isPoints === true || kind.isSprite === true || object.userData['noEdges'] === true;
}

/** Hides every visible excluded object; returns the restore function. Hidden subtrees are not entered (their children stay as they are). */
export function hideEdgeExcluded(root: THREE.Object3D): () => void {
  const hidden: THREE.Object3D[] = [];
  root.traverseVisible((object) => {
    if (object !== root && isEdgeExcluded(object)) hidden.push(object);
  });
  for (const object of hidden) object.visible = false;
  return () => {
    for (const object of hidden) object.visible = true;
  };
}
