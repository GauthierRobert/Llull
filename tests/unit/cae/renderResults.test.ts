import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { meshSkin } from '@cae/results/fieldSurface';
import { bandLevels, resultColor, triangleBands } from '@lib/isoBands';
import { surfacePayload } from '@cae/results/surfacePayload';
import { solvedBar, type SolvedBar } from './deckFixtures';
import { solvedWall } from './thermal/solved';

const ctxOf = (bar: SolvedBar): ExecutionContext => ({ ...defaultContext(), feaArtifacts: bar.port });

function recorded(bar: SolvedBar): CadDocument {
  const context = ctxOf(bar);
  const meshed = execute(bar.doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(bar.mesh, bar.meshHash) }, context);
  return execute(
    meshed.document,
    'record_fea_results',
    { analysisId: bar.analysisId, summary: resultsSummary(bar.doc, bar.analysisId, bar.mesh, bar.results, bar.resultsHash) },
    context,
  ).document;
}

interface PlotData {
  svg: string;
  field: string;
  unit: string;
  min: { value: number; at: Vec3 };
  max: { value: number; at: Vec3 };
  deformationScale: number;
  levels: number[];
  trianglesDrawn: number;
  resultSet: { label: string; time: number };
}

const codeOf = (result: { error?: { code: string } }): string | undefined => result.error?.code;

describe('render_fea_results', () => {
  const bar = solvedBar();
  const solved = recorded(bar);

  it('paints the von Mises contour of a solved static case with legend, extremes and supports, without changing the document', () => {
    const before = JSON.stringify(solved);
    const result = execute(solved, 'render_fea_results', { analysisId: bar.analysisId }, ctxOf(bar));
    expect(result.document).toBe(solved);
    expect(JSON.stringify(solved)).toBe(before);
    expect(result.affected).toEqual([]);
    const data = result.data as PlotData;
    expect(data.field).toBe('von_mises');
    expect(data.unit).toBe('MPa');
    expect(data.max.value).toBeCloseTo(210, 3);
    expect(data.levels).toHaveLength(13);
    expect(data.deformationScale).toBeGreaterThan(0);
    expect(data.trianglesDrawn).toBeGreaterThan(0);
    expect(data.svg.startsWith('<svg')).toBe(true);
    expect(data.svg).toContain('MAX 210');
    expect(data.svg).toContain('x0 (');
    expect(result.summary).toMatch(/von_mises \(load case LC1\) — min .* MPa, max 210 MPa/);
  });

  it('honours field, view, direction, range, bands, mesh edges and an explicit deformation scale', () => {
    const custom = execute(
      solved,
      'render_fea_results',
      {
        analysisId: bar.analysisId,
        field: 'u_x',
        direction: [0, -1, 0.2],
        range: [0, 0.004],
        bands: 4,
        showMesh: true,
        deformationScale: 0,
      },
      ctxOf(bar),
    );
    const data = custom.data as PlotData;
    expect(data.field).toBe('u_x');
    expect(data.unit).toBe('mm');
    expect(data.levels).toEqual([0, 0.001, 0.002, 0.003, 0.004]);
    expect(data.deformationScale).toBe(0);
    const plain = execute(
      solved,
      'render_fea_results',
      { analysisId: bar.analysisId, field: 'u_x', direction: [0, -1, 0.2], range: [0, 0.004], bands: 4, deformationScale: 0 },
      ctxOf(bar),
    );
    expect(data.svg).toContain('<image');
    expect(data.svg).not.toBe((plain.data as PlotData).svg);
    expect(custom.summary).toContain('undeformed');
    const top = execute(solved, 'render_fea_results', { analysisId: bar.analysisId, view: 'top', direction: [0, 0, 0] }, ctxOf(bar));
    expect((top.data as PlotData).trianglesDrawn).toBeGreaterThan(0);
  });

  it('refuses unknown analyses, unsolved cases, unknown load cases and fields the results do not hold', () => {
    const ctx = ctxOf(bar);
    expect(codeOf(execute(solved, 'render_fea_results', { analysisId: 'an-404' }, ctx))).toBe('FEA_ANALYSIS_NOT_FOUND');
    const unsolved = execute(bar.doc, 'render_fea_results', { analysisId: bar.analysisId }, ctx);
    expect(codeOf(unsolved)).toBe('FEA_RESULTS_MISSING');
    expect(unsolved.document).toBe(bar.doc);
    const noStore = execute(solved, 'render_fea_results', { analysisId: bar.analysisId });
    expect(codeOf(noStore)).toBe('FEA_RESULTS_MISSING');
    const badCase = execute(solved, 'render_fea_results', { analysisId: bar.analysisId, loadCase: 'LC9' }, ctx);
    expect(codeOf(badCase)).toBe('FEA_RESULTS_MISSING');
    expect(badCase.summary).toContain('load cases: LC1');
    expect(codeOf(execute(solved, 'render_fea_results', { analysisId: bar.analysisId, field: 'temperature' }, ctx))).toBe(
      'FEA_FIELD_MISSING',
    );
  });

  it('plots the temperature of a thermal case undeformed, picking the result set nearest a time', () => {
    const wall = solvedWall();
    const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: wall.port };
    const result = execute(wall.solved, 'render_fea_results', { analysisId: wall.analysisId, time: 5 }, ctx);
    const data = result.data as PlotData;
    expect(data.field).toBe('temperature');
    expect(data.unit).toBe('degC');
    expect(data.deformationScale).toBe(0);
    expect(data.resultSet.time).toBe(0);
    expect(data.resultSet.label).toBe('steady state');
    expect(data.max.value).toBeGreaterThan(data.min.value);
    expect(data.svg).toContain('hot_film (film)');
  });
});

describe('render_fea_results cylindrical fields, cut and isolation', () => {
  const bar = solvedBar();
  const solved = recorded(bar);
  const render = (params: Record<string, unknown>): ReturnType<typeof execute> =>
    execute(solved, 'render_fea_results', { analysisId: bar.analysisId, ...params }, ctxOf(bar));

  it('plots axial / hoop / radial components about a given axis (uniaxial bar: axial = 210, hoop = radial = 0)', () => {
    const axis = { axisPoint: [1, 0.5, 0.5], axisDirection: [2, 0, 0] };
    const axial = render({ field: 's_axial', ...axis });
    expect(axial.rejected).toBeUndefined();
    const data = axial.data as PlotData & { axis: { point: number[]; direction: number[] } };
    expect(data.field).toBe('s_axial');
    expect(data.unit).toBe('MPa');
    expect(data.max.value).toBeCloseTo(210, 3);
    expect(data.axis).toEqual({ point: [1, 0.5, 0.5], direction: [1, 0, 0] });
    expect(axial.summary).toContain('axis [1, 0, 0] through [1, 0.5, 0.5]');
    for (const field of ['s_hoop', 's_radial']) {
      const read = render({ field, ...axis }).data as PlotData;
      expect(Math.abs(read.max.value)).toBeLessThan(1);
      expect(Math.abs(read.min.value)).toBeLessThan(1);
    }
    const radial = render({ field: 'u_radial', ...axis }).data as PlotData;
    expect(radial.unit).toBe('mm');
    expect(radial.max.value).toBeLessThan(1e-3);
  });

  it('defaults to the z axis through the bounding box centre and refuses a zero axis direction', () => {
    const byDefault = render({ field: 's_axial' }).data as PlotData & { axis: { point: number[]; direction: number[] } };
    expect(byDefault.axis.direction).toEqual([0, 0, 1]);
    expect(byDefault.axis.point).toEqual([1, 0.5, 0.5]);
    expect((render({ field: 'von_mises' }).data as { axis: unknown }).axis).toBeNull();
    const zero = render({ field: 's_hoop', axisDirection: [0, 0, 0] });
    expect(codeOf(zero)).toBe('FEA_PLOT_INVALID');
    expect(zero.document).toBe(solved);
  });

  it('cuts the model: removes the far half, paints the section and restricts min / max to the kept nodes', () => {
    const whole = render({ field: 'u_x', deformationScale: 0 });
    const cut = render({ field: 'u_x', deformationScale: 0, cut: { normal: [3, 0, 0], offset: 1 } });
    expect(cut.rejected).toBeUndefined();
    const [all, half] = [whole.data as PlotData, cut.data as PlotData & { cut: { normal: number[]; offset: number } }];
    expect(half.cut).toEqual({ normal: [1, 0, 0], offset: 1 });
    expect(half.max.value).toBeLessThan(all.max.value);
    expect(half.max.at[0]).toBeLessThanOrEqual(1 + 1e-9);
    expect(half.svg).toContain('<image');
    expect(cut.summary).toContain('cut 1, 0, 0');
    expect(codeOf(render({ cut: { normal: [1, 0, 0], offset: -5 } }))).toBe('FEA_FIELD_MISSING');
    const zero = render({ cut: { normal: [0, 0, 0], offset: 0 } });
    expect(codeOf(zero)).toBe('FEA_PLOT_INVALID');
    expect(zero.document).toBe(solved);
  });

  it('isolates parts by entity id and refuses an unknown part', () => {
    const only = render({ entityIds: [bar.boxId] });
    expect(only.rejected).toBeUndefined();
    expect((only.data as { entityIds: string[] }).entityIds).toEqual([bar.boxId]);
    expect(only.summary).toContain(`parts ${bar.boxId}`);
    const missing = render({ entityIds: ['box-404'] });
    expect(codeOf(missing)).toBe('FEA_PART_INVALID');
    expect(missing.summary).toContain(`meshed parts: ${bar.boxId}`);
  });
});

describe('meshSkin', () => {
  const tetMesh = (type: 'C3D4' | 'C3D10', elements: number[][], nodes: FeMeshArtifact['nodes']): FeMeshArtifact => ({
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: 'x',
    nodes,
    blocks: [{ type, entityId: 'box-1.1', elements }],
    nodeSets: {},
    faceSets: {},
    targets: {},
  });
  const corners: FeMeshArtifact['nodes'] = [
    [1, 0, 0, 0],
    [2, 1, 0, 0],
    [3, 0, 1, 0],
    [4, 0, 0, 1],
    [5, 1, 1, 1],
  ];
  const coordinates = (mesh: FeMeshArtifact): Map<number, Vec3> =>
    new Map(mesh.nodes.map((n): [number, Vec3] => [n[0], [n[1], n[2], n[3]]]));
  const outwardOk = (mesh: FeMeshArtifact, centre: Vec3): boolean =>
    meshSkin(mesh, coordinates(mesh)).every((triangle) => {
      const [a, b, c] = triangle.map((node) => coordinates(mesh).get(node) ?? [0, 0, 0]);
      if (a === undefined || b === undefined || c === undefined) return false;
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      return n[0]! * (a[0] - centre[0]) + n[1]! * (a[1] - centre[1]) + n[2]! * (a[2] - centre[2]) > 0;
    });

  it('keeps the 4 faces of one tet, outward, and drops the face two tets share', () => {
    const one = tetMesh('C3D4', [[1, 1, 2, 3, 4]], corners);
    expect(meshSkin(one, coordinates(one))).toHaveLength(4);
    expect(outwardOk(one, [0.25, 0.25, 0.25])).toBe(true);
    const two = tetMesh(
      'C3D4',
      [
        [1, 1, 2, 3, 4],
        [2, 2, 3, 4, 5],
      ],
      corners,
    );
    expect(meshSkin(two, coordinates(two))).toHaveLength(6);
  });

  it('splits a quadratic face into 4 sub-triangles and ignores element types without a solid skin', () => {
    const nodes: FeMeshArtifact['nodes'] = [
      ...corners.slice(0, 4),
      [5, 0.5, 0, 0],
      [6, 0.5, 0.5, 0],
      [7, 0, 0.5, 0],
      [8, 0, 0, 0.5],
      [9, 0.5, 0, 0.5],
      [10, 0, 0.5, 0.5],
    ];
    const quadratic = tetMesh('C3D10', [[1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]], nodes);
    expect(meshSkin(quadratic, coordinates(quadratic))).toHaveLength(16);
    expect(outwardOk(quadratic, [0.25, 0.25, 0.25])).toBe(true);
    const shell: FeMeshArtifact = { ...quadratic, blocks: [{ type: 'S3', entityId: 'box-1.1', elements: [[1, 1, 2, 3]] }] };
    expect(meshSkin(shell, coordinates(shell))).toEqual([]);
  });
});

describe('iso bands', () => {
  const area = (polygon: readonly Vec3[]): number => {
    let sum = 0;
    polygon.forEach((p, index) => {
      const q = polygon[(index + 1) % polygon.length] ?? p;
      sum += p[0] * q[1] - q[0] * p[1];
    });
    return Math.abs(sum) / 2;
  };

  it('tiles a triangle exactly with its band pieces, clamping values outside the levels', () => {
    const triangle: [Vec3, Vec3, Vec3] = [
      [0, 0, 0],
      [4, 0, 0],
      [0, 4, 0],
    ];
    const pieces = triangleBands(triangle, [0, 4, 10], [0, 1, 2, 3, 4]);
    expect(pieces.map((piece) => piece.band)).toEqual([0, 1, 2, 3]);
    expect(pieces.reduce((sum, piece) => sum + area(piece.polygon), 0)).toBeCloseTo(8, 9);
    expect(triangleBands(triangle, [1.2, 1.5, 1.9], [0, 1, 2, 3])).toEqual([{ band: 1, polygon: triangle }]);
    expect(triangleBands(triangle, [0, 0, 0], [0])).toEqual([]);
  });

  it('spaces levels evenly, widens a zero range and maps the scale from blue to red', () => {
    expect(bandLevels(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    const flat = bandLevels(3, 3, 2);
    expect(flat[0]).toBeLessThan(3);
    expect(flat[2]).toBeGreaterThan(3);
    expect(resultColor(0)).toBe('#0000ff');
    expect(resultColor(1)).toBe('#ff0000');
    expect(resultColor(0.5)).toBe('#00ff00');
    expect(resultColor(-2)).toBe('#0000ff');
  });
});

describe('render_fea_results surface', () => {
  const bar = solvedBar();
  const solved = recorded(bar);
  type Surface = { positions: number[]; values: number[]; triangles: number; truncated: boolean };
  const surfaceOf = (params: Record<string, unknown>): Surface | undefined =>
    (execute(solved, 'render_fea_results', { analysisId: bar.analysisId, ...params }, ctxOf(bar)).data as { surface?: Surface }).surface;

  it('returns the plotted triangles per corner with values, only when asked', () => {
    expect(surfaceOf({})).toBeUndefined();
    const surface = surfaceOf({ surface: true, deformationScale: 0 });
    expect(surface?.triangles).toBeGreaterThan(0);
    expect(surface?.positions).toHaveLength((surface?.triangles ?? 0) * 9);
    expect(surface?.values).toHaveLength((surface?.triangles ?? 0) * 3);
    expect(surface?.truncated).toBe(false);
    expect(Math.max(...(surface?.values ?? []))).toBeCloseTo(210, 3);
  });

  it('is pure', () => {
    const before = JSON.stringify(solved);
    const result = execute(solved, 'render_fea_results', { analysisId: bar.analysisId, surface: true }, ctxOf(bar));
    expect(result.document).toBe(solved);
    expect(JSON.stringify(solved)).toBe(before);
  });

  it('converts analysis length to document units and truncates past the corner budget', () => {
    const vertex = (x: number, v: number): { u: Vec3; p: Vec3; v: number } => ({ u: [x, 0, 0], p: [x, 0, 0], v });
    const face = { corners: [vertex(0, 1), vertex(1000, 2), vertex(2000, 3)] as const, entityId: 'a', cap: false };
    const full = surfacePayload([face, face], 'mm', 0.001, 100);
    expect(full.positions.slice(0, 6)).toEqual([0, 0, 0, 1000, 0, 0]);
    expect(full.truncated).toBe(false);
    const metres = surfacePayload([face], 'm', 0.001, 100);
    expect(metres.positions[3]).toBe(1_000_000);
    const cut = surfacePayload([face, face, face], 'mm', 0.001, 6);
    expect(cut.triangles).toBe(2);
    expect(cut.values).toHaveLength(6);
    expect(cut.truncated).toBe(true);
  });
});
