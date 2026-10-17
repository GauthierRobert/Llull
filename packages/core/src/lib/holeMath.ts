/**
 * Hole and pocket closed forms (aerospace 07 FTR §5.3 / §5.5). Every function returns the value together with the id of the formula that
 * produced it, so a value cannot reach a result without its provenance (TR-FTR-09). Lengths in one consistent unit, angles in degrees.
 */

/** A computed value with the formula that produced it. */
export interface Derived {
  readonly value: number;
  readonly formula: string;
}

const half = (angleDegrees: number): number => Math.tan((angleDegrees * Math.PI) / 360);

/** Volume of a conical frustum of height `h` between radii `r1` and `r2`. */
export function frustumVolume(h: number, r1: number, r2: number): Derived {
  return { value: ((Math.PI * h) / 3) * (r1 * r1 + r1 * r2 + r2 * r2), formula: 'pi*h/3*(r1^2+r1*r2+r2^2)' };
}

/** Depth of a countersink cone from the face down to the bore: c = (D - d) / (2 tan(alpha/2)). */
export function countersinkDepth(boreDiameter: number, cskDiameter: number, includedAngleDeg: number): Derived {
  return { value: (cskDiameter - boreDiameter) / (2 * half(includedAngleDeg)), formula: 'c=(D-d)/(2*tan(alpha/2))' };
}

/** Depth from the face to the sharp apex of the countersink cone: c0 = D / (2 tan(alpha/2)). */
export function countersinkApexDepth(cskDiameter: number, includedAngleDeg: number): Derived {
  return { value: cskDiameter / (2 * half(includedAngleDeg)), formula: 'c0=D/(2*tan(alpha/2))' };
}

/** Countersink diameter at the face for a cone of depth `c`: D = d + 2 c tan(alpha/2). */
export function countersinkDiameter(boreDiameter: number, depth: number, includedAngleDeg: number): Derived {
  return { value: boreDiameter + 2 * depth * half(includedAngleDeg), formula: 'D=d+2*c*tan(alpha/2)' };
}

/** Volume the cone removes beyond the bore cylinder (full cone height c). */
export function countersinkRemovedVolume(boreDiameter: number, cskDiameter: number, includedAngleDeg: number): Derived {
  const c = countersinkDepth(boreDiameter, cskDiameter, includedAngleDeg).value;
  const [r1, r2] = [cskDiameter / 2, boreDiameter / 2];
  return { value: frustumVolume(c, r1, r2).value - Math.PI * r2 * r2 * c, formula: 'V=pi*c/3*(R1^2+R1*R2+R2^2)-pi*R2^2*c' };
}

/** Same volume inside a sheet of thickness `thickness`: the cone is truncated at h = min(c, T) (knife-edge cases lose less). */
export function countersinkRemovedVolumeInSheet(
  boreDiameter: number,
  cskDiameter: number,
  includedAngleDeg: number,
  thickness: number,
): Derived {
  const c = countersinkDepth(boreDiameter, cskDiameter, includedAngleDeg).value;
  const h = Math.min(c, thickness);
  const [r1, r2] = [cskDiameter / 2, boreDiameter / 2];
  const r3 = r1 - h * half(includedAngleDeg);
  return { value: frustumVolume(h, r1, r3).value - Math.PI * r2 * r2 * h, formula: 'V_T=pi*h/3*(R1^2+R1*R3+R3^2)-pi*R2^2*h, h=min(c,T)' };
}

/** Cylindrical land left under a countersink: T - c (<= 0 is a knife edge). */
export function countersinkLand(thickness: number, depth: number): Derived {
  return { value: thickness - depth, formula: 'land=T-c' };
}

/** Height of a drill point of included angle `pointAngleDeg` on a bore of diameter `d`: h = (d/2) / tan(beta/2). */
export function drillTipHeight(boreDiameter: number, pointAngleDeg: number): Derived {
  return { value: boreDiameter / 2 / half(pointAngleDeg), formula: 'h=(d/2)/tan(beta/2)' };
}

/** Material removed by a rounded-rectangle pocket W x L, depth D, vertical corner radius rc and floor fillet rf (rf <= rc). */
export function pocketRemovedVolume(width: number, length: number, depth: number, cornerRadius: number, floorFillet: number): Derived {
  const area = width * length - (4 - Math.PI) * cornerRadius * cornerRadius;
  const prism = depth * area;
  if (floorFillet <= 0) return { value: prism, formula: 'V=D*(W*L-(4-pi)*rc^2)' };
  const spandrel = floorFillet * floorFillet * (1 - Math.PI / 4);
  const centroid = (floorFillet * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI));
  const perimeter = 2 * (width + length) - 8 * cornerRadius + 2 * Math.PI * (cornerRadius - centroid);
  return { value: prism - spandrel * perimeter, formula: 'V=D*(W*L-(4-pi)*rc^2)-a*(2*(W+L)-8*rc+2*pi*(rc-xbar)), a=rf^2*(1-pi/4)' };
}
