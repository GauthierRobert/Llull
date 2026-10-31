/**
 * Exact orientation and in-sphere predicates for the Delaunay of the Voronoi seeds (05 IMP 14.14): a double-precision determinant with a conservative error
 * bound decides almost every call; when the value is inside the bound the determinant is recomputed exactly with BigInt on the exact binary values of the doubles.
 * @invariant the sign returned is the sign of the exact real determinant (Shewchuk's orient3d and insphere), never a tolerance: a point is inside a sphere only
 *   when it is strictly inside it, so a cospherical point is outside, the same answer from every search order
 */

import type { Vec3 } from '@core/model/types';

/** Relative error bound of the filter: about 100 times the one of Shewchuk's orient3d / insphere (7 eps and 16 eps), safe for the subtraction roundings of the inputs. */
const FILTER = 1e-13;

const view = new DataView(new ArrayBuffer(8));

/** x = mantissa * 2^exponent exactly (mantissa a signed integer, 0 for zero). */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  if (x === 0) return { mantissa: 0n, exponent: 0 };
  view.setFloat64(0, x);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const negative = high >>> 31 === 1;
  const biased = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  return { mantissa: negative ? -mantissa : mantissa, exponent: (biased === 0 ? 1 : biased) - 1075 };
}

/** The coordinates of `points` as integers on a common power of two (exact). */
type Big3 = [bigint, bigint, bigint];

function exact(points: readonly Vec3[]): Big3[] {
  const parts = points.map((p) => p.map(decompose));
  const lowest = Math.min(0, ...parts.flatMap((p) => p.filter((c) => c.mantissa !== 0n).map((c) => c.exponent)));
  return parts.map((p) => p.map((c) => c.mantissa << BigInt(c.exponent - lowest)) as Big3);
}

const sign = (value: number): number => (value > 0 ? 1 : value < 0 ? -1 : 0);
const signOf = (value: bigint): number => (value > 0n ? 1 : value < 0n ? -1 : 0);

/** Sign of the determinant of the rows (a - d, b - d, c - d): positive when d lies below the plane of a, b, c seen with a, b, c counterclockwise from above. */
export function orient3d(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const [adx, ady, adz] = [a[0] - d[0], a[1] - d[1], a[2] - d[2]];
  const [bdx, bdy, bdz] = [b[0] - d[0], b[1] - d[1], b[2] - d[2]];
  const [cdx, cdy, cdz] = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
  const det = adx * (bdy * cdz - bdz * cdy) + ady * (bdz * cdx - bdx * cdz) + adz * (bdx * cdy - bdy * cdx);
  const permanent =
    Math.abs(adx) * (Math.abs(bdy * cdz) + Math.abs(bdz * cdy)) +
    Math.abs(ady) * (Math.abs(bdz * cdx) + Math.abs(bdx * cdz)) +
    Math.abs(adz) * (Math.abs(bdx * cdy) + Math.abs(bdy * cdx));
  if (Math.abs(det) > FILTER * permanent) return sign(det);
  const [[ax, ay, az], [bx, by, bz], [cx, cy, cz], [dx, dy, dz]] = exact([a, b, c, d]) as [Big3, Big3, Big3, Big3];
  const [exx, eyy, ezz] = [ax - dx, ay - dy, az - dz];
  const [fxx, fyy, fzz] = [bx - dx, by - dy, bz - dz];
  const [gxx, gyy, gzz] = [cx - dx, cy - dy, cz - dz];
  return signOf(exx * (fyy * gzz - fzz * gyy) + eyy * (fzz * gxx - fxx * gzz) + ezz * (fxx * gyy - fyy * gxx));
}

/**
 * Sign of the 4 x 4 determinant of the rows (a - e, |a - e|^2), ..., (d - e, |d - e|^2) (Shewchuk's insphere): positive when e is inside the sphere of a, b, c, d
 * for a positively oriented tetrahedron (`orient3d(a, b, c, d) > 0`).
 */
function insphere(a: Vec3, b: Vec3, c: Vec3, d: Vec3, e: Vec3): number {
  const [aex, aey, aez] = [a[0] - e[0], a[1] - e[1], a[2] - e[2]];
  const [bex, bey, bez] = [b[0] - e[0], b[1] - e[1], b[2] - e[2]];
  const [cex, cey, cez] = [c[0] - e[0], c[1] - e[1], c[2] - e[2]];
  const [dex, dey, dez] = [d[0] - e[0], d[1] - e[1], d[2] - e[2]];
  const [ab, bc, cd, da, ac, bd] = [
    aex * bey - bex * aey,
    bex * cey - cex * bey,
    cex * dey - dex * cey,
    dex * aey - aex * dey,
    aex * cey - cex * aey,
    bex * dey - dex * bey,
  ];
  const abc = aez * bc - bez * ac + cez * ab;
  const bcd = bez * cd - cez * bd + dez * bc;
  const cda = cez * da + dez * ac + aez * cd;
  const dab = dez * ab + aez * bd + bez * da;
  const [alift, blift, clift, dlift] = [
    aex * aex + aey * aey + aez * aez,
    bex * bex + bey * bey + bez * bez,
    cex * cex + cey * cey + cez * cez,
    dex * dex + dey * dey + dez * dez,
  ];
  const det = dlift * abc - clift * dab + (blift * cda - alift * bcd);
  const [pab, pbc, pcd, pda, pac, pbd] = [
    Math.abs(aex * bey) + Math.abs(bex * aey),
    Math.abs(bex * cey) + Math.abs(cex * bey),
    Math.abs(cex * dey) + Math.abs(dex * cey),
    Math.abs(dex * aey) + Math.abs(aex * dey),
    Math.abs(aex * cey) + Math.abs(cex * aey),
    Math.abs(bex * dey) + Math.abs(dex * bey),
  ];
  const permanent =
    (Math.abs(aez) * pbc + Math.abs(bez) * pac + Math.abs(cez) * pab) * dlift +
    (Math.abs(bez) * pcd + Math.abs(cez) * pbd + Math.abs(dez) * pbc) * alift +
    (Math.abs(cez) * pda + Math.abs(dez) * pac + Math.abs(aez) * pcd) * blift +
    (Math.abs(dez) * pab + Math.abs(aez) * pbd + Math.abs(bez) * pda) * clift;
  if (Math.abs(det) > FILTER * permanent) return sign(det);
  const [A, B, C, D, E] = exact([a, b, c, d, e]) as [Big3, Big3, Big3, Big3, Big3];
  const rel = (p: Big3): Big3 => [p[0] - E[0], p[1] - E[1], p[2] - E[2]];
  const [[xa, ya, za], [xb, yb, zb], [xc, yc, zc], [xd, yd, zd]] = [rel(A), rel(B), rel(C), rel(D)];
  const [eab, ebc, ecd, eda, eac, ebd] = [
    xa * yb - xb * ya,
    xb * yc - xc * yb,
    xc * yd - xd * yc,
    xd * ya - xa * yd,
    xa * yc - xc * ya,
    xb * yd - xd * yb,
  ];
  const eabc = za * ebc - zb * eac + zc * eab;
  const ebcd = zb * ecd - zc * ebd + zd * ebc;
  const ecda = zc * eda + zd * eac + za * ecd;
  const edab = zd * eab + za * ebd + zb * eda;
  const [la, lb, lc, ld] = [
    xa * xa + ya * ya + za * za,
    xb * xb + yb * yb + zb * zb,
    xc * xc + yc * yc + zc * zc,
    xd * xd + yd * yd + zd * zd,
  ];
  return signOf(ld * eabc - lc * edab + (lb * ecda - la * ebcd));
}

/** 1 when `e` is strictly inside the circumsphere of the tetrahedron (a, b, c, d) of orientation `orientation` (the sign of `orient3d`), -1 when strictly outside, 0 on the sphere. */
export function inSphere(a: Vec3, b: Vec3, c: Vec3, d: Vec3, e: Vec3, orientation: number): number {
  return insphere(a, b, c, d, e) * orientation;
}

const vec = (p: Float64Array, i: number): Vec3 => [p[3 * i] as number, p[3 * i + 1] as number, p[3 * i + 2] as number];

/**
 * `orient3d` of the points a, b, c, d given by index into the packed coordinates `p` (x, y, z per point): the same double filter on scalars, no allocation; the exact
 * fallback is `orient3d` itself, so the sign is the one of the real determinant.
 */
export function orient3dIndexed(p: Float64Array, a: number, b: number, c: number, d: number): number {
  const [dx, dy, dz] = [p[3 * d] as number, p[3 * d + 1] as number, p[3 * d + 2] as number];
  const adx = (p[3 * a] as number) - dx;
  const ady = (p[3 * a + 1] as number) - dy;
  const adz = (p[3 * a + 2] as number) - dz;
  const bdx = (p[3 * b] as number) - dx;
  const bdy = (p[3 * b + 1] as number) - dy;
  const bdz = (p[3 * b + 2] as number) - dz;
  const cdx = (p[3 * c] as number) - dx;
  const cdy = (p[3 * c + 1] as number) - dy;
  const cdz = (p[3 * c + 2] as number) - dz;
  const det = adx * (bdy * cdz - bdz * cdy) + ady * (bdz * cdx - bdx * cdz) + adz * (bdx * cdy - bdy * cdx);
  const permanent =
    Math.abs(adx) * (Math.abs(bdy * cdz) + Math.abs(bdz * cdy)) +
    Math.abs(ady) * (Math.abs(bdz * cdx) + Math.abs(bdx * cdz)) +
    Math.abs(adz) * (Math.abs(bdx * cdy) + Math.abs(bdy * cdx));
  if (Math.abs(det) > FILTER * permanent) return sign(det);
  return orient3d(vec(p, a), vec(p, b), vec(p, c), vec(p, d));
}

/** `inSphere` of the points given by index into the packed coordinates `p`: the scalar double filter, the exact `inSphere` when the value is inside the bound. */
export function inSphereIndexed(p: Float64Array, a: number, b: number, c: number, d: number, e: number, orientation: number): number {
  const [ex, ey, ez] = [p[3 * e] as number, p[3 * e + 1] as number, p[3 * e + 2] as number];
  const aex = (p[3 * a] as number) - ex;
  const aey = (p[3 * a + 1] as number) - ey;
  const aez = (p[3 * a + 2] as number) - ez;
  const bex = (p[3 * b] as number) - ex;
  const bey = (p[3 * b + 1] as number) - ey;
  const bez = (p[3 * b + 2] as number) - ez;
  const cex = (p[3 * c] as number) - ex;
  const cey = (p[3 * c + 1] as number) - ey;
  const cez = (p[3 * c + 2] as number) - ez;
  const dex = (p[3 * d] as number) - ex;
  const dey = (p[3 * d + 1] as number) - ey;
  const dez = (p[3 * d + 2] as number) - ez;
  const ab = aex * bey - bex * aey;
  const bc = bex * cey - cex * bey;
  const cd = cex * dey - dex * cey;
  const da = dex * aey - aex * dey;
  const ac = aex * cey - cex * aey;
  const bd = bex * dey - dex * bey;
  const abc = aez * bc - bez * ac + cez * ab;
  const bcd = bez * cd - cez * bd + dez * bc;
  const cda = cez * da + dez * ac + aez * cd;
  const dab = dez * ab + aez * bd + bez * da;
  const alift = aex * aex + aey * aey + aez * aez;
  const blift = bex * bex + bey * bey + bez * bez;
  const clift = cex * cex + cey * cey + cez * cez;
  const dlift = dex * dex + dey * dey + dez * dez;
  const det = dlift * abc - clift * dab + (blift * cda - alift * bcd);
  const pab = Math.abs(aex * bey) + Math.abs(bex * aey);
  const pbc = Math.abs(bex * cey) + Math.abs(cex * bey);
  const pcd = Math.abs(cex * dey) + Math.abs(dex * cey);
  const pda = Math.abs(dex * aey) + Math.abs(aex * dey);
  const pac = Math.abs(aex * cey) + Math.abs(cex * aey);
  const pbd = Math.abs(bex * dey) + Math.abs(dex * bey);
  const permanent =
    (Math.abs(aez) * pbc + Math.abs(bez) * pac + Math.abs(cez) * pab) * dlift +
    (Math.abs(bez) * pcd + Math.abs(cez) * pbd + Math.abs(dez) * pbc) * alift +
    (Math.abs(cez) * pda + Math.abs(dez) * pac + Math.abs(aez) * pcd) * blift +
    (Math.abs(dez) * pab + Math.abs(aez) * pbd + Math.abs(bez) * pda) * clift;
  if (Math.abs(det) > FILTER * permanent) return sign(det) * orientation;
  return inSphere(vec(p, a), vec(p, b), vec(p, c), vec(p, d), vec(p, e), orientation);
}
