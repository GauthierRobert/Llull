/** 12 CFD M1: the pure building blocks of prepare_cfd_case — regime, domain sizing, estimate, weld, edge topology, voxel cast, symmetry, intersections. */
import { describe, expect, it } from 'vitest';
import type { CfdCase } from '@core/model/cfd';
import { sizeDomain, blockageRatio, boxContains } from '@aero/cfd/domainSizing';
import { estimateCase } from '@aero/cfd/memoryEstimate';
import { resolveFlow } from '@aero/cfd/regime';
import { findSelfIntersections } from '@aero/cfd/selfIntersection';
import { findSmallFeatures } from '@aero/cfd/smallFeatures';
import { isMirrorSymmetric } from '@aero/cfd/symmetry';
import { edgeReport, flipped, signedVolume, surfaceArea, surfaceBounds } from '@aero/cfd/topology';
import { frontalArea, voxelise } from '@aero/cfd/voxel';
import { weldSurface, type IndexedSurface } from '@aero/cfd/weld';
import { axesAreIndependent, caseFrame, toCaseFrame } from '@aero/cfd/frame';
import { boxMesh } from './fixtures';

const surfaceOfBox = (min: [number, number, number], size: [number, number, number]): IndexedSurface => {
  const mesh = boxMesh(min, size);
  return { vertices: mesh.positions, triangles: mesh.indices };
};

const flow = (freestream: CfdCase['freestream'], extra: Partial<Pick<CfdCase, 'regime' | 'solver'>> = {}): ReturnType<typeof resolveFlow> =>
  resolveFlow({ regime: 'auto', freestream, ...extra });

describe('resolveFlow', () => {
  it('derives Mach from speed and speed from Mach with the standard atmosphere or a given air state', () => {
    const sea = flow({ speedMS: 340.294, alphaDeg: 0, betaDeg: 0 });
    expect(sea.ok && sea.state.machNumber).toBeCloseTo(1, 3);
    const air = flow({ mach: 2, air: { densityKgM3: 1.2, temperatureK: 250, viscosityPaS: 1.6e-5 }, alphaDeg: 0, betaDeg: 0 });
    expect(air.ok && air.state.speedMS).toBeCloseTo(2 * Math.sqrt(1.4 * 287.05 * 250), 0);
    expect(air.ok && air.state.airSource).toBe('given air state');
    const high = flow({ mach: 3, altitudeM: 20000, alphaDeg: 0, betaDeg: 0 });
    expect(high.ok && high.state.regime).toBe('compressible');
    expect(high.ok && high.state.temperatureK).toBeCloseTo(216.65, 2);
  });

  it('refuses incomplete, conflicting and out-of-range input', () => {
    const base = { alphaDeg: 0, betaDeg: 0 };
    const code = (result: ReturnType<typeof resolveFlow>): string => (result.ok ? 'ok' : result.code);
    expect(code(flow({ ...base }))).toBe('CFD_PARAM_INVALID');
    expect(code(flow({ ...base, mach: 1, speedMS: 1 }))).toBe('CFD_PARAM_INVALID');
    expect(code(flow({ ...base, mach: -1 }))).toBe('CFD_PARAM_INVALID');
    expect(code(flow({ ...base, mach: 1, altitudeM: 0, air: { densityKgM3: 1, temperatureK: 300, viscosityPaS: 1e-5 } }))).toBe(
      'CFD_PARAM_INVALID',
    );
    expect(code(flow({ ...base, mach: 1, air: { densityKgM3: 1, temperatureK: 0, viscosityPaS: 1e-5 } }))).toBe('CFD_PARAM_INVALID');
    expect(code(flow({ ...base, mach: 1, altitudeM: 1e6 }))).toBe('CFD_PARAM_INVALID');
    expect(code(flow({ ...base, mach: 5.5 }))).toBe('CFD_REGIME_MISMATCH');
    expect(code(flow({ ...base, mach: 0.1 }, { regime: 'compressible' }))).toBe('CFD_REGIME_MISMATCH');
    expect(code(flow({ ...base, mach: 0.1 }, { solver: 'euler' }))).toBe('CFD_REGIME_MISMATCH');
    expect(code(flow({ ...base, mach: 0.1 }, { regime: 'low_speed', solver: 'lbm' }))).toBe('ok');
  });
});

describe('case frame', () => {
  it('is right-handed and orthonormal; parallel or zero axes are not a frame', () => {
    const frame = caseFrame([0, 1, 0], [0, 0, 1]);
    expect(frame.y).toEqual([-1, 0, 0]);
    expect(toCaseFrame(frame, [1, 2, 3])).toEqual([2, -1, 3]);
    expect(axesAreIndependent([1, 0, 0], [0, 0, 1])).toBe(true);
    expect(axesAreIndependent([1, 0, 0], [3, 0, 0])).toBe(false);
    expect(axesAreIndependent([0, 0, 0], [0, 0, 1])).toBe(false);
    expect(axesAreIndependent([1, 0, 0], [0, 0, 0])).toBe(false);
  });
});

describe('sizeDomain', () => {
  const body = { min: [0, 0, 0] as const, max: [2, 1, 1] as const };
  const none = { ground: { enabled: false, moving: false } };

  it('keeps a custom box and halves a symmetric domain', () => {
    const custom = sizeDomain({ ...none, domain: { rule: 'custom', box: { min: [-1, -2, -3], max: [4, 5, 6] } } }, body, 0.1);
    expect(custom.box).toEqual({ min: [-1, -2, -3], max: [4, 5, 6] });
    expect(sizeDomain({ ...none, domain: { rule: 'custom' } }, body, 0.1).box).toEqual(body);
    const half = sizeDomain(
      { ...none, domain: { rule: 'custom', box: { min: [-1, -2, -3], max: [4, 5, 6] }, symmetryPlane: 'xz' } },
      body,
      0.1,
    );
    expect(half.box.min[1]).toBe(0);
    expect(half.box.max[1]).toBe(5);
  });

  it('supersonic with a ground plane pins the bottom to the lowest point', () => {
    const sized = sizeDomain({ domain: { rule: 'external_aero' }, ground: { enabled: true, moving: false } }, body, 3);
    expect(sized.box.min[2]).toBe(0);
    expect(sized.defaults[0]?.source).toContain('supersonic');
  });

  it('blockage divides by the cross-section, doubled for a half domain; infinite for a flat one', () => {
    const box = { min: [0, 0, 0] as const, max: [10, 4, 5] as const };
    expect(blockageRatio(1, box, false)).toBeCloseTo(0.05, 12);
    expect(blockageRatio(1, box, true)).toBeCloseTo(0.025, 12);
    expect(blockageRatio(1, { min: [0, 0, 0], max: [1, 0, 1] }, false)).toBe(Infinity);
    expect(boxContains(box, { min: [1, 1, 1], max: [2, 2, 2] })).toBe(true);
    expect(boxContains(box, { min: [-1, 1, 1], max: [2, 2, 2] })).toBe(false);
  });
});

describe('estimateCase', () => {
  const input = {
    referenceLengthM: 1,
    domain: { min: [-5, -5, -5] as const, max: [20, 6, 6] as const },
    body: { min: [0, 0, 0] as const, max: [1, 1, 1] as const },
    surfaceAreaM2: 6,
  };

  it('grows with the grid, scales bytes per solver and reports the time as an estimate', () => {
    const coarse = estimateCase({ ...input, solver: 'lbm', cellsPerReferenceLength: 32 });
    const fine = estimateCase({ ...input, solver: 'lbm', cellsPerReferenceLength: 64 });
    expect(fine.cells / coarse.cells).toBeGreaterThan(7);
    expect(coarse.bytes).toBe(coarse.cells * 96);
    expect(estimateCase({ ...input, solver: 'euler', cellsPerReferenceLength: 64 }).bytesPerCell).toBe(144);
    expect(coarse.timeEstimateS).toBeGreaterThan(0);
    expect(coarse.basis.join(' ')).toContain('not measured');
    expect(coarse.fitsDevice).toBeNull();
  });

  it('finds the largest resolution that fits, 0 when nothing does', () => {
    const limited = estimateCase({ ...input, solver: 'lbm', cellsPerReferenceLength: 128, deviceMemoryBytes: 2e9 });
    const largest = limited.largestFittingCellsPerReferenceLength as number;
    expect(limited.fitsDevice).toBe(false);
    const at = estimateCase({ ...input, solver: 'lbm', cellsPerReferenceLength: largest, deviceMemoryBytes: 2e9 });
    const next = estimateCase({ ...input, solver: 'lbm', cellsPerReferenceLength: largest + 1, deviceMemoryBytes: 2e9 });
    expect(at.fitsDevice).toBe(true);
    expect(next.fitsDevice).toBe(false);
    expect(
      estimateCase({ ...input, solver: 'euler', cellsPerReferenceLength: 64, deviceMemoryBytes: 10 }).largestFittingCellsPerReferenceLength,
    ).toBe(0);
    const roomy = estimateCase({ ...input, solver: 'euler', cellsPerReferenceLength: 64, deviceMemoryBytes: 1e13 });
    expect(roomy.fitsDevice).toBe(true);
    expect(roomy.largestFittingCellsPerReferenceLength).toBeNull();
  });
});

describe('weld and topology', () => {
  it('welds vertices across a hash-cell border and drops degenerate triangles', () => {
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1e-10, 0.9999999999, 0, 0, 0, 1, 0, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    const welded = weldSurface(positions, [0, 1, 2, 3, 4, 5, 6, 7, 8], 1e-6, 1e-12);
    expect(welded.vertices).toHaveLength(12);
    expect(welded.triangles).toEqual([0, 1, 2, 0, 1, 2]);
    expect(welded.degenerate).toBe(1);
    expect(weldSurface([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], 0, 0).triangles).toEqual([0, 1, 2]);
  });

  it('classifies open, non-manifold and misoriented edges and measures volume, area, bounds', () => {
    const box = surfaceOfBox([0, 0, 0], [1, 2, 3]);
    expect(edgeReport(box)).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    expect(signedVolume(box)).toBeCloseTo(6, 12);
    expect(signedVolume(flipped(box))).toBeCloseTo(-6, 12);
    expect(surfaceArea(box)).toBeCloseTo(22, 12);
    expect(surfaceBounds(box)).toEqual({ min: [0, 0, 0], max: [1, 2, 3] });
    const fin = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1], triangles: [0, 1, 2, 1, 0, 3, 0, 1, 4, 1, 0, 5] };
    expect(edgeReport(fin).nonManifoldEdges).toBe(1);
    const open = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2] };
    expect(edgeReport(open).openAt).toHaveLength(3);
  });
});

describe('voxel cast and frontal area', () => {
  const box = surfaceOfBox([0, 0, 0], [1, 1, 1]);

  it('counts the cells of a box exactly and the silhouette of a unit cube', () => {
    expect(voxelise(box, [0, 0, 0], [1, 1, 1], 0.25)?.cells).toBe(64);
    expect(voxelise(box, [0, 0, 0], [1, 1, 1], 0.25)?.volumeM3).toBeCloseTo(1, 12);
    expect(frontalArea(box, [0, 0, 0], [1, 1, 1])).toBeCloseTo(1, 9);
    expect(frontalArea(box, [0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it('skips odd rows of an open surface and refuses grids with too many rows', () => {
    const open = { vertices: box.vertices, triangles: box.triangles.slice(0, 30) };
    const report = voxelise(open, [0, 0, 0], [1, 1, 1], 0.25);
    expect(report?.oddRows).toBeGreaterThan(0);
    expect(voxelise(box, [0, 0, 0], [1, 1, 1], 1e-4)).toBeNull();
    expect(frontalArea(box, [0, 0, 0], [1, 1, 1], 1e6)).toBeNull();
  });
});

describe('symmetry and intersections', () => {
  it('detects mirror symmetry about y = 0 within a tolerance', () => {
    expect(isMirrorSymmetric(surfaceOfBox([0, -1, 0], [1, 2, 1]), 1e-6)).toBe(true);
    expect(isMirrorSymmetric(surfaceOfBox([0, 0, 0], [1, 2, 1]), 1e-6)).toBe(false);
    expect(isMirrorSymmetric(surfaceOfBox([0, -1, 0], [1, 2, 1]), 0)).toBe(true);
  });

  it('finds a crossing triangle pair and skips neighbours', () => {
    const crossing = { vertices: [0, 0, 0, 2, 0, 0, 0, 2, 0, 1, 1, -1, 1, 1, 1, 1.5, 1.5, 0], triangles: [0, 1, 2, 3, 4, 5] };
    const report = findSelfIntersections(crossing);
    expect(report?.pairs).toBe(1);
    expect(report?.examples[0]?.triangles).toEqual([0, 1]);
    expect(findSelfIntersections(surfaceOfBox([0, 0, 0], [1, 1, 1]))?.pairs).toBe(0);
  });
});

describe('findSmallFeatures', () => {
  it('has no attribution without a matching body and finds nothing on a large box', () => {
    const plate = surfaceOfBox([0, 0, 0], [1, 1, 0.01]);
    const found = findSmallFeatures(plate, 0.01, () => null);
    expect(found.features[0]?.entityId).toBeNull();
    expect(found.total).toBeGreaterThan(0);
    expect(findSmallFeatures(surfaceOfBox([0, 0, 0], [1, 1, 1]), 0.01, () => 'b').total).toBe(0);
  });
});
