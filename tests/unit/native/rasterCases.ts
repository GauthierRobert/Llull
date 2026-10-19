/** Field plots for the native raster comparison (VC-FEA-29): a two-part tet block with a seeded field, deformed, cut, at several sizes. */
import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { bandLevels } from '@lib/isoBands';
import { fieldFaces, type CutPlane } from '@cae/results/fieldFaces';
import { fieldPlotLayout } from '@cae/results/fieldPlotSvg';
import type { RasterInput } from '@cae/results/fieldRaster';
import { frameOf } from '@cae/results/plotSetup';
import { gridMesh } from '../cae/gridMesh';

export interface RasterCase {
  readonly name: string;
  readonly raster: RasterInput;
}

function plot(
  name: string,
  options: { cells: [number, number, number]; view: 'iso' | 'front' | 'top'; cut?: CutPlane; showMesh?: boolean; size?: [number, number] },
): RasterCase {
  const grid = gridMesh({ cells: options.cells, size: [4, 2, 1.5] });
  const half = Math.floor(grid.elements.length / 2);
  const mesh: FeMeshArtifact = {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: '',
    nodes: grid.nodes,
    blocks: [
      { type: 'C3D4', entityId: 'a', elements: grid.elements.slice(0, half).map((nodes, i) => [i + 1, ...nodes]) },
      { type: 'C3D4', entityId: 'b', elements: grid.elements.slice(half).map((nodes, i) => [half + i + 1, ...nodes]) },
    ],
    nodeSets: {},
    faceSets: {},
    targets: {},
  };
  const coordinates = new Map(grid.nodes.map(([id, x, y, z]) => [id, [x, y, z] as Vec3]));
  const value = (node: number): number | undefined => {
    const at = coordinates.get(node);
    return at === undefined ? undefined : 100 * Math.sin(at[0] * 1.7) + 40 * at[1] * at[2];
  };
  const position = (node: number): Vec3 | undefined => {
    const at = coordinates.get(node);
    return at === undefined ? undefined : [at[0], at[1] + 0.05 * at[0] * at[0], at[2]];
  };
  const faces = fieldFaces({ mesh, coordinates, entityIds: null, cut: options.cut ?? null, position, value });
  const values = faces.flatMap((face) => face.corners.map((corner) => corner.v));
  const [low, high] = [Math.min(...values), Math.max(...values)];
  const [width, height] = options.size ?? [480, 320];
  const layout = fieldPlotLayout({
    title: name,
    subtitle: '',
    frame: frameOf(options.view, undefined),
    width,
    height,
    faces,
    levels: bandLevels(low, high, 12),
    unit: 'MPa',
    ghost: true,
    showMesh: options.showMesh ?? false,
    zoom: 1,
    focus: null,
    markers: [],
    min: null,
    max: null,
  });
  return { name, raster: layout.raster };
}

export function rasterCases(): RasterCase[] {
  return [
    plot('iso_ghost_two_parts', { cells: [6, 3, 2], view: 'iso' }),
    plot('front_cut_mesh_edges', { cells: [5, 3, 3], view: 'front', cut: { normal: [0, 1, 0], offset: 0.9 }, showMesh: true }),
    plot('top_large_single_sample', { cells: [8, 4, 3], view: 'top', size: [1100, 1100] }),
  ];
}
