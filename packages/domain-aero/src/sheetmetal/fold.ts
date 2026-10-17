/**
 * Folded solid of a sheet-metal part: flats as extrusions, bends as revolution sectors, joined in a union recipe (`brep`) and tessellated
 * in pure TS for display and mesh mass properties (flats and bends only touch face to face, so their volumes add exactly).
 */

import { DEFAULT_LAYER_ID, type CadDocument, type Entity, type MeshSolidEntity, type ShapeRecipe, type Vec3 } from '@core/model/types';
import type { SheetCutout, SheetMetalPart, SheetMetalRule } from '@core/model/sheetMetal';
import { prismMesh, placeMesh } from '@core/geometry/prismMesh';
import { orientOutward } from '@core/geometry/meshVolume';
import { solidTriangles } from '@core/geometry/solidTriangles';
import { add3, scale3 } from '@lib/vec3';
import { circleCurves } from './geometry2d';
import { bendGeometry, basisOf, bottomOffset, frameEuler } from './frames';
import { bendsOf, flatsOf } from './graph';

const SHEET_COLOR = '#9fb3c4';
/** Maximum angular step of a displayed bend sector, radians (3 degrees). */
const SECTOR_STEP = Math.PI / 60;

const leaf = (id: string, kind: 'extrusion' | 'revolution', geometry: object, position: Vec3, rotation: Vec3): Entity =>
  ({ id, kind, ...geometry, position, rotation, layerId: DEFAULT_LAYER_ID, color: SHEET_COLOR }) as Entity;

function cutoutTool(
  partId: string,
  flatId: string,
  index: number,
  cutout: SheetCutout,
  origin: Vec3,
  normal: Vec3,
  rotation: Vec3,
  thickness: number,
): ShapeRecipe {
  const margin = thickness;
  const geometry = {
    profile: cutout.points,
    depth: thickness + 2 * margin,
    ...(cutout.circle !== undefined ? { curves: circleCurves(cutout.circle.center, cutout.circle.radius) } : {}),
  };
  return {
    op: 'solid',
    entity: leaf(`${partId}:${flatId}:cut${index}`, 'extrusion', geometry, add3(origin, scale3(normal, -margin)), rotation),
  };
}

interface Piece {
  readonly recipe: ShapeRecipe;
  readonly positions: number[];
  readonly indices: number[];
}

function flatPiece(partId: string, part: SheetMetalPart, flatId: string, thickness: number, bottom: number): Piece | null {
  const flat = part.nodes[flatId];
  if (flat?.type !== 'flat') return null;
  const basis = basisOf(flat.frame);
  const position = add3(basis.origin, scale3(basis.z, bottom));
  const rotation = frameEuler(flat.frame);
  const body: ShapeRecipe = {
    op: 'solid',
    entity: leaf(`${partId}:${flat.id}`, 'extrusion', { profile: flat.outline, depth: thickness }, position, rotation),
  };
  const recipe = flat.cutouts.reduce<ShapeRecipe>(
    (acc, cutout, index) => ({
      op: 'boolean',
      boolean: 'subtract',
      a: acc,
      b: cutoutTool(partId, flat.id, index, cutout, position, basis.z, rotation, thickness),
    }),
    body,
  );
  const mesh = placeMesh(
    prismMesh(
      flat.outline,
      flat.cutouts.map((cutout) => cutout.points),
      thickness,
    ),
    position,
    rotation,
  );
  return { recipe, positions: [...mesh.positions], indices: orientOutward(mesh.positions, mesh.indices) };
}

function bendPieces(partId: string, part: SheetMetalPart, thickness: number, bottom: number): Piece[] {
  return bendsOf(part).flatMap((bend): Piece[] => {
    const parent = part.nodes[bend.from];
    if (parent?.type !== 'flat') return [];
    const { revolution } = bendGeometry(parent.frame, bend.lineInFrom, bend.angle, bend.insideRadius, thickness, bottom);
    const entity = leaf(
      `${partId}:${bend.id}`,
      'revolution',
      {
        profile: revolution.profile,
        axis: [0, 0, 1],
        angle: revolution.sweep,
        segments: Math.max(4, Math.ceil(revolution.sweep / SECTOR_STEP)),
      },
      revolution.position,
      revolution.rotation,
    );
    const positions: number[] = [];
    const indices: number[] = [];
    for (const triangle of solidTriangles(entity)) {
      const base = positions.length / 3;
      for (const corner of triangle) positions.push(...corner);
      indices.push(base, base + 1, base + 2);
    }
    return [{ recipe: { op: 'solid', entity }, positions, indices: orientOutward(positions, indices) }];
  });
}

/**
 * The derived folded-solid entity of a native part (id = part id), or null when the part has no flat.
 * @invariant `brep` is the union of every flat extrusion (cutouts subtracted) and bend revolution; `mesh` is its pure-TS tessellation
 */
export function foldPart(part: SheetMetalPart, rule: SheetMetalRule): MeshSolidEntity | null {
  const bottom = bottomOffset(part.side, rule.thickness);
  const pieces = [
    ...flatsOf(part).flatMap((flat) => flatPiece(part.id, part, flat.id, rule.thickness, bottom) ?? []),
    ...bendPieces(part.id, part, rule.thickness, bottom),
  ];
  const first = pieces[0];
  if (first === undefined) return null;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const piece of pieces) {
    const base = positions.length / 3;
    positions.push(...piece.positions);
    indices.push(...piece.indices.map((index) => index + base));
  }
  const brep = pieces
    .slice(1)
    .reduce<ShapeRecipe>((acc, piece) => ({ op: 'boolean', boolean: 'union', a: acc, b: piece.recipe }), first.recipe);
  return {
    id: part.id,
    kind: 'mesh',
    mesh: { positions, indices },
    brep,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color: SHEET_COLOR,
    name: `Sheet metal ${part.id}`,
    tags: ['sheetmetal', `sheetpart:${part.id}`],
  };
}

/** Document with the folded solid of `part` (re-)derived into `entities` / `order` (kept in place when it already exists). */
export function withFoldedSolid(doc: CadDocument, part: SheetMetalPart, rule: SheetMetalRule): CadDocument {
  const entity = foldPart(part, rule);
  if (entity === null) return doc;
  const fallbackLayer = doc.layers[DEFAULT_LAYER_ID] !== undefined ? DEFAULT_LAYER_ID : (doc.layerOrder[0] ?? DEFAULT_LAYER_ID);
  const layerId = part.layerId !== undefined && doc.layers[part.layerId] !== undefined ? part.layerId : fallbackLayer;
  const placed = { ...entity, layerId, ...(part.materialId === undefined ? {} : { materialId: part.materialId }) };
  return {
    ...doc,
    entities: { ...doc.entities, [part.id]: placed },
    order: doc.order.includes(part.id) ? doc.order : [...doc.order, part.id],
  };
}
