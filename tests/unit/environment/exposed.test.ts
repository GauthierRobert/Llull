import { afterEach, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import type { FaceDetail, FaceQueryPort } from '@core/geometry/kernelPorts';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { fakeKernel } from '../../helpers/fakeKernel';
import { close } from './fixtures';

afterEach(() => setGeometryKernel(null));

/** Analytic faces of a 100 x 50 x 20 mm box: 5000 (z), 2000 (y) and 1000 (x) mm^2 each side. */
const DETAILS: FaceDetail[] = [
  { index: 0, surface: 'plane', area: 5000, centroid: [50, 25, 20], normal: [0, 0, 1], samples: [] },
  { index: 1, surface: 'plane', area: 2000, centroid: [50, 50, 10], normal: [0, 1, 0], samples: [] },
  { index: 2, surface: 'plane', area: 1000, centroid: [100, 25, 10], normal: [1, 0, 0], samples: [] },
];

function kernelWithFaces(details: FaceDetail[] | null = DETAILS): GeometryKernel {
  const nothing = (): null => null;
  const port: FaceQueryPort = {
    faceDetails: () => details,
    faceContains: nothing,
    faceGraph: nothing,
    faceGeometry: nothing,
    projectOnFace: nothing,
    evaluateFace: nothing,
    tessellateFace: nothing,
    faceSamples: nothing,
    edgeSamples: nothing,
    edgeContinuity: nothing,
    distance: nothing,
    bspline: nothing,
    projectCurves: nothing,
  };
  return Object.assign(fakeKernel(), { faceQuery: port });
}

function scene(): { doc: CadDocument; box: string } {
  const added = execute(createEmptyDocument(), 'add_box', { size: [100, 50, 20] });
  return { doc: added.document, box: added.affected[0] ?? '' };
}

const kapton = { reference: 'kapton_h', fluence: { value: 1e21, unit: 'atoms/cm^2', source: 'synthetic' } };
const density = { value: 1.42, unit: 'g/cm^3', source: 'synthetic' };

const erosion = (doc: CadDocument, params: Record<string, unknown>, kernel: GeometryKernel | null): ReturnType<typeof execute> =>
  execute(doc, 'ao_erosion', { ...kapton, ...params }, { ...defaultContext(), kernel });

describe('ao_erosion exposedFaces (M3): areas summed from inspect_faces', () => {
  it('sums the named faces (5000 + 2000 mm^2 = 70 cm^2) into the mass loss; a face named twice counts once', () => {
    const { doc, box } = scene();
    const result = erosion(doc, { density, exposedFaces: [{ entityId: box, faces: [0, 1, 1] }] }, kernelWithFaces());
    const data = result.data as { massLossG: number; inputs: { area: { value: number; unit: string; source: string } } };
    expect(result.error).toBeUndefined();
    expect(close(data.inputs.area.value, 70)).toBe(true);
    expect(data.inputs.area.source).toContain('inspect_faces');
    expect(close(data.massLossG, 1.42 * 70 * 3e-24 * 1e21)).toBe(true);
    expect(result.document).toBe(doc);
  });

  it('merges entries of the same entity: the same face in two entries counts once, different faces add up', () => {
    const { doc, box } = scene();
    const area = (faces: { entityId: string; faces: number[] }[]): number =>
      (erosion(doc, { density, exposedFaces: faces }, kernelWithFaces()).data as { inputs: { area: { value: number } } }).inputs.area.value;
    expect(
      close(
        area([
          { entityId: box, faces: [0] },
          { entityId: box, faces: [0] },
        ]),
        50,
      ),
    ).toBe(true);
    expect(
      close(
        area([
          { entityId: box, faces: [0] },
          { entityId: box, faces: [1, 0] },
        ]),
        70,
      ),
    ).toBe(true);
  });

  it('a caller `area` overrides the faces', () => {
    const { doc, box } = scene();
    const data = erosion(
      doc,
      { density, area: { value: 10, unit: 'cm^2' }, exposedFaces: [{ entityId: box, faces: [0] }] },
      kernelWithFaces(),
    ).data as { inputs: { area: { value: number } } };
    expect(data.inputs.area.value).toBe(10);
  });

  it('is refused without an exact kernel, forwarding the kernel refusal, document unchanged', () => {
    const { doc, box } = scene();
    const result = erosion(doc, { density, exposedFaces: [{ entityId: box, faces: [0] }] }, null);
    expect(result.error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
    expect(result.document).toBe(doc);
  });

  it.each([
    ['an empty face list', (box: string) => [{ entityId: box, faces: [] }], 'ENV_PARAM_INVALID'],
    ['an unknown entity', () => [{ entityId: 'box-99', faces: [0] }], 'ENTITY_NOT_FOUND'],
    ['a face index out of range', (box: string) => [{ entityId: box, faces: [7] }], 'KRN_FACE_INDEX'],
  ])('refuses %s', (_name, faces, code) => {
    const { doc, box } = scene();
    const result = erosion(doc, { density, exposedFaces: faces(box) }, kernelWithFaces());
    expect(result.error?.code).toBe(code);
    expect(result.error?.paths).toContain('exposedFaces');
    expect(result.document).toBe(doc);
  });

  it('refuses faces without an area and a zero total area', () => {
    const { doc, box } = scene();
    const noArea: FaceDetail[] = [{ index: 0, surface: 'plane', area: Number.NaN, centroid: [0, 0, 0], samples: [] }];
    expect(erosion(doc, { density, exposedFaces: [{ entityId: box, faces: [0] }] }, kernelWithFaces(noArea)).error?.code).toBe(
      'ENV_PARAM_INVALID',
    );
    const zero: FaceDetail[] = [{ index: 0, surface: 'plane', area: 0, centroid: [0, 0, 0], samples: [] }];
    const result = erosion(doc, { density, exposedFaces: [{ entityId: box, faces: [0] }] }, kernelWithFaces(zero));
    expect(result.error?.code).toBe('ENV_PARAM_INVALID');
    expect(result.summary).toContain('no area');
  });
});
