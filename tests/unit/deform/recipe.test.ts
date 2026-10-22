import { describe, expect, it } from 'vitest';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { operandRecipe } from '@core/geometry/operandRecipe';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import type { Entity, ShapeRecipe } from '@core/model/types';
import { MESH_OUTPUT, WORLD_FRAME, deformNode, region } from './nodes';

const BOX: Entity = {
  id: 'b',
  kind: 'box',
  size: [1, 1, 1],
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  layerId: 'l',
  color: '#888',
} as Entity;
const source: ShapeRecipe = { op: 'solid', entity: BOX };
const twist = (angleRad: number): ShapeRecipe => deformNode({ kind: 'twist', angleRad }, { region: region(0, 1), source });

describe('deform recipe node', () => {
  it('hashes every input of the map, so a parameter edit changes the key and an equal node does not', () => {
    expect(recipeKey(twist(1))).toBe(recipeKey(twist(1)));
    expect(recipeKey(twist(1))).not.toBe(recipeKey(twist(1.1)));
    const moved = deformNode(
      { kind: 'twist', angleRad: 1 },
      { region: region(0, 1), source, frame: { ...WORLD_FRAME, origin: [1, 0, 0] } },
    );
    expect(recipeKey(moved)).not.toBe(recipeKey(twist(1)));
    const fine = deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 1), source, output: { ...MESH_OUTPUT, tolerance: 0.001 } });
    expect(recipeKey(fine)).not.toBe(recipeKey(twist(1)));
    expect(recipeKey(twist(1))).not.toBe(recipeKey(source));
  });

  it('validates a good node and names the fault of a bad one', () => {
    expect(validateShapeRecipe(JSON.parse(JSON.stringify(twist(1))))).toBeNull();
    const good = JSON.parse(JSON.stringify(twist(1))) as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>): string | null => validateShapeRecipe({ ...good, ...patch });
    expect(bad({ law: { kind: 'warp' } })).toContain("unknown law kind 'warp'");
    expect(bad({ law: 3 })).toContain('law must be an object');
    expect(bad({ law: { kind: 'twist', angleRad: 'x' } })).toContain('angleRad must be finite');
    expect(bad({ law: { kind: 'taper', scaleEnd: 0, flat: false } })).toContain('scaleEnd must be > 0');
    expect(bad({ law: { kind: 'stretch', factor: -1 } })).toContain('factor must be > 0');
    expect(bad({ law: { kind: 'bend', radius: 0, symmetric: false } })).toContain('radius must be > 0');
    expect(bad({ law: { kind: 'affine', matrix: [[1, 0]], translation: [0, 0, 0] } })).toContain('affine');
    expect(bad({ frame: { origin: [0, 0, 0], axis: [0, 0, 1] } })).toContain('frame needs');
    expect(bad({ region: undefined })).toContain('region is required');
    expect(bad({ region: { start: 2, end: 1, falloff: 'linear', beyond: 'rigid' } })).toContain('end > start');
    expect(bad({ region: { start: 0, end: 1, falloff: 'wavy', beyond: 'rigid' } })).toContain('falloff');
    expect(bad({ region: { start: 0, end: 1, falloff: 'none', beyond: 'rigid' } })).toContain('linear or smooth');
    expect(bad({ law: { kind: 'stretch', factor: 2 } })).toContain('falloff must be none for a stretch law');
    expect(bad({ region: { start: 0, end: 1, falloff: 'linear', beyond: 'fixed' } })).toContain('beyond');
    expect(bad({ region: 5 })).toContain('region must be an object');
    expect(bad({ output: { mode: 'auto', tolerance: 0, preserveAnalytic: false } })).toContain('tolerance > 0');
    expect(bad({ output: { mode: 'auto', tolerance: 1, preserveAnalytic: 'no' } })).toContain('preserveAnalytic');
    expect(bad({ source: { op: 'solid' } })).toContain('solid leaf needs an entity');
    const affine = {
      ...good,
      law: {
        kind: 'affine',
        matrix: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        translation: [0, 0, 0],
      },
      region: undefined,
    };
    expect(validateShapeRecipe(affine)).toBeNull();
  });
});

describe('kernel support for deform nodes', () => {
  const ops = {
    solid: () => 1,
    boolean: () => null,
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape: number) => shape,
    scale: (shape: number) => shape,
    tessellate: () => null,
    topology: () => null,
    exportStep: () => null,
    release: () => undefined,
  };

  it('a kernel without a deform op refuses the node; one with it builds the laws it names', () => {
    const none = kernelFromOps<number>(ops);
    expect(none.supports('deform')).toBe(false);
    expect(none.supportsDeform?.({ kind: 'twist', angleRad: 1 })).toBe(false);
    expect(none.evaluate(twist(1))).toBeNull();
    const affineOnly = kernelFromOps<number>({ ...ops, deform: (shape) => shape, deformLaws: new Set(['affine']) });
    expect(affineOnly.supports('deform')).toBe(true);
    expect(affineOnly.supportsDeform?.({ kind: 'twist', angleRad: 1 })).toBe(false);
    expect(
      affineOnly.supportsDeform?.({
        kind: 'affine',
        matrix: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        translation: [0, 0, 0],
      }),
    ).toBe(true);
    const all = kernelFromOps<number>({ ...ops, deform: (shape) => shape });
    expect(all.supportsDeform?.({ kind: 'bend', radius: 5, symmetric: false })).toBe(true);
    expect(all.evaluate(twist(1))).not.toBeNull();
  });

  it('a mesh entity whose recipe holds a law the kernel cannot build falls back to its stored triangles', () => {
    const mesh: Entity = {
      ...BOX,
      id: 'm',
      kind: 'mesh',
      mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
      brep: twist(1),
    } as unknown as Entity;
    const affineOnly = kernelFromOps<number>({ ...ops, deform: (shape) => shape, deformLaws: new Set(['affine']) });
    expect(operandRecipe(affineOnly, mesh).op).toBe('solid');
    const all = kernelFromOps<number>({ ...ops, deform: (shape) => shape });
    expect(operandRecipe(all, mesh).op).toBe('deform');
  });
});
