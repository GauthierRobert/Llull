/**
 * The sky of the site context (plant 09 VIS-M8): three.js `Sky` (examples/jsm/objects/Sky.js, the Preetham daylight model; MIT) with its
 * sunPosition from the computed sun. Absent without a site context. Sky.js is Y-up and the document is Z-up, so its fragment shader reads
 * the view direction with y and z swapped (`.xzy`) and the sun is given in the same swapped frame. Clouds are off (cloudCoverage 0) so the
 * look is the model's own, as `@lib/preethamSky` draws it in the raster renders.
 */

import { useEffect, useMemo } from 'react';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { sunAt } from '@core/model/siteContext';
import { SKY_SUN_DISTANCE } from '@lib/preethamSky';
import { useStore } from '@ui/store';
import { skyTurbidity } from './appearance/environmentPlan';

const DIRECTION_LINE = 'vec3 direction = normalize( vWorldPosition - cameraPosition );';
/** Sky.js's box scale for `SKY_SUN_DISTANCE`. */
const SKY_SCALE = SKY_SUN_DISTANCE;

const NO_RAYCAST = (): void => undefined;

/** A Sky whose view direction is Z-up: the one-line change to Sky.js's fragment shader described above. */
function zUpSky(sunDirection: readonly [number, number, number], turbidity: number | undefined): Sky {
  const sky = new Sky();
  sky.material.fragmentShader = sky.material.fragmentShader.replace(DIRECTION_LINE, DIRECTION_LINE.replace(' );', ' ).xzy;'));
  const uniforms = sky.material.uniforms;
  uniforms['sunPosition']?.value.set(
    sunDirection[0] * SKY_SUN_DISTANCE,
    sunDirection[2] * SKY_SUN_DISTANCE,
    sunDirection[1] * SKY_SUN_DISTANCE,
  );
  if (turbidity !== undefined && uniforms['turbidity'] !== undefined) uniforms['turbidity'].value = turbidity;
  const coverage = uniforms['cloudCoverage'];
  if (coverage !== undefined) coverage.value = 0;
  sky.scale.setScalar(SKY_SCALE);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.raycast = NO_RAYCAST;
  sky.userData = { noEdges: true, captureExclude: true };
  return sky;
}

/** Sun of a sky environment in a document without a site context: the direction of the built-in key light (front-left, ~55 degrees high). */
const DEFAULT_SKY_SUN: readonly [number, number, number] = [
  -4 / Math.hypot(-4, -9, 14),
  -9 / Math.hypot(-4, -9, 14),
  14 / Math.hypot(-4, -9, 14),
];

/** Drawn with a site context (sun from the site) or with a `sky` environment (RV-M2: turbidity from the environment). */
export function SiteSky(): React.ReactElement | null {
  const site = useStore((s) => s.document.siteContext);
  const turbidity = useStore((s) => skyTurbidity(s.document.appearance?.environment));
  const sun = useMemo(() => (site === undefined ? null : sunAt(site)), [site]);
  const direction = sun?.direction ?? (turbidity === undefined ? null : DEFAULT_SKY_SUN);
  const sky = useMemo(() => (direction === null ? null : zUpSky(direction, turbidity)), [direction, turbidity]);
  useEffect(
    () => () => {
      sky?.geometry.dispose();
      sky?.material.dispose();
    },
    [sky],
  );
  return sky === null ? null : <primitive object={sky} />;
}
