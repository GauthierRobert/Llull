/**
 * @layer ui/viewport/2d
 *
 * DrawingPrimitives2D — renders technical-drawing primitives with ISO 128 line weights: thick
 * continuous outlines (screen-constant width), thin lines, dashed hidden lines, chain centre lines,
 * 45° hatching and solid poché. The one renderer of every 2D technical drawing (the building plan
 * and the solids' views); pure presentation of primitives built in core / plugins.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LINE_PATTERNS } from '@core/model/drawing';
import { TEXT_FONT_URL } from '@ui/viewport/textFont';
import {
  type DrawingLabel,
  type DrawingScale,
  type SegmentBuffer,
  type StyledPrimitive,
  buildDrawingBuffers,
} from './drawingGeometry';
import { planAnchor } from './planAnchor';
import { useMinScreenSize } from './useMinScreenSize';

/** Thick (visible / cut) line width in screen pixels; thin lines are 1 px. */
const THICK_PX = 2;

interface DrawingObjects {
  readonly thick: LineSegments2;
  readonly thin: THREE.LineSegments;
  readonly dashed: THREE.LineSegments;
  readonly fill: THREE.Mesh;
  readonly labels: DrawingLabel[];
}

function thinSegments(
  buffer: SegmentBuffer,
  material: THREE.LineBasicMaterial | THREE.LineDashedMaterial,
): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffer.positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(buffer.colors, 3));
  if (material instanceof THREE.LineDashedMaterial) {
    // Each segment restarts the pattern on a dash (ISO 128: dashed lines start with a dash).
    const distances: number[] = [];
    for (let index = 0; index < buffer.positions.length; index += 6) {
      const [ax, ay, , bx, by] = buffer.positions.slice(index, index + 6) as number[];
      distances.push(
        0,
        Math.hypot((bx as number) - (ax as number), (by as number) - (ay as number)),
      );
    }
    geometry.setAttribute('lineDistance', new THREE.Float32BufferAttribute(distances, 1));
  }
  return new THREE.LineSegments(geometry, material);
}

function thickSegments(buffer: SegmentBuffer): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  if (buffer.positions.length > 0) {
    geometry.setPositions(buffer.positions);
    geometry.setColors(buffer.colors);
  }
  const material = new LineMaterial({ vertexColors: true, linewidth: THICK_PX });
  return new LineSegments2(geometry, material);
}

function buildObjects(
  items: ReadonlyArray<StyledPrimitive>,
  scale: DrawingScale,
  fillColor: string,
  anchor: readonly [number, number],
): DrawingObjects {
  const buffers = buildDrawingBuffers(items, scale, anchor);
  const shapes = buffers.fills.map(({ outer, holes }) => {
    const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const hole of holes) {
      shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
    }
    return shape;
  });
  const fill = new THREE.Mesh(
    new THREE.ShapeGeometry(shapes),
    new THREE.MeshBasicMaterial({ color: fillColor, side: THREE.DoubleSide }),
  );
  fill.position.z = -0.01;
  return {
    thick: thickSegments(buffers.thick),
    thin: thinSegments(buffers.thin, new THREE.LineBasicMaterial({ vertexColors: true })),
    dashed: thinSegments(
      buffers.dashed,
      new THREE.LineDashedMaterial({
        vertexColors: true,
        dashSize: LINE_PATTERNS.hidden[0] * scale.patternUnit,
        gapSize: LINE_PATTERNS.hidden[1] * scale.patternUnit,
      }),
    ),
    fill,
    labels: buffers.labels,
  };
}

function disposeObjects(objects: DrawingObjects): void {
  for (const object of [objects.thick, objects.thin, objects.dashed, objects.fill]) {
    object.geometry.dispose();
    (object.material as THREE.Material).dispose();
  }
}

function DrawingLabelText({ label }: { label: DrawingLabel }): React.ReactElement {
  const ref = useRef<THREE.Group>(null);
  useMinScreenSize(ref, label.dimension ? label.height : 0);
  return (
    <group ref={ref} position={[label.at[0], label.at[1], 0.01]} rotation={[0, 0, label.rotation]}>
      <Text
        font={TEXT_FONT_URL}
        fontSize={label.height}
        color={label.color}
        anchorX="center"
        anchorY="middle"
      >
        {label.content}
      </Text>
    </group>
  );
}

interface DrawingPrimitives2DProps {
  readonly name: string;
  readonly items: ReadonlyArray<StyledPrimitive>;
  readonly scale: DrawingScale;
  /** Colour of solid poché fills. */
  readonly fillColor: string;
}

export function DrawingPrimitives2D({
  name,
  items,
  scale,
  fillColor,
}: DrawingPrimitives2DProps): React.ReactElement | null {
  const size = useThree((state) => state.size);
  // Vertices are stored relative to this point (float32 precision); the group re-adds it.
  const anchor = useMemo(() => planAnchor(items.map((item) => item.primitive)), [items]);
  const objects = useMemo(
    () => (items.length > 0 ? buildObjects(items, scale, fillColor, anchor) : null),
    [items, scale, fillColor, anchor],
  );
  useEffect(() => (objects ? () => disposeObjects(objects) : undefined), [objects]);
  useEffect(() => {
    objects?.thick.material.resolution.set(size.width, size.height);
  }, [objects, size]);

  if (!objects) return null;
  return (
    <group name={name} position={[anchor[0], anchor[1], 0]}>
      <primitive object={objects.fill} />
      <primitive object={objects.thin} />
      <primitive object={objects.dashed} />
      <primitive object={objects.thick} />
      {objects.labels.map((label) => (
        <DrawingLabelText key={label.key} label={label} />
      ))}
    </group>
  );
}
