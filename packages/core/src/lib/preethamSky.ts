/**
 * Clear-sky radiance of a view direction: the Preetham, Shirley and Smits analytic daylight model (A Practical Analytic Model for Daylight,
 * SIGGRAPH 99) as adapted by three.js `examples/jsm/objects/Sky.js` (MIT, Copyright 2010-2026 three.js authors; sources row S-VIS-SKY in
 * docs/plant/09-plant-visualization-review/TECHNICAL_SPEC.md). Every constant, the formula order and the defaults are Sky.js's own; the
 * only departures are Z-up axes (Sky.js is Y-up), no clouds (Sky.js's cloud layer is an extension that its `cloudCoverage` 0 switches
 * off, and the viewport sets it to 0) and no renderer tone mapping (three's default `NoToneMapping`; the output is the sRGB transfer of
 * the clamped radiance, what `colorspace_fragment` does). Powers use `@lib/pow` / `powInt` / `Math.sqrt`, never `Math.pow`.
 * @pure
 */

import type { Vec3 } from '../model/vectors';
import { pow } from './pow';
import { powInt } from './powInt';

/** Sky.js's uniforms of the Preetham model and their defaults (`Sky.SkyShader.uniforms`). */
export interface SkyParams {
  readonly turbidity: number;
  readonly rayleigh: number;
  readonly mieCoefficient: number;
  readonly mieDirectionalG: number;
}

export const SKY_DEFAULTS: SkyParams = { turbidity: 2, rayleigh: 1, mieCoefficient: 0.005, mieDirectionalG: 0.8 };

/** Distance Sky.js's `sunPosition` is conventionally given at: its `vSunfade` divides the height by 450000. */
export const SKY_SUN_DISTANCE = 450000;

const PI = 3.141592653589793;
const TOTAL_RAYLEIGH: Vec3 = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST: Vec3 = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000;
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const SUN_ANGULAR_DIAMETER_COS = 0.9999566769464484;
const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;
const EXPOSURE = 0.04;
const NIGHT_FLOOR: Vec3 = [0, 0.0003, 0.00075];

/** Sky.js's vertex-stage values: they depend on the sun and the parameters only, so a raster computes them once. */
export interface SkyState {
  readonly sunDirection: Vec3;
  readonly sunE: number;
  readonly betaR: Vec3;
  readonly betaM: Vec3;
  readonly mieDirectionalG: number;
  readonly sunDisc: boolean;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
/** x^1.5 as x * sqrt(x): exact operations only (x >= 0). */
const pow15 = (x: number): number => x * Math.sqrt(x);

function sunIntensity(zenithAngleCos: number): number {
  const c = Math.min(1, Math.max(-1, zenithAngleCos));
  return EE * Math.max(0, 1 - pow(Math.E, -((CUTOFF_ANGLE - Math.acos(c)) / STEEPNESS)));
}

/** The vertex stage of Sky.js for a sun direction (Z-up: z is the height; normalised here) and `params`; `sunDisc` = `showSunDisc`. */
export function skyState(sunDirection: Vec3, params: SkyParams = SKY_DEFAULTS, sunDisc = true): SkyState {
  const length = Math.hypot(sunDirection[0], sunDirection[1], sunDirection[2]) || 1;
  const sun: Vec3 = [sunDirection[0] / length, sunDirection[1] / length, sunDirection[2] / length];
  const sunfade = 1 - clamp01(1 - Math.exp((sun[2] * SKY_SUN_DISTANCE) / 450000));
  const rayleighCoefficient = params.rayleigh - 1 * (1 - sunfade);
  const c = 0.2 * params.turbidity * 10e-18;
  const mie = (k: 0 | 1 | 2): number => 0.434 * c * MIE_CONST[k] * params.mieCoefficient;
  return {
    sunDirection: sun,
    sunE: sunIntensity(sun[2]),
    betaR: [TOTAL_RAYLEIGH[0] * rayleighCoefficient, TOTAL_RAYLEIGH[1] * rayleighCoefficient, TOTAL_RAYLEIGH[2] * rayleighCoefficient],
    betaM: [mie(0), mie(1), mie(2)],
    mieDirectionalG: params.mieDirectionalG,
    sunDisc,
  };
}

/** Linear radiance [r, g, b] (1 = display white before clamping) of the unit view `direction` (Z-up) under `state`: Sky.js's fragment stage. */
export function skyRadiance(state: SkyState, direction: Vec3): Vec3 {
  const zenithAngle = Math.acos(Math.max(0, direction[2]));
  const inverse = 1 / (Math.cos(zenithAngle) + 0.15 * pow(93.885 - (zenithAngle * 180) / PI, -1.253));
  const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  const sM = MIE_ZENITH_LENGTH * inverse;
  const sun = state.sunDirection;
  const cosTheta = direction[0] * sun[0] + direction[1] * sun[1] + direction[2] * sun[2];
  const rPhase = THREE_OVER_SIXTEENPI * (1 + (cosTheta * 0.5 + 0.5) ** 2);
  const g = state.mieDirectionalG;
  const mPhase = ONE_OVER_FOURPI * ((1 - g * g) / pow15(1 - 2 * g * cosTheta + g * g));
  const horizonMix = clamp01(powInt(1 - sun[2], 5));
  const sundisc = state.sunDisc ? clamp01((cosTheta - SUN_ANGULAR_DIAMETER_COS) * 50000) : 0;
  const channel = (k: 0 | 1 | 2): number => {
    const betaR = state.betaR[k];
    const betaM = state.betaM[k];
    const fex = Math.exp(-(betaR * sR + betaM * sM));
    const scatter = state.sunE * ((betaR * rPhase + betaM * mPhase) / (betaR + betaM));
    const lin = pow15(scatter * (1 - fex)) * (1 + (Math.sqrt(scatter * fex) - 1) * horizonMix);
    return (lin + 0.1 * fex) * EXPOSURE + 760 * sundisc * Math.min(state.sunE * fex, 80) + NIGHT_FLOOR[k];
  };
  return [channel(0), channel(1), channel(2)];
}

/** The sRGB transfer function of three's `colorspace_fragment`, on a channel clamped to [0, 1]. */
function encodeChannel(linear: number): number {
  const c = clamp01(linear);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1 / 2.4) - 0.055;
}

/** 8-bit sRGB [r, g, b] of a linear radiance. */
export function skyRgb(radiance: Vec3): [number, number, number] {
  return [
    Math.round(encodeChannel(radiance[0]) * 255),
    Math.round(encodeChannel(radiance[1]) * 255),
    Math.round(encodeChannel(radiance[2]) * 255),
  ];
}
