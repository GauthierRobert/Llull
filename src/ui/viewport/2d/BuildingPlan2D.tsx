/**
 * @layer ui/viewport/2d
 *
 * BuildingPlan2D — draws the active level's floor plan (wall poché cut at 1.2 m, glazing, door
 * swings, columns, beams dashed, stairs, room tags, grid bubbles, dimensions) in the 2D drafting
 * view. Pure presentation of `buildPlanDrawing` (the same plan the DXF / sheet exporters use);
 * the BIM entities themselves are hidden in 2D (Entities2D) so each level reads as one plan.
 */

import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Text } from '@react-three/drei';
import type { Vec2 } from '@core/model/types';
import {
  buildPlanDrawing,
  CATEGORY_LAYER,
  fromMm,
  type PlanPrimitive,
} from '@core/commands/building';
import { useStore } from '@ui/store';
import { useThemeStore } from '@ui/store/themeStore';
import { TEXT_FONT_URL } from '@ui/viewport/textFont';

const ARC_SEGMENTS = 32;
const DIMENSION_COLOR = '#d6a243';

const LAYER_COLORS: ReadonlyMap<string, string> = new Map(
  Object.values(CATEGORY_LAYER).map(({ name, color }) => [name, color]),
);

interface PlanLabel {
  readonly key: string;
  readonly at: Vec2;
  readonly height: number;
  readonly content: string;
  readonly color: string;
  readonly rotation: number;
}

interface PlanGeometry {
  readonly solid: THREE.LineSegments;
  readonly dashed: THREE.LineSegments;
  readonly fill: THREE.Mesh;
  readonly labels: PlanLabel[];
}

function strokeColor(layer: string, wallStroke: string): string {
  if (layer === 'A-WALL' || layer === 'S-COLS') return wallStroke;
  return LAYER_COLORS.get(layer) ?? DIMENSION_COLOR;
}

class SegmentBuffer {
  readonly positions: number[] = [];
  readonly colors: number[] = [];

  add(a: Vec2, b: Vec2, color: THREE.Color): void {
    this.positions.push(a[0], a[1], 0, b[0], b[1], 0);
    this.colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  }

  ring(points: ReadonlyArray<Vec2>, closed: boolean, color: THREE.Color): void {
    const count = closed ? points.length : points.length - 1;
    for (let index = 0; index < count; index++) {
      this.add(points[index] as Vec2, points[(index + 1) % points.length] as Vec2, color);
    }
  }

  build(material: THREE.LineBasicMaterial | THREE.LineDashedMaterial): THREE.LineSegments {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    const segments = new THREE.LineSegments(geometry, material);
    if (material instanceof THREE.LineDashedMaterial) segments.computeLineDistances();
    return segments;
  }
}

function arcPoints(center: Vec2, radius: number, start: number, end: number): Vec2[] {
  const sweep = end > start ? end - start : end - start + Math.PI * 2;
  return Array.from({ length: ARC_SEGMENTS + 1 }, (_, index): Vec2 => {
    const angle = start + (sweep * index) / ARC_SEGMENTS;
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  });
}

function addDimension(
  primitive: Extract<PlanPrimitive, { type: 'dimension' }>,
  buffer: SegmentBuffer,
  labels: PlanLabel[],
  index: number,
): void {
  const color = new THREE.Color(DIMENSION_COLOR);
  const dx = primitive.b[0] - primitive.a[0];
  const dy = primitive.b[1] - primitive.a[1];
  const length = Math.hypot(dx, dy) || 1;
  const normal: Vec2 = [dy / length, -dx / length];
  const shift = (point: Vec2, distance: number): Vec2 => [
    point[0] + normal[0] * distance,
    point[1] + normal[1] * distance,
  ];
  const a = shift(primitive.a, primitive.offset);
  const b = shift(primitive.b, primitive.offset);
  buffer.add(
    shift(primitive.a, primitive.offset * 0.15),
    shift(primitive.a, primitive.offset * 1.1),
    color,
  );
  buffer.add(
    shift(primitive.b, primitive.offset * 0.15),
    shift(primitive.b, primitive.offset * 1.1),
    color,
  );
  buffer.add(a, b, color);
  const tick = primitive.offset * 0.12;
  for (const end of [a, b])
    buffer.add([end[0] - tick, end[1] - tick], [end[0] + tick, end[1] + tick], color);
  let angle = Math.atan2(dy, dx);
  if (angle > Math.PI / 2 + 1e-9 || angle <= -Math.PI / 2 + 1e-9) angle += Math.PI;
  const lift = primitive.offset * 0.22;
  labels.push({
    key: `dimension-${index}`,
    at: [(a[0] + b[0]) / 2 - Math.sin(angle) * lift, (a[1] + b[1]) / 2 + Math.cos(angle) * lift],
    height: primitive.offset * 0.25,
    content: primitive.label,
    color: DIMENSION_COLOR,
    rotation: angle,
  });
}

function buildGeometry(
  primitives: ReadonlyArray<PlanPrimitive>,
  visibleLayer: (layer: string) => boolean,
  wallFill: string,
  wallStroke: string,
  dashSize: number,
): PlanGeometry {
  const solid = new SegmentBuffer();
  const dashed = new SegmentBuffer();
  const shapes: THREE.Shape[] = [];
  const labels: PlanLabel[] = [];
  primitives.forEach((primitive, index) => {
    if (!visibleLayer(primitive.layer)) return;
    const color = new THREE.Color(strokeColor(primitive.layer, wallStroke));
    const target = primitive.style === 'hidden' ? dashed : solid;
    switch (primitive.type) {
      case 'polygon':
        target.ring(primitive.points, true, color);
        if (primitive.style === 'cut')
          shapes.push(new THREE.Shape(primitive.points.map(([x, y]) => new THREE.Vector2(x, y))));
        break;
      case 'polyline':
        target.ring(primitive.points, false, color);
        break;
      case 'line':
        target.add(primitive.a, primitive.b, color);
        break;
      case 'arc':
        target.ring(
          arcPoints(primitive.center, primitive.radius, primitive.startAngle, primitive.endAngle),
          false,
          color,
        );
        break;
      case 'circle': {
        const points = arcPoints(primitive.center, primitive.radius, 0, Math.PI * 2).slice(0, -1);
        target.ring(points, true, color);
        if (primitive.style === 'cut')
          shapes.push(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y))));
        break;
      }
      case 'text':
        labels.push({
          key: `text-${index}`,
          at: primitive.at,
          height: primitive.height,
          content: primitive.content,
          color: `#${color.getHexString()}`,
          rotation: 0,
        });
        break;
      case 'dimension':
        addDimension(primitive, solid, labels, index);
        break;
    }
  });
  const fill = new THREE.Mesh(
    new THREE.ShapeGeometry(shapes),
    new THREE.MeshBasicMaterial({ color: wallFill, side: THREE.DoubleSide }),
  );
  fill.position.z = -0.01;
  return {
    solid: solid.build(new THREE.LineBasicMaterial({ vertexColors: true })),
    dashed: dashed.build(
      new THREE.LineDashedMaterial({ vertexColors: true, dashSize, gapSize: dashSize * 0.6 }),
    ),
    fill,
    labels,
  };
}

function disposeGeometry(geometry: PlanGeometry): void {
  for (const object of [geometry.solid, geometry.dashed, geometry.fill]) {
    object.geometry.dispose();
    (object.material as THREE.Material).dispose();
  }
}

export function BuildingPlan2D(): React.ReactElement | null {
  const building = useStore((s) => s.document.building);
  const units = useStore((s) => s.document.units);
  const layers = useStore((s) => s.document.layers);
  const theme = useThemeStore((s) => s.theme);

  const plan = useMemo(
    () => (building ? buildPlanDrawing({ building, units }, undefined) : null),
    [building, units],
  );
  const geometry = useMemo(() => {
    if (!plan) return null;
    const visibleLayer = (layer: string): boolean => layers[`layer-${layer}`]?.visible !== false;
    const [wallFill, wallStroke] =
      theme === 'dark' ? ['#5f646e', '#d7dae0'] : ['#5a5d63', '#1f2125'];
    return buildGeometry(
      plan.primitives,
      visibleLayer,
      wallFill,
      wallStroke,
      fromMm({ units }, 150),
    );
  }, [plan, layers, theme, units]);

  useEffect(() => (geometry ? () => disposeGeometry(geometry) : undefined), [geometry]);

  if (!geometry) return null;
  return (
    <group name="building-plan-2d">
      <primitive object={geometry.fill} />
      <primitive object={geometry.solid} />
      <primitive object={geometry.dashed} />
      {geometry.labels.map((label) => (
        <Text
          key={label.key}
          font={TEXT_FONT_URL}
          position={[label.at[0], label.at[1], 0.01]}
          rotation={[0, 0, label.rotation]}
          fontSize={label.height}
          color={label.color}
          anchorX="center"
          anchorY="middle"
        >
          {label.content}
        </Text>
      ))}
    </group>
  );
}
