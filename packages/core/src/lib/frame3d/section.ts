import type { FrameProperties } from './types';

/** Thin-wall pipe section: A = pi/4 (Do^2 - Di^2), I = pi/64 (Do^4 - Di^4), J = 2 I, shear area A/2 (PST spec 5.2). */
export function pipeProperties(outerDiameter: number, wall: number, youngs: number, poisson: number, timoshenko = true): FrameProperties {
  const inner = outerDiameter - 2 * wall;
  const area = (Math.PI / 4) * (outerDiameter ** 2 - inner ** 2);
  const inertia = (Math.PI / 64) * (outerDiameter ** 4 - inner ** 4);
  return { youngs, shear: youngs / (2 * (1 + poisson)), area, inertia, torsion: 2 * inertia, shearArea: timoshenko ? area / 2 : 0 };
}
