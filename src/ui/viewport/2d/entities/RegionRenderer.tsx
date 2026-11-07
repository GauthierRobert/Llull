// `kind:'region'`: loop outlines, hatch lines (lines / cross) or a filled mesh (solid), all in the entity plane.

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { RegionEntity, Vec2 } from '@core/model/types';
import { regionFaces, regionHatchLines } from '@core/geometry/region';
import { triangulatePolygon } from '@lib/triangulate';
import { SELECTION_COLOR } from '../../viewportPalette';
import { flattenPoints, loopSegments, positionsGeometry } from '../../lineGeometry';
import { ShapeLine } from './ShapeLine';

/** Flat xyz triangle list of the filled faces (holes bridged out). */
function fillPositions(loops: RegionEntity['loops']): number[] {
  return regionFaces(loops).flatMap(({ outer, holes }) => {
    const { vertices, triangles } = triangulatePolygon(outer, holes);
    return triangles.flatMap((corners) => flattenPoints(corners.map((index) => vertices[index] as Vec2)));
  });
}

function RegionFill({
  positions,
  position,
  rotation,
  color,
}: Pick<RegionEntity, 'position' | 'rotation' | 'color'> & { positions: number[] }): React.ReactElement {
  const geometry = useMemo(() => positionsGeometry(positions), [positions]);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    [color],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  return <mesh geometry={geometry} material={material} position={position} rotation={[0, 0, rotation[2]]} />;
}

export function RegionRenderer({ entity, selected }: { entity: RegionEntity; selected: boolean }): React.ReactElement {
  const { loops, hatch, position, rotation, color } = entity;
  const outline = useMemo(() => flattenPoints(loops.flatMap(loopSegments)), [loops]);
  const lines = useMemo(() => flattenPoints(regionHatchLines({ loops, hatch }).flat()), [loops, hatch]);
  const fill = useMemo(() => (hatch?.pattern === 'solid' ? fillPositions(loops) : null), [loops, hatch]);
  const tint = selected ? SELECTION_COLOR : color;
  return (
    <>
      {fill !== null && <RegionFill positions={fill} position={position} rotation={rotation} color={tint} />}
      <ShapeLine positions={outline} segments position={position} rotation={rotation} color={color} selected={selected} />
      {lines.length > 0 && (
        <ShapeLine positions={lines} segments position={position} rotation={rotation} color={color} selected={selected} />
      )}
    </>
  );
}
