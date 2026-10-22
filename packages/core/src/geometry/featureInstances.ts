/**
 * Holes and pockets of a part as the queries (`hole_table`, `check_machining`, drawings) see them, read from the `feature` nodes of its
 * recipe — the single source of truth, so they survive later fillets / booleans — or filled from exact recognition for imported parts.
 * @invariant ids are `hole-<node>.<k>` / `pocket-<node>`: node = ordinal of the feature node in recipe order (source first), k = point index
 */

import type { ShapeRecipe, Vec2, Vec3 } from '../model/types';
import type { FeatureFrame, HoleKind, ThreadSpec } from '../model/features';
import { countersinkDepth } from '../lib/holeMath';
import { frameToWorld } from './featureFrame';
import type { FeatureRecipe } from './featureLowering';

/** The `feature` nodes of `recipe`, source-most first (what a boolean subtract keeps: its minuend only). */
export function featureNodes(recipe: ShapeRecipe): FeatureRecipe[] {
  switch (recipe.op) {
    case 'feature':
      return [...featureNodes(recipe.source), recipe];
    case 'boolean':
      return recipe.boolean === 'subtract' ? featureNodes(recipe.a) : [...featureNodes(recipe.a), ...featureNodes(recipe.b)];
    case 'blend':
      return recipe.sources.flatMap(featureNodes);
    case 'fillet':
    case 'chamfer':
    case 'shell':
    case 'place':
    case 'scale':
    case 'faceOp':
    case 'emboss':
      return featureNodes(recipe.source);
    case 'solid':
    case 'brep':
    case 'faceSlab':
    case 'deform':
      return [];
  }
}

export interface MachinedHole {
  readonly id: string;
  readonly kind: HoleKind;
  readonly diameter: number;
  readonly cboreDiameter?: number;
  readonly cboreDepth?: number;
  readonly cskDiameter?: number;
  /** Included angle, degrees. */
  readonly cskAngle?: number;
  readonly cskDepth?: number;
  /** Cylindrical depth from the face of a blind hole (the drill point comes on top). */
  readonly depth?: number;
  readonly through: boolean;
  readonly thread?: ThreadSpec;
  readonly drillPointAngle?: { readonly value: number; readonly defaulted: boolean };
  /** Frame of the entrance plane: normal = outward; the axis runs along -normal. */
  readonly frame: FeatureFrame;
  /** Hole centre on the entrance plane. */
  readonly position: Vec3;
  readonly point: Vec2;
}

export interface MachinedPocket {
  readonly id: string;
  readonly cornerRadius: number;
  readonly floorFillet: number;
  readonly depth: number | 'through';
  readonly toolDiameter?: number;
  readonly frame: FeatureFrame;
}

function holesOf(node: Extract<FeatureRecipe, { feature: 'hole' }>, ordinal: number): MachinedHole[] {
  const { hole, extent } = node;
  const coneBore = hole.kind === 'counterdrill' ? (hole.cboreDiameter ?? hole.diameter) : hole.diameter;
  const cskDepth =
    (hole.kind === 'countersink' || hole.kind === 'counterdrill') && hole.cskDiameter !== undefined && hole.cskAngle !== undefined
      ? countersinkDepth(coneBore, hole.cskDiameter, hole.cskAngle).value
      : undefined;
  const tip =
    extent.kind === 'blind' && extent.drillPointAngle !== undefined
      ? { value: extent.drillPointAngle, defaulted: extent.drillPointDefaulted === true }
      : undefined;
  return node.points.map((point, k) => ({
    id: `hole-${ordinal}.${k}`,
    kind: hole.kind,
    diameter: hole.diameter,
    ...(hole.cboreDiameter === undefined ? {} : { cboreDiameter: hole.cboreDiameter }),
    ...(hole.cboreDepth === undefined ? {} : { cboreDepth: hole.cboreDepth }),
    ...(hole.cskDiameter === undefined ? {} : { cskDiameter: hole.cskDiameter }),
    ...(hole.cskAngle === undefined ? {} : { cskAngle: hole.cskAngle }),
    ...(cskDepth === undefined ? {} : { cskDepth }),
    ...(extent.kind === 'through_all' ? {} : { depth: extent.depth }),
    through: extent.kind === 'through_all',
    ...(hole.thread === undefined ? {} : { thread: hole.thread }),
    ...(tip === undefined ? {} : { drillPointAngle: tip }),
    frame: node.frame,
    position: frameToWorld(node.frame, point),
    point,
  }));
}

/** Holes and pockets authored by `add_hole` / `add_pocket` in `recipe`, in recipe order. */
export function authoredFeatures(recipe: ShapeRecipe): { holes: MachinedHole[]; pockets: MachinedPocket[] } {
  const holes: MachinedHole[] = [];
  const pockets: MachinedPocket[] = [];
  featureNodes(recipe).forEach((node, ordinal) => {
    if (node.feature === 'hole') holes.push(...holesOf(node, ordinal));
    else if (node.feature === 'pocket')
      pockets.push({
        id: `pocket-${ordinal}`,
        cornerRadius: node.pocket.cornerRadius,
        floorFillet: node.pocket.floorFillet,
        depth: node.pocket.depth,
        ...(node.pocket.toolDiameter === undefined ? {} : { toolDiameter: node.pocket.toolDiameter }),
        frame: node.frame,
      });
  });
  return { holes, pockets };
}

/**
 * `recipe` with the `ordinal`-th feature node (order of `featureNodes`) replaced by `edit(node)`; every other node is kept as is.
 */
export function editFeatureNode(recipe: ShapeRecipe, ordinal: number, edit: (node: FeatureRecipe) => FeatureRecipe): ShapeRecipe {
  const counter = { next: 0 };
  const visit = (node: ShapeRecipe): ShapeRecipe => {
    switch (node.op) {
      case 'feature': {
        const rewritten: FeatureRecipe = { ...node, source: visit(node.source) };
        return counter.next++ === ordinal ? edit(rewritten) : rewritten;
      }
      case 'boolean': {
        const a = visit(node.a);
        return { ...node, a, b: node.boolean === 'subtract' ? node.b : visit(node.b) };
      }
      case 'blend':
        return { ...node, sources: node.sources.map(visit) };
      case 'fillet':
      case 'chamfer':
      case 'shell':
      case 'place':
      case 'scale':
      case 'faceOp':
      case 'emboss':
        return { ...node, source: visit(node.source) };
      case 'solid':
      case 'brep':
      case 'faceSlab':
      case 'deform':
        return node;
    }
  };
  return visit(recipe);
}
