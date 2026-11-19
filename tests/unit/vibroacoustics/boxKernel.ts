/** The 300 x 200 x 100 box on a stub exact kernel (exact face areas 20000 / 30000 / 60000 mm^2) and the exposure fixtures of the VAC export tests. */
import { defaultContext } from '@core/commands/context';
import type { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { FaceDetail, FaceQueryPort } from '@core/geometry/kernelPorts';
import { createEmptyDocument, type CadDocument, type Vec3 } from '@core/model/types';
import { fakeKernel } from '../../helpers/fakeKernel';
import { flatParams, run } from './fixtures';

/** Box 300 x 200 x 100 (min corner at the origin): faces 0 x=0, 1 x=300, 2 y=0, 3 y=200, 4 z=0, 5 z=100; areas 20000, 20000, 30000, 30000, 60000, 60000. */
const SIZE: Vec3 = [300, 200, 100];
export const FACES: FaceDetail[] = [
  { index: 0, surface: 'plane', area: 200 * 100, centroid: [0, 100, 50], normal: [-1, 0, 0], samples: [] },
  { index: 1, surface: 'plane', area: 200 * 100, centroid: [300, 100, 50], normal: [1, 0, 0], samples: [] },
  { index: 2, surface: 'plane', area: 300 * 100, centroid: [150, 0, 50], normal: [0, -1, 0], samples: [] },
  { index: 3, surface: 'plane', area: 300 * 100, centroid: [150, 200, 50], normal: [0, 1, 0], samples: [] },
  { index: 4, surface: 'plane', area: 300 * 200, centroid: [150, 100, 0], normal: [0, 0, -1], samples: [] },
  { index: 5, surface: 'plane', area: 300 * 200, centroid: [150, 100, 100], normal: [0, 0, 1], samples: [] },
];

/** Distance from `p` to the rectangle of face `index` (its plane clamped to the other two extents). */
function faceDistance(index: number, p: Vec3): number {
  const axis = Math.floor(index / 2);
  const plane = index % 2 === 0 ? 0 : (SIZE[axis] ?? 0);
  const gap = [0, 1, 2].map((k) => (k === axis ? (p[k] ?? 0) - plane : Math.max(0 - (p[k] ?? 0), 0, (p[k] ?? 0) - (SIZE[k] ?? 0))));
  return Math.hypot(...gap);
}

export function boxKernel(overrides: Partial<FaceQueryPort> = {}): GeometryKernel {
  const nothing = (): null => null;
  const faceQuery: FaceQueryPort = {
    faceDetails: () => FACES,
    faceContains: nothing,
    faceGraph: nothing,
    faceGeometry: nothing,
    projectOnFace: nothing,
    evaluateFace: nothing,
    tessellateFace: nothing,
    faceSamples: nothing,
    edgeSamples: nothing,
    edgeContinuity: nothing,
    distance: (_shape, points) =>
      points.map((point) => {
        const ranked = [0, 1, 2, 3, 4, 5]
          .map((face) => ({ face, distance: faceDistance(face, point) }))
          .sort((a, b) => a.distance - b.distance);
        const [best, next] = ranked;
        const tie = (next?.distance ?? Infinity) - (best?.distance ?? 0) < 1e-9;
        return { distance: best?.distance ?? 0, signed: 0, face: tie ? -1 : (best?.face ?? -1) };
      }),
    bspline: nothing,
    projectCurves: nothing,
    ...overrides,
  };
  return Object.assign(fakeKernel(), { faceQuery });
}

export const withKernel = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });
export const refusal = (result: ReturnType<typeof execute>): string | undefined =>
  result.rejected === true ? result.error?.code : undefined;

export function boxDocument(units: 'mm' | 'cm' = 'mm'): { doc: CadDocument; box: string } {
  const unitsSet = run(createEmptyDocument(), 'set_units', { units });
  const scale = units === 'cm' ? 0.1 : 1;
  const added = run(unitsSet.document, 'add_box', { size: SIZE.map((v) => v * scale), position: [0, 0, 0], anchor: 'min' });
  return { doc: added.document, box: added.affected[0] ?? '' };
}

export const exposureParams = (box: string, facesNear: Vec3[] = [[150, 100, 100]], extra: object = {}): object => ({
  name: 'enclosure_skin',
  spectrum: 'flat130',
  target: { entityId: box, facesNear },
  field: 'diffuse',
  ...extra,
});

export function exposedDocument(grade: 'A' | 'B' = 'A', extra: object = {}, facesNear?: Vec3[]): { doc: CadDocument; box: string } {
  const { doc, box } = boxDocument();
  const withSpectrum = run(doc, 'define_acoustic_spectrum', flatParams('flat130', 130, grade)).document;
  return { doc: run(withSpectrum, 'define_acoustic_exposure', exposureParams(box, facesNear, extra)).document, box };
}
