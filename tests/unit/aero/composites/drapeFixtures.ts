import type { CadDocument } from '@core/model/types';
import { apply, ok } from '../../../helpers/commandAssertions';
import { ROSETTE, withMaterials } from './fixtures';

export const WOVEN = {
  name: 'Woven',
  form: 'woven',
  E1: 60000,
  E2: 60000,
  G12: 4000,
  nu12: 0.04,
  plyThickness: 0.25,
  density: 0.0016,
  lockingAngle: 40,
  warningShear: 30,
  basis: 'b_basis',
  source: 'test fixture (drape limits are illustrative)',
} as const;

export interface Drapable {
  readonly doc: CadDocument;
  readonly tool: string;
  readonly part: string;
}

/** Hemisphere cap tool (R = 100) with a part on its upper cap and the Woven material (lock 40, warning 30). */
export function spherePart(radius = 100): Drapable {
  let doc = withMaterials();
  doc = apply(doc, 'create_lamina_material', WOVEN);
  const tool = ok(doc, 'add_sphere', { radius, position: [0, 0, 0] });
  doc = apply(tool.document, 'define_rosette', ROSETTE);
  const part = ok(doc, 'create_composite_part', {
    name: 'Dome',
    toolSurface: { entityId: tool.affected[0], faceNear: [0, 0, radius] },
    rosette: 'R0',
  });
  return { doc: part.document, tool: tool.affected[0] as string, part: part.affected[0] as string };
}

/** Rational biquadratic sphere patch (azimuth 0..90 deg, polar `from`..`to` degrees) as create_nurbs_surface params. */
export function spherePatch(radius: number, from: number, to: number): Record<string, unknown> {
  const [t0, t1] = [(from * Math.PI) / 180, (to * Math.PI) / 180];
  const alpha = (t1 - t0) / 2;
  const mid = (t0 + t1) / 2;
  const meridian = [
    { r: radius * Math.sin(t0), z: radius * Math.cos(t0), w: 1 },
    { r: (radius / Math.cos(alpha)) * Math.sin(mid), z: (radius / Math.cos(alpha)) * Math.cos(mid), w: Math.cos(alpha) },
    { r: radius * Math.sin(t1), z: radius * Math.cos(t1), w: 1 },
  ];
  const azimuth = [
    { x: 1, y: 0, w: 1 },
    { x: 1, y: 1, w: Math.SQRT1_2 },
    { x: 0, y: 1, w: 1 },
  ];
  return {
    degreeU: 2,
    degreeV: 2,
    poles: azimuth.map((a) => meridian.map((m) => [m.r * a.x, m.r * a.y, m.z])),
    weights: azimuth.map((a) => meridian.map((m) => a.w * m.w)),
  };
}
