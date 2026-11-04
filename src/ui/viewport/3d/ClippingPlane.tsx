// In-Canvas sync adapter for the renderer's clipping: the axis-aligned section plane of the View controls (clipPlaneMath) and the active
// review section box (its half-spaces, `review/sectionBoxMath`; the live draft while a face is dragged). Both sit in gl.clippingPlanes, which
// cuts every material (instanced, batched and per-entity) of the main scene but not the axes gizmo (clipBypass); disabling or unmounting clears them.

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore, useViewportStore } from '@ui/store';
import { useSectionBoxDraftStore } from '@ui/store/sectionBoxDraftStore';
import { installClipBypass } from './clipBypass';
import { renderClipPlane } from './clipPlaneMath';
import { markShadowsDirty } from './renderRigState';
import { setActiveClipPlanes } from './review/activeClipPlanes';
import { type ClipPlaneSpec, sectionClipPlanes } from './review/sectionBoxMath';

export function ClippingPlane(): null {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const mainScene = useThree((s) => s.scene);
  const renderOrigin = useStore((s) => s.renderOrigin);
  const { enabled, axis, offset, flipped } = useViewportStore((s) => s.clipPlane);
  const storedBox = useStore((s) => {
    const review = s.document.review;
    return review?.activeSectionBoxId === undefined ? undefined : review.sectionBoxes[review.activeSectionBoxId];
  });
  const draft = useSectionBoxDraftStore((s) => s.draft);
  const activeBox = draft ?? storedBox;

  // Stable, updated in place: no material recompiles.
  const planeRef = useRef<THREE.Plane>(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));

  useEffect(() => {
    const planes: THREE.Plane[] = [];
    const specs: ClipPlaneSpec[] = [];
    if (enabled) {
      const plane = planeRef.current;
      // Render space = world − renderOrigin.
      const clip = renderClipPlane(axis, flipped, offset, renderOrigin);
      plane.normal.set(...clip.normal);
      plane.constant = clip.constant;
      planes.push(plane);
      specs.push(clip);
    }
    if (activeBox !== undefined) {
      for (const clip of sectionClipPlanes(activeBox, renderOrigin)) {
        planes.push(new THREE.Plane(new THREE.Vector3(...clip.normal), clip.constant));
        specs.push(clip);
      }
    }
    if (planes.length === 0) {
      markShadowsDirty();
      return;
    }
    setActiveClipPlanes(specs);

    gl.localClippingEnabled = true;
    gl.clippingPlanes = planes;
    const restoreRender = installClipBypass(gl, mainScene);
    markShadowsDirty();
    invalidate();

    return () => {
      restoreRender();
      setActiveClipPlanes([]);
      gl.clippingPlanes = [];
      gl.localClippingEnabled = false;
    };
  }, [gl, invalidate, mainScene, enabled, axis, offset, flipped, renderOrigin, activeBox]);

  return null;
}
