/**
 * The `measures` of a native mesh job report (PERF1 row 8): taken only when the report carries both `volume` and `area` as numbers. An older
 * binary (fields absent), a non-finite figure (written as null) or a half report gives no `measures`, and the implicit plugin then measures the
 * mesh in TypeScript, NaN included.
 */

import { describe, expect, it } from 'vitest';
import type { FieldMeshResult } from '@core/geometry/field/engineTypes';
import type { MeshData } from '@core/model/types';
import { bodyMeshMeasuresOf, rememberMeshResult } from '@implicit/meshFacts';
import { meshMeasures } from '@lib/isosurface/measures';
import { measuresOfReport } from '../src/native/fieldEngine';

const tetrahedron = (corner: number): MeshData => ({
  positions: [corner, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
});

const resultOf = (mesh: MeshData, report: Record<string, unknown>): FieldMeshResult => ({
  ok: true,
  mesh,
  closedManifold: true,
  ...measuresOfReport(report),
  samples: 0,
  evaluatedSamples: 0,
  prunedFraction: 0,
  maxVertexResidual: 0,
  nonFiniteSamples: 0,
  mesher: 'tetra',
  mesherFallback: false,
  provenance: { engine: 'llull-field', device: 'cpu', deterministic: true, voxel: 1 },
});

describe('measuresOfReport', () => {
  it('takes volume and area when both are numbers', () => {
    expect(measuresOfReport({ volume: 2.5, area: 7, closedManifold: true })).toEqual({ measures: { volume: 2.5, area: 7 } });
  });

  const partial: Array<[string, Record<string, unknown>]> = [
    ['an older binary (no fields)', { closedManifold: true }],
    ['non-finite figures (null)', { volume: null, area: null }],
    ['only the volume', { volume: 2.5 }],
    ['only the area', { area: 7 }],
    ['a null area', { volume: 2.5, area: null }],
  ];
  for (const [label, report] of partial) {
    it(`gives no measures for ${label}; the mesh is then measured in TypeScript`, () => {
      expect(measuresOfReport(report)).not.toHaveProperty('measures');
      const mesh = tetrahedron(0);
      rememberMeshResult(resultOf(mesh, report));
      expect(bodyMeshMeasuresOf(mesh)).toEqual(meshMeasures(mesh));
    });
  }

  it('a mesh with a non-finite vertex (the binary writes null) is measured in TypeScript: NaN, not a number from the report', () => {
    const mesh = tetrahedron(NaN);
    rememberMeshResult(resultOf(mesh, { volume: null, area: null }));
    const measured = bodyMeshMeasuresOf(mesh);
    expect(measured).toEqual(meshMeasures(mesh));
    expect(measured.volume).toBeNaN();
  });
});
