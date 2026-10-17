import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { directionFrame } from '@core/geometry/viewDirections';
import { fieldFaces, type FieldFace, type FieldVertex } from '@cae/results/fieldFaces';
import { fieldPlotSvg } from '@cae/results/fieldPlotSvg';
import { rasterField, type RasterInput } from '@cae/results/fieldRaster';

/** RGBA pixels of a PNG written by encodePng (filters None / Up). */
function decodePng(png: Buffer): { pixel: (x: number, y: number) => number[] } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      pixels[y * stride + x] = raw[y * (stride + 1)] === 2 && y > 0 ? (value + (pixels[(y - 1) * stride + x] ?? 0)) & 0xff : value;
    }
  return { pixel: (x, y) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] };
}

const imageOf = (image: string): ReturnType<typeof decodePng> => {
  const match = /href="data:image\/png;base64,([^"]+)"/.exec(image);
  expect(match).not.toBeNull();
  return decodePng(Buffer.from(match?.[1] ?? '', 'base64'));
};

const vertex = (u: Vec3, v: number): FieldVertex => ({ u, p: u, v });
/** An axis-aligned square in the plane y = `y` (normal -Y, toward a viewer on -Y) with a constant value. */
const square = (y: number, half: number, value: number, entityId = 'a'): FieldFace[] => {
  const [a, b, c, d] = [
    vertex([-half, y, -half], value),
    vertex([half, y, -half], value),
    vertex([half, y, half], value),
    vertex([-half, y, half], value),
  ];
  return [
    { corners: [a, b, c], entityId, cap: false },
    { corners: [a, c, d], entityId, cap: false },
  ];
};

/** Front view from -Y: screen x = X, screen y = Z, 1 unit = 10 px, origin at (100, 100). */
const frontInput = (faces: readonly FieldFace[], extra: Partial<RasterInput> = {}): RasterInput => ({
  faces,
  ghost: false,
  toViewer: [0, -1, 0],
  screen: (p) => [100 + p[0] * 10, 100 - p[2] * 10],
  pixelsPerUnit: 10,
  width: 200,
  height: 200,
  area: { left: 0, top: 0, right: 200, bottom: 200 },
  levels: [0, 5, 10],
  showMesh: false,
  size: 20,
  ...extra,
});

describe('rasterField', () => {
  const near = square(-5, 4, 9);
  const far = square(5, 9, 1);

  it('shows the nearest face per pixel whatever the order the faces are given in', () => {
    for (const faces of [
      [...far, ...near],
      [...near, ...far],
    ]) {
      const raster = rasterField(frontInput(faces));
      const image = imageOf(raster.image);
      const [nr, , nb] = image.pixel(100, 100);
      expect(nr).toBeGreaterThan(150);
      expect(nb).toBeLessThan(60);
      const [fr, , fb] = image.pixel(100 + 70, 100);
      expect(fb).toBeGreaterThan(150);
      expect(fr).toBeLessThan(60);
      expect(image.pixel(5, 5)[3]).toBe(0);
      expect(raster.facesDrawn).toBe(4);
    }
  });

  it('colours the interpolated value per pixel in crisp bands', () => {
    const [a, b, c] = [vertex([-8, 0, -8], 0), vertex([8, 0, -8], 10), vertex([-8, 0, 8], 0)];
    const faces: FieldFace[] = [{ corners: [a, b, c], entityId: 'a', cap: false }];
    const image = imageOf(rasterField(frontInput(faces, { levels: [0, 2.5, 5, 7.5, 10] })).image);
    const colours = new Set<string>();
    for (let x = 25; x < 165; x += 1) colours.add(image.pixel(x, 168).slice(0, 3).join(','));
    expect(colours.size).toBeGreaterThanOrEqual(4);
    expect(colours.size).toBeLessThan(10);
    const left = image.pixel(30, 168);
    const right = image.pixel(160, 168);
    expect(left[2] ?? 0).toBeGreaterThan(left[0] ?? 0);
    expect(right[0] ?? 0).toBeGreaterThan(right[2] ?? 0);
  });

  it('answers visibility from the depth buffer: behind a nearer face is hidden, on it or in front is visible', () => {
    const { visible } = rasterField(frontInput([...far, ...near]));
    expect(visible([0, 5, 0])).toBe(false);
    expect(visible([0, -5, 0])).toBe(true);
    expect(visible([0, -9, 0])).toBe(true);
    expect(visible([7, 5, 0])).toBe(true);
    expect(visible([30, 5, 0])).toBe(false);
  });

  it('draws element edges only with showMesh and a faint ghost only where nothing else is', () => {
    const plain = rasterField(frontInput([...near], { ghost: false }));
    const meshed = rasterField(frontInput([...near], { showMesh: true }));
    expect(meshed.image).not.toBe(plain.image);
    const ghosted = rasterField(frontInput([...near], { ghost: true }));
    expect(imageOf(ghosted.image).pixel(100, 100)).toEqual(imageOf(plain.image).pixel(100, 100));
    expect(rasterField(frontInput([], { ghost: false })).image).toBe('');
  });
});

describe('fieldPlotSvg markers', () => {
  const plot = (markerPoints: Vec3[]): string =>
    fieldPlotSvg({
      title: 't',
      subtitle: 's',
      frame: directionFrame('front'),
      width: 600,
      height: 400,
      faces: [...square(-5, 9, 1), ...square(5, 9, 0)].map((face) => face),
      levels: [0, 1],
      unit: 'MPa',
      ghost: false,
      showMesh: false,
      zoom: 1,
      focus: null,
      markers: [{ label: 'load (force)', color: '#ff4fd8', points: markerPoints, arrow: [0, 1, 0] }],
      min: { value: 0, at: [0, 5, 0] },
      max: { value: 1, at: [0, -5, 0] },
    }).svg;

  it('draws a marker dot and its arrow only when visible, and always the MAX / MIN labels', () => {
    const front = plot([[1, -5, 1]]);
    expect(front).toContain('<circle');
    expect(front).toContain('stroke-width="3"');
    const behind = fieldPlotSvg({
      title: 't',
      subtitle: 's',
      frame: directionFrame('front'),
      width: 600,
      height: 400,
      faces: [...square(5, 9, 0), ...square(-5, 9, 1)],
      levels: [0, 1],
      unit: 'MPa',
      ghost: false,
      showMesh: false,
      zoom: 1,
      focus: null,
      markers: [{ label: 'load (force)', color: '#ff4fd8', points: [[1, 5, 1]], arrow: [0, 1, 0] }],
      min: { value: 0, at: [0, 5, 0] },
      max: { value: 1, at: [0, -5, 0] },
    }).svg;
    expect(behind).not.toContain('r="2.4"');
    expect(behind).not.toContain('stroke-width="3"/>');
    expect(behind).toContain('MAX 1');
    expect(behind).toContain('MIN 0');
  });
});

describe('fieldFaces', () => {
  const tetNodes: FeMeshArtifact['nodes'] = [
    [1, 0, 0, 0],
    [2, 1, 0, 0],
    [3, 0, 1, 0],
    [4, 0, 0, 1],
    [5, 1, 1, 1],
  ];
  const meshOf = (blocks: FeMeshArtifact['blocks']): FeMeshArtifact => ({
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: 'x',
    nodes: tetNodes,
    blocks,
    nodeSets: {},
    faceSets: {},
    targets: {},
  });
  const coordinates = new Map<number, Vec3>(tetNodes.map((n): [number, Vec3] => [n[0], [n[1], n[2], n[3]]]));
  const faces = (mesh: FeMeshArtifact, extra: Partial<Parameters<typeof fieldFaces>[0]> = {}): FieldFace[] =>
    fieldFaces({
      mesh,
      coordinates,
      entityIds: null,
      cut: null,
      position: (node) => coordinates.get(node),
      value: (node) => (node === 2 ? 10 : 0),
      ...extra,
    });
  const area = (face: FieldFace): number => {
    const [a, b, c] = face.corners.map((corner) => corner.u);
    if (a === undefined || b === undefined || c === undefined) return 0;
    const [u, v] = [
      [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
    ];
    return Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
  };
  const one = meshOf([{ type: 'C3D4', entityId: 'p', elements: [[1, 1, 2, 3, 4]] }]);

  it('without a cut gives the 4 skin faces, with a cut the clipped skin plus the interpolated section', () => {
    expect(faces(one)).toHaveLength(4);
    const cut = faces(one, { cut: { normal: [1, 0, 0], offset: 0.5 } });
    const caps = cut.filter((face) => face.cap);
    expect(caps.reduce((sum, face) => sum + area(face), 0)).toBeCloseTo(0.125, 12);
    for (const corner of caps.flatMap((face) => face.corners)) {
      expect(corner.u[0]).toBeCloseTo(0.5, 12);
      expect(corner.v).toBeCloseTo(5, 12);
    }
    for (const face of cut.filter((f) => !f.cap)) for (const corner of face.corners) expect(corner.u[0]).toBeLessThanOrEqual(0.5 + 1e-12);
    for (const face of caps) {
      const [a, b, c] = face.corners.map((corner) => corner.u);
      const nx = (b![1] - a![1]) * (c![2] - a![2]) - (b![2] - a![2]) * (c![1] - a![1]);
      expect(nx).toBeGreaterThan(0);
    }
  });

  it('cuts a tet into a quadrilateral section when two corners are removed, and drops a tet the plane misses', () => {
    const quad = faces(one, { cut: { normal: [Math.SQRT1_2, Math.SQRT1_2, 0], offset: 0.5 * Math.SQRT1_2 } }).filter((face) => face.cap);
    expect(quad).toHaveLength(2);
    expect(quad.reduce((sum, face) => sum + area(face), 0)).toBeCloseTo(0.5 * Math.SQRT1_2, 12);
    expect(faces(one, { cut: { normal: [1, 0, 0], offset: 5 } }).filter((face) => face.cap)).toEqual([]);
    expect(faces(one, { cut: { normal: [1, 0, 0], offset: -1 } })).toEqual([]);
  });

  it('splits a quadratic tet into 8 sub-tets so the section follows the midside nodes', () => {
    const nodes: FeMeshArtifact['nodes'] = [
      ...tetNodes.slice(0, 4),
      [5, 0.5, 0, 0],
      [6, 0.5, 0.5, 0],
      [7, 0, 0.5, 0],
      [8, 0, 0, 0.5],
      [9, 0.5, 0, 0.5],
      [10, 0, 0.5, 0.5],
    ];
    const quadratic: FeMeshArtifact = {
      ...one,
      nodes,
      blocks: [{ type: 'C3D10', entityId: 'p', elements: [[1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] }],
    };
    const all = new Map<number, Vec3>(nodes.map((n): [number, Vec3] => [n[0], [n[1], n[2], n[3]]]));
    const sections = fieldFaces({
      mesh: quadratic,
      coordinates: all,
      entityIds: null,
      cut: { normal: [1, 0, 0], offset: 0.25 },
      position: (node) => all.get(node),
      value: (node) => all.get(node)?.[0] ?? 0,
    }).filter((face) => face.cap);
    expect(sections.reduce((sum, face) => sum + area(face), 0)).toBeCloseTo(0.28125, 12);
    for (const corner of sections.flatMap((face) => face.corners)) expect(corner.v).toBeCloseTo(corner.u[0], 12);
  });

  it('plots only the selected parts: a face shared with a hidden part becomes skin', () => {
    const two = meshOf([
      { type: 'C3D4', entityId: 'p', elements: [[1, 1, 2, 3, 4]] },
      { type: 'C3D4', entityId: 'q', elements: [[2, 2, 3, 4, 5]] },
    ]);
    expect(faces(two)).toHaveLength(6);
    const only = faces(two, { entityIds: new Set(['q']) });
    expect(only).toHaveLength(4);
    expect(new Set(only.map((face) => face.entityId))).toEqual(new Set(['q']));
  });
});
