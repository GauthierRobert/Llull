// Draws the Aerodynamics panel's results over the model (inside the floating-origin group, 3D and 2D): light-blue wind arrows upstream of
// the body, the frontal-area plane behind it, a red drag arrow at its centroid; for an analysed airfoil, the outline coloured by Cp and
// a lift arrow at the quarter chord. Data comes from useAeroViewStore (published by the panel); the toggle lives in the panel.

import React, { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import { boundsExtent } from '@core/geometry/bounds';
import { useAeroViewStore, type AeroAirfoilView, type AeroBodyView } from '@ui/store/aeroViewStore';
import { useDisposable } from '../../useDisposable';
import { ProjectedLabel } from '../ProjectedLabel';
import { formatArea } from '@ui/panels/aero/aeroData';
import { formatSi } from '@ui/siText';
import { AERO_COLORS, cpColor, dragArrowTip, flowFrame, silhouetteLoop, windArrows } from './aeroGeometry';

const UP = new THREE.Vector3(0, 1, 0);
const RENDER_ORDER = 998;

interface ArrowProps {
  origin: Vec3;
  direction: Vec3;
  length: number;
  radius: number;
  color: string;
  opacity: number;
}

function Arrow({ origin, direction, length, radius, color, opacity }: ArrowProps): React.ReactElement {
  const material = useDisposable(
    () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false }),
    [color, opacity],
  );
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(...direction)), [direction]);
  const head = Math.min(length * 0.4, radius * 7);
  return (
    <group position={origin} quaternion={quaternion}>
      <mesh material={material} position={[0, (length - head) / 2, 0]} renderOrder={RENDER_ORDER}>
        <cylinderGeometry args={[radius, radius, length - head, 8]} />
      </mesh>
      <mesh material={material} position={[0, length - head / 2, 0]} renderOrder={RENDER_ORDER}>
        <coneGeometry args={[radius * 3, head, 12]} />
      </mesh>
    </group>
  );
}

const label = (text: string, position: Vec3, color: string, id: string): React.ReactElement => (
  <ProjectedLabel position={position} text={text} className="load-label" borderColor={color} opacity={1} testId={`aero-label-${id}`} />
);

function BodyGlyphs({ body }: { body: AeroBodyView }): React.ReactElement {
  const size = boundsExtent(body.bounds) || 1;
  const frame = useMemo(() => flowFrame(body.bounds, body.flow), [body]);
  const gap = size * 0.08;
  const winds = useMemo(() => windArrows(frame, body.flow, size * 0.3, gap), [frame, body.flow, size, gap]);
  const loop = useMemo(() => silhouetteLoop(frame, body.flow, gap), [frame, body.flow, gap]);
  const dragLength = size * 0.45;
  return (
    <group name="aero-body">
      {winds.map((arrow, index) => (
        <Arrow
          key={index}
          origin={arrow.origin}
          direction={body.flow}
          length={arrow.length}
          radius={size * 0.006}
          color={AERO_COLORS.wind}
          opacity={0.75}
        />
      ))}
      <Line
        points={loop}
        color={AERO_COLORS.area}
        lineWidth={1.5}
        dashed
        dashSize={size * 0.03}
        gapSize={size * 0.02}
        depthTest={false}
        renderOrder={RENDER_ORDER}
      />
      {label(`A = ${formatArea(body.frontalAreaM2)}`, loop[2] as Vec3, AERO_COLORS.area, 'area')}
      {body.dragN !== null && (
        <>
          <Arrow
            origin={frame.center}
            direction={body.flow}
            length={dragLength}
            radius={size * 0.014}
            color={AERO_COLORS.drag}
            opacity={0.95}
          />
          {label(`Drag ${formatSi(body.dragN, 'N')}`, dragArrowTip(frame.center, body.flow, dragLength), AERO_COLORS.drag, 'drag')}
        </>
      )}
    </group>
  );
}

function AirfoilGlyphs({ airfoil }: { airfoil: AeroAirfoilView }): React.ReactElement {
  const outline = useMemo(() => {
    const points = [...airfoil.points, airfoil.points[0] ?? [0, 0]].map(([x, y]): Vec3 => [x, y, 0]);
    const pressures = [...airfoil.pressures, airfoil.pressures[0] ?? 0];
    return { points, colors: pressures.map((cp) => [...cpColor(cp, airfoil.cpMin, airfoil.cpMax)] as [number, number, number]) };
  }, [airfoil]);
  const leading = useMemo(
    () => airfoil.points.reduce((best, point) => (point[0] < best[0] ? point : best), airfoil.points[0] ?? [0, 0]),
    [airfoil],
  );
  const quarter: Vec3 = [leading[0] + airfoil.chord * 0.25, leading[1], 0];
  const up: Vec3 = [0, airfoil.cl < 0 ? -1 : 1, 0];
  const liftLength = airfoil.chord * (0.15 + 0.5 * Math.min(1, Math.abs(airfoil.cl) / 1.5));
  const tip: Vec3 = [quarter[0], quarter[1] + up[1] * liftLength, 0];
  return (
    <group name="aero-airfoil" position={airfoil.position} rotation={airfoil.rotation}>
      <Line points={outline.points} vertexColors={outline.colors} lineWidth={3.5} depthTest={false} renderOrder={RENDER_ORDER} />
      <Arrow origin={quarter} direction={up} length={liftLength} radius={airfoil.chord * 0.008} color={AERO_COLORS.lift} opacity={0.95} />
      {label(`Cl = ${airfoil.cl.toFixed(2)} @ ${airfoil.alphaDeg}°`, tip, AERO_COLORS.lift, 'lift')}
    </group>
  );
}

export function AeroOverlay(): React.ReactElement | null {
  const shown = useAeroViewStore((s) => s.shown);
  const body = useAeroViewStore((s) => s.body);
  const airfoil = useAeroViewStore((s) => s.airfoil);
  const invalidate = useThree((state) => state.invalidate);
  React.useEffect(() => useAeroViewStore.subscribe(() => invalidate()), [invalidate]);
  if (!shown || (body === null && airfoil === null)) return null;
  return (
    <group name="aero">
      {body !== null && <BodyGlyphs body={body} />}
      {airfoil !== null && <AirfoilGlyphs airfoil={airfoil} />}
    </group>
  );
}
