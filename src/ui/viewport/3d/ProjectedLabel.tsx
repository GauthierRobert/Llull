// A screen-space text pill anchored to a 3D point. Plain DOM (no nested React root): drei's <Html> unmounts its own root inside the
// r3f commit, which React reports as "Attempted to synchronously unmount a root while React was already rendering".

import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';

interface ProjectedLabelProps {
  position: Vec3;
  text: string;
  /** CSS class of the pill (the text span). */
  className: string;
  borderColor: string;
  opacity: number;
  testId: string;
}

const Z_INDEX = 18;

export function ProjectedLabel({ position, text, className, borderColor, opacity, testId }: ProjectedLabelProps): React.ReactElement {
  const anchor = useRef<THREE.Group>(null);
  const host = useThree((state) => state.gl.domElement.parentElement);
  const projected = useMemo(() => new THREE.Vector3(), []);
  const wrapper = useMemo(() => {
    const element = document.createElement('div');
    element.style.cssText = `position:absolute;top:0;left:0;pointer-events:none;z-index:${Z_INDEX};`;
    return element;
  }, []);
  const pill = useMemo(() => document.createElement('span'), []);

  useEffect(() => {
    wrapper.appendChild(pill);
    host?.appendChild(wrapper);
    return () => wrapper.remove();
  }, [host, wrapper, pill]);

  useEffect(() => {
    pill.className = className;
    pill.dataset['testid'] = testId;
    pill.textContent = text;
    pill.style.borderColor = borderColor;
    pill.style.opacity = String(opacity);
  }, [pill, className, testId, text, borderColor, opacity]);

  useFrame(({ camera, size }) => {
    const group = anchor.current;
    if (group === null) return;
    group.getWorldPosition(projected).project(camera);
    const behind = projected.z > 1;
    wrapper.style.display = behind ? 'none' : '';
    wrapper.style.transform = `translate3d(${((projected.x + 1) / 2) * size.width}px,${((1 - projected.y) / 2) * size.height}px,0)`;
  });

  return <group ref={anchor} position={position} />;
}
