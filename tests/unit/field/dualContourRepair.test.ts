/**
 * Per-cell dual-contouring repair (05 IMP 14.10): the cells at ambiguous faces get one vertex per sheet instead of the whole body falling back to
 * marching tetrahedra. A body that dual contouring meshed cleanly before is byte-identical (pinned hashes of the meshes made before the repair existed).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FieldGrid } from '@core/geometry/field/engineTypes';
import { evaluateAt, prepareProgram } from '@core/geometry/field/interpret';
import type { FieldProgram } from '@core/geometry/field/program';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { compileField } from '@implicit/compile';

function fingerprint(positions: readonly number[], indices: readonly number[]): string {
  const view = new DataView(new ArrayBuffer(8));
  let hash = 0x811c9dc5;
  const mix = (byte: number): void => void (hash = Math.imul(hash ^ byte, 0x01000193) >>> 0);
  for (const p of positions) {
    view.setFloat64(0, p);
    for (let i = 0; i < 8; i += 1) mix(view.getUint8(i));
  }
  for (const t of indices) {
    view.setUint32(0, t);
    for (let i = 0; i < 4; i += 1) mix(view.getUint8(i));
  }
  return hash.toString(16);
}

interface Scene {
  doc: CadDocument;
  add: (name: string, params: Record<string, unknown>) => string;
}

function scene(): Scene {
  const state = { doc: createEmptyDocument() };
  return {
    get doc() {
      return state.doc;
    },
    add(name, params) {
      const result = execute(state.doc, name, params);
      if (result.error !== undefined) throw new Error(result.summary);
      state.doc = result.document;
      return result.affected[0] as string;
    },
  };
}

function program(s: Scene, id: string): FieldProgram {
  const compiled = compileField(s.doc, id);
  if (!compiled.ok) throw new Error(compiled.message);
  return compiled.program;
}

const gridOf = (p: FieldProgram, voxel: number): FieldGrid => {
  const box = p.bounds as NonNullable<FieldProgram['bounds']>;
  const pad = 2 * voxel;
  return {
    min: [box.min[0] - pad, box.min[1] - pad, box.min[2] - pad],
    max: [box.max[0] + pad, box.max[1] + pad, box.max[2] + pad],
    voxel,
  };
};

function meshOf(
  p: FieldProgram,
  grid: FieldGrid,
  mesher: 'tetra' | 'dual_contouring',
): Extract<ReturnType<typeof tsFieldEngine.mesh>, { ok: true }> {
  const result = tsFieldEngine.mesh(p, grid, { mesher, maxTriangles: 5_000_000 });
  if (!result.ok) throw new Error(result.message);
  return result;
}

function volumeOf(positions: readonly number[], indices: readonly number[]): number {
  let volume = 0;
  const at = (i: number): number[] => [positions[3 * i] as number, positions[3 * i + 1] as number, positions[3 * i + 2] as number];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [at(indices[t] as number), at(indices[t + 1] as number), at(indices[t + 2] as number)] as [
      number[],
      number[],
      number[],
    ];
    volume +=
      ((a[0] as number) * ((b[1] as number) * (c[2] as number) - (b[2] as number) * (c[1] as number)) -
        (a[1] as number) * ((b[0] as number) * (c[2] as number) - (b[2] as number) * (c[0] as number)) +
        (a[2] as number) * ((b[0] as number) * (c[1] as number) - (b[1] as number) * (c[0] as number))) /
      6;
  }
  return volume;
}

function meanAbsField(p: FieldProgram, positions: readonly number[]): number {
  const prepared = prepareProgram(p);
  const registers = new Float64Array(p.instructions.length);
  let sum = 0;
  const count = positions.length / 3;
  for (let v = 0; v < count; v += 1)
    sum += Math.abs(
      evaluateAt(prepared, registers, positions[3 * v] as number, positions[3 * v + 1] as number, positions[3 * v + 2] as number),
    );
  return sum / count;
}

describe('dual contouring: cells at ambiguous faces are repaired, everything else is untouched (05 IMP 14.10)', () => {
  const s = scene();
  const box = s.add('add_field_primitive', { shape: 'box', size: [8, 8, 8], position: [4, 4, 4] });
  const ball = s.add('add_field_primitive', { shape: 'sphere', radius: 5, position: [7, 7, 7] });
  const sharp = s.add('combine_fields', { op: 'subtract', a: box, b: ball });
  const sphere = s.add('add_field_primitive', { shape: 'sphere', radius: 3 });
  const cell = s.add('add_field_primitive', { shape: 'box', size: [12, 12, 12], position: [6, 6, 6] });
  const gyroid = s.add('add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.8, cellSize: 6, origin: [0, 0, 0], region: cell });
  const octet = s.add('add_strut_lattice', { cell: 'octet', cellSize: 6, radius: 0.4, origin: [0, 0, 0], region: cell });

  it.each([
    ['a sharp box minus a sphere', sharp, 0.4, '63c8ac0d'],
    ['a sphere', sphere, 0.3, 'a8647057'],
    ['a gyroid sheet', gyroid, 0.3, 'b3b01658'],
  ])('%s, which dual contouring meshed cleanly before the repair, is byte-identical and split no cell', (_name, id, voxel, pinned) => {
    const p = program(s, id);
    const result = meshOf(p, gridOf(p, voxel), 'dual_contouring');
    expect(result.mesher).toBe('dual_contouring');
    expect(result.splitCells).toBe(0);
    expect(fingerprint(result.mesh.positions, result.mesh.indices)).toBe(pinned);
  });

  it('an octet lattice, whose ambiguous faces made the whole body fall back to the tetrahedra, is now a closed dual-contouring mesh, ten times closer in volume', () => {
    const p = program(s, octet);
    const grid = gridOf(p, 0.25);
    const repaired = meshOf(p, grid, 'dual_contouring');
    const tetra = meshOf(p, grid, 'tetra');
    expect(repaired).toMatchObject({ mesher: 'dual_contouring', mesherFallback: false, closedManifold: true });
    expect(repaired.splitCells).toBeGreaterThan(0);
    expect(tetra.mesher).toBe('tetra');
    const reference = tsFieldEngine.measure(p, { ...grid, voxel: 0.12 }, null, { kind: 'volume', sampling: 'lowdiscrepancy' });
    if (!reference.ok || reference.kind !== 'volume') throw new Error('reference volume expected');
    const error = (positions: readonly number[], indices: readonly number[]): number =>
      Math.abs(volumeOf(positions, indices) - reference.volume);
    expect(error(repaired.mesh.positions, repaired.mesh.indices)).toBeLessThan(0.2 * error(tetra.mesh.positions, tetra.mesh.indices));
    // the QEF vertices are off the surface by a fraction of a voxel (the tetra vertices sit on edge crossings); the volume is what the repair gains
    expect(meanAbsField(p, repaired.mesh.positions)).toBeLessThan(0.1 * grid.voxel);
  });

  it('two boxes that only share an edge (ambiguous faces along it) are one closed dual-contouring mesh', () => {
    const edge = scene();
    const a = edge.add('add_field_primitive', { shape: 'box', size: [4, 4, 4], position: [1.5, 1.5, 1.5] });
    const b = edge.add('add_field_primitive', { shape: 'box', size: [4, 4, 4], position: [5.5, 5.5, 1.5] });
    const both = edge.add('combine_fields', { op: 'union', a, b });
    const p = program(edge, both);
    const result = meshOf(p, { min: [-2, -2, -2], max: [10, 10, 5], voxel: 1 }, 'dual_contouring');
    expect(result).toMatchObject({ mesher: 'dual_contouring', mesherFallback: false, closedManifold: true });
    expect(result.splitCells).toBeGreaterThan(0);
    // pins the resolution of the ambiguous face (the outside corners are cut off, the inside stays connected): the opposite rule gives 196 vertices
    expect([result.splitCells, result.mesh.indices.length / 3, result.mesh.positions.length / 3]).toEqual([5, 384, 194]);
  });

  it('a body that is still not a closed manifold after the repair falls back to the tetrahedra as a whole', () => {
    const v = scene();
    const region = v.add('add_field_primitive', { shape: 'box', size: [8, 8, 8], position: [4, 4, 4] });
    const voronoi = v.add('add_voronoi_lattice', { region, density: 0.15, seed: 4, radius: 0.35 });
    const p = program(v, voronoi);
    const result = meshOf(p, gridOf(p, 0.3), 'dual_contouring');
    expect(result).toMatchObject({ mesher: 'tetra', mesherFallback: true, closedManifold: true, splitCells: 0 });
  });
});
