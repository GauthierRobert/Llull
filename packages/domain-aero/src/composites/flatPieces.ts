/** Flat pieces of a ply for cutting data: the developed chart on developable faces, the draped fishnet on doubly curved faces (06 CMP §5.7). */

import type { CompositePart, LaminaMaterial, Ply } from '@core/model/composites';
import type { Vec2 } from '@core/model/types';
import { polygonCentroid } from '@lib/polygon';
import { piecesOf } from './geometry2d';
import { flattenPolygon } from './drape/flatten';
import { drapePly } from './drape/plyDrape';
import { isDoublyCurved, fibreDirection } from './surface';

export interface FlatPiece {
  readonly index: number;
  readonly polygon: Vec2[];
  /** Unit 0-degree-referenced fibre (warp) direction in the flat frame, anchored at the piece centroid. */
  readonly fibre: Vec2;
  readonly maxShearDeg: number;
}

export type FlatPieces =
  | { readonly ok: true; readonly method: 'developed chart' | 'fishnet drape'; readonly pieces: FlatPiece[] }
  | {
      readonly ok: false;
      readonly code: 'CMP_DRAPE_LIMIT_MISSING' | 'CMP_PRODUCIBILITY_OVER_LOCK' | 'CMP_PARAM_INVALID';
      readonly message: string;
    };

/**
 * The flat pattern pieces of `ply`.
 * @invariant plane / cylinder / cone: the chart polygon itself (exact development); sphere / nurbs: each piece flattened through its own fishnet
 *   (node (i, j) -> (i d, j d), warp along +x), refused when a boundary point falls on a cell over the material locking angle unless over-lock is allowed
 * @failure no locking angle and over-lock not allowed -> CMP_DRAPE_LIMIT_MISSING; over-lock cell or a boundary off the net -> CMP_PRODUCIBILITY_OVER_LOCK; oversized net -> CMP_PARAM_INVALID
 */
export function flatPiecesOf(part: CompositePart, ply: Ply, material: LaminaMaterial | undefined, allowOverLock: boolean): FlatPieces {
  if (!isDoublyCurved(part.surface))
    return {
      ok: true,
      method: 'developed chart',
      pieces: piecesOf(ply, part).map((polygon, index) => ({
        index,
        polygon: [...polygon],
        fibre: fibreDirection(part.surface, polygonCentroid(polygon), ply.orientation),
        maxShearDeg: 0,
      })),
    };
  const allow = allowOverLock || ply.drape?.allowOverLock === true;
  const lock = material?.lockingAngle;
  if (!allow && lock === undefined)
    return {
      ok: false,
      code: 'CMP_DRAPE_LIMIT_MISSING',
      message: `material "${material?.name ?? ply.materialName}" has no lockingAngle; set it or allow over-lock flats`,
    };
  const drape = drapePly(part, ply, { limits: lock === undefined ? {} : { lock }, allowOverLock: allow });
  if (!drape.ok) return drape;
  const pieces: FlatPiece[] = [];
  for (const piece of drape.pieces) {
    const flat = flattenPolygon(piece.net, piece.piece);
    if (!flat.ok)
      return {
        ok: false,
        code: 'CMP_PRODUCIBILITY_OVER_LOCK',
        message:
          flat.reason === 'locked'
            ? `ply "${ply.name}" piece ${piece.index}: the draped boundary reaches cells over the ${lock} deg locking angle (max shear ${piece.summary.maxShearDeg.toFixed(1)} deg)`
            : `ply "${ply.name}" piece ${piece.index}: the draped net does not cover the whole boundary (the drape stopped at a locked, folded or off-face node)`,
      };
    pieces.push({ index: piece.index, polygon: flat.polygon, fibre: [1, 0], maxShearDeg: piece.summary.maxShearDeg });
  }
  return { ok: true, method: 'fishnet drape', pieces };
}
