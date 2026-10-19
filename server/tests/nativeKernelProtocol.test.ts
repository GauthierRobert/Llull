/** Wire vocabulary of the native `llull-kernel` sidecar (RS-1): framing, mesh decoding and the recipe rewrites made for it. */

import { describe, expect, it } from 'vitest';
import type { Entity, ShapeRecipe } from '@core/model/types';
import { recipeKey } from '@core/geometry/shapeRecipe';
import {
  decodeMesh,
  encodeRequest,
  isUnsupported,
  nativeArgs,
  nativeRecipe,
  parseNativeInfo,
  parseReplyLine,
} from '../src/native/kernelProtocol';
import { box, common, leaf } from './kernelTestSupport';

const base64 = (view: Float64Array | Uint32Array): string => Buffer.from(view.buffer).toString('base64');

describe('native kernel framing', () => {
  it('writes one JSON line per request and reads replies by id', () => {
    expect(encodeRequest(3, 'evaluate', [1])).toBe('{"id":3,"op":"evaluate","args":[1]}\n');
    expect(parseReplyLine('{"id":3,"result":{"key":"k"}}')).toEqual({ id: 3, result: { key: 'k' } });
    expect(parseReplyLine('{"id":4,"result":null,"error":"NATIVE_UNSUPPORTED: op \'x\'"}')?.error).toMatch(/^NATIVE_UNSUPPORTED/);
  });

  it.each(['OCCT banner', '', '[1,2]', '{"result":1}', '{"id":"7","result":1}', 'null'])('ignores the non-reply line %j', (line) => {
    expect(parseReplyLine(line)).toBeNull();
  });

  it('classifies the fallback error code', () => {
    expect(isUnsupported("NATIVE_UNSUPPORTED: recipe op 'fillet'")).toBe(true);
    expect(isUnsupported('NATIVE_OCC_FAILURE: Standard_DomainError')).toBe(false);
    expect(isUnsupported(undefined)).toBe(false);
  });

  it('reads the info handshake and refuses a malformed one', () => {
    const info = { occtVersion: '7.9.2', build: 'llull-kernel@0.1.0', capabilities: ['analyze'], ops: ['info', 'evaluate'] };
    expect(parseNativeInfo(info)).toEqual(info);
    expect(parseNativeInfo({ ...info, ops: [1] })).toBeNull();
    expect(parseNativeInfo(null)).toBeNull();
  });
});

describe('decodeMesh', () => {
  it('turns base64 little-endian arrays into plain number arrays', () => {
    const positions = new Float64Array([0, 1.5, -2.25, 1e-9, 3, 4]);
    const indices = new Uint32Array([0, 1, 0]);
    const mesh = decodeMesh({ encoding: 'base64-le', positions: base64(positions), indices: base64(indices) });
    expect(mesh).toEqual({ positions: [...positions], indices: [0, 1, 0] });
    expect(Array.isArray(mesh?.positions)).toBe(true);
  });

  it('passes null through and rejects other encodings or truncated arrays', () => {
    expect(decodeMesh(null)).toBeNull();
    expect(decodeMesh({ encoding: 'json', positions: [], indices: [] })).toBeNull();
    expect(() => decodeMesh({ encoding: 'base64-le', positions: Buffer.from([1, 2, 3]).toString('base64'), indices: '' })).toThrow(
      /truncated/,
    );
  });
});

describe('nativeArgs / nativeRecipe', () => {
  const cube = leaf(box([0, 0, 0], [2, 2, 2]));

  it('sends evaluate as a handle keyed by the host recipe key', () => {
    expect(nativeArgs('evaluate', [cube])).toEqual([{ key: recipeKey(cube), recipe: cube }]);
  });

  it('keeps key-only handles and rewrites full ones, also inside exportStep', () => {
    expect(nativeArgs('tessellate', [{ key: 'k' }])).toEqual([{ key: 'k' }]);
    expect(nativeArgs('massProperties', [{ key: 'k', recipe: cube }])).toEqual([{ key: 'k', recipe: cube }]);
    expect(nativeArgs('exportStep', [[{ key: 'a' }, { key: 'b', recipe: cube }]])).toEqual([[{ key: 'a' }, { key: 'b', recipe: cube }]]);
    expect(nativeArgs('distance', [{ key: 'a' }, { key: 'b' }, 5])).toEqual([{ key: 'a' }, { key: 'b' }, 5]);
  });

  it('rewrites the shape handles of topology, every face query and both distance operands', () => {
    expect(nativeArgs('topology', [{ key: 't', recipe: cube }])).toEqual([{ key: 't', recipe: cube }]);
    expect(nativeArgs('faceQuery.projectOnFace', [{ key: 'f' }, 2, [[0, 0, 0]]])).toEqual([{ key: 'f' }, 2, [[0, 0, 0]]]);
    const tangent: ShapeRecipe = leaf({
      id: 'p',
      kind: 'pyramid',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      baseWidth: 1,
      baseDepth: 1,
      height: 1,
      ...common,
    } as Entity);
    const [rewritten] = nativeArgs('faceQuery.faceGraph', [{ key: 'p', recipe: tangent }]) as [{ recipe: ShapeRecipe }];
    expect(rewritten.recipe.op === 'solid' && rewritten.recipe.entity.kind).toBe('mesh');
    const [, second] = nativeArgs('distance', [{ key: 'a' }, { key: 'p', recipe: tangent }, 5]) as [
      unknown,
      { recipe: ShapeRecipe },
      number,
    ];
    expect(second.recipe.op === 'solid' && second.recipe.entity.kind).toBe('mesh');
  });

  it('flattens assembly parts to indices so a shared part stays one product', () => {
    const bolt = { shapes: [{ key: 'bolt' }] };
    const bracket = { shapes: [{ key: 'bracket', recipe: cube }], children: [{ part: bolt, position: [1, 0, 0], rotation: [0, 0, 0] }] };
    const occurrences = [
      { part: bracket, position: [0, 0, 0], rotation: [0, 0, 0] },
      { part: bolt, position: [5, 0, 0], rotation: [0, 0, 1] },
      { part: bracket, position: [9, 0, 0], rotation: [0, 0, 0] },
    ];
    expect(nativeArgs('exportStepAssembly', [occurrences])).toEqual([
      {
        parts: [
          { shapes: [{ key: 'bracket', recipe: cube }], children: [{ part: 1, position: [1, 0, 0], rotation: [0, 0, 0] }] },
          { shapes: [{ key: 'bolt' }], children: [] },
        ],
        occurrences: [
          { part: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
          { part: 1, position: [5, 0, 0], rotation: [0, 0, 1] },
          { part: 0, position: [9, 0, 0], rotation: [0, 0, 0] },
        ],
      },
    ]);
    expect(nativeArgs('importShapes', ['step', 'text', { heal: true }])).toEqual(['step', 'text', { heal: true }]);
  });

  it('sends a pyramid as the sewn triangles the WASM kernel builds it from', () => {
    const pyramid = {
      id: 'p',
      kind: 'pyramid',
      position: [1, 2, 3],
      rotation: [0, 0, 0],
      baseWidth: 2,
      baseDepth: 2,
      height: 3,
      ...common,
    } as Entity;
    const rewritten = nativeRecipe(leaf(pyramid));
    expect(rewritten.op === 'solid' && rewritten.entity.kind).toBe('mesh');
    const mesh = rewritten.op === 'solid' && rewritten.entity.kind === 'mesh' ? rewritten.entity.mesh : null;
    expect(mesh?.indices.length).toBe(18); // 4 sides + a 2-triangle base
    expect(Math.min(...(mesh?.positions.filter((_, index) => index % 3 === 2) ?? []))).toBeCloseTo(3);
  });

  it('applies the tangent-sphere guard to boolean operands, deep in the tree', () => {
    const sphere = { id: 's', kind: 'sphere', position: [0, 0, 2], rotation: [0, 0, 0], radius: 1, ...common } as Entity;
    const tangent: ShapeRecipe = { op: 'boolean', boolean: 'union', a: cube, b: leaf(sphere) };
    const placed: ShapeRecipe = { op: 'place', source: tangent, position: [0, 0, 0], rotation: [0, 0, 0] };
    const rewritten = nativeRecipe(placed);
    const operand = rewritten.op === 'place' && rewritten.source.op === 'boolean' ? rewritten.source.b : null;
    expect(operand?.op === 'solid' && operand.entity.kind === 'sphere' && operand.entity.radius).toBeLessThan(1);
    expect(nativeRecipe(cube)).toBe(cube);
    const blend: ShapeRecipe = { op: 'blend', sources: [cube, cube], radius: 0.1 };
    expect(nativeRecipe(blend)).toEqual(blend);
  });
});
