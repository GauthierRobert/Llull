/**
 * @layer ui/viewport/2d
 *
 * Mounts a three.js Line/LineSegments at an entity's position and disposes its geometry +
 * material when the object changes or unmounts (R9). `ShapeLine` is the shared body of every 2D
 * curve renderer: each renderer only supplies the flat xyz vertex list.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import { SELECTION_COLOR } from '../../viewportPalette';
import { positionsGeometry } from '../../lineGeometry';

interface PlacedLineObjectProps {
  object: THREE.Line | THREE.LineSegments;
  position: Vec3;
}

export function PlacedLineObject({ object, position }: PlacedLineObjectProps): React.ReactElement {
  useEffect(() => {
    return () => {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    };
  }, [object]);

  object.position.set(position[0], position[1], position[2]);
  return <primitive object={object} />;
}

interface ShapeLineProps {
  /** Flat xyz vertices; a line strip, or independent segment pairs when `segments` is set. */
  positions: number[];
  segments?: boolean;
  linewidth?: number;
  position: Vec3;
  color: string;
  selected: boolean;
}

export function ShapeLine({
  positions,
  segments = false,
  linewidth = 1,
  position,
  color,
  selected,
}: ShapeLineProps): React.ReactElement {
  const object = useMemo(() => {
    const geometry = positionsGeometry(positions);
    const material = new THREE.LineBasicMaterial({
      color: selected ? SELECTION_COLOR : color,
      linewidth,
    });
    return segments
      ? new THREE.LineSegments(geometry, material)
      : new THREE.Line(geometry, material);
  }, [positions, segments, linewidth, color, selected]);

  return <PlacedLineObject object={object} position={position} />;
}
