/**
 * Fake exact kernel for the aerospace-01 command tests: the real recipe evaluator (`kernelFromOps`) over canned native ops, with the optional
 * `info` / `importShapes` / `loadBlob` / `brep` ports a test can script (no WASM).
 */
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ImportedSolid, ImportShapesResult, KernelInfo } from '@core/geometry/kernelPorts';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import type { MeshData } from '@core/model/types';
import { TETRA } from './fakeKernel';

interface FakeShape {
  readonly mesh: MeshData;
}

interface FakeExactSpec {
  readonly name?: string;
  readonly info?: KernelInfo | null;
  /** Result of `importShapes` (null = the kernel cannot answer). */
  readonly imported?: ImportShapesResult | null;
  /** Omit the exact ports entirely (a Manifold-like kernel). */
  readonly exact?: boolean;
}

export interface FakeExactKernel {
  readonly kernel: GeometryKernel;
  /** sha256 of every `loadBlob` call, in order. */
  readonly loaded: string[];
  readonly imports: Array<{ readonly text: string; readonly options: unknown; readonly format: string }>;
}

export const importedSolid = (extra: Partial<ImportedSolid> = {}): ImportedSolid => ({
  brep: 'CASCADE Topology V1 fake solid',
  validAsRead: true,
  validAfterHeal: true,
  actions: [],
  maxToleranceMm: 1e-7,
  freeEdges: 0,
  faces: 6,
  faceted: false,
  ...extra,
});

export const CENSUS = { roots: 1, solids: 1, shells: 1, openShells: 0, faces: 6 } as const;

export function fakeExactKernel(spec: FakeExactSpec = {}): FakeExactKernel {
  const loaded: string[] = [];
  const imports: Array<{ text: string; options: unknown; format: string }> = [];
  const texts = new Map<string, string>();
  const exact = spec.exact !== false;
  const info = spec.info === undefined ? { capabilities: ['importShapes', 'brepBlobs'] } : spec.info;
  const kernel = kernelFromOps<FakeShape>({
    name: spec.name ?? 'occt',
    ...(info === null ? {} : { info: () => info }),
    solid: () => ({ mesh: TETRA }),
    boolean: () => null,
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape) => shape,
    scale: (shape) => shape,
    tessellate: (shape) => shape.mesh,
    topology: () => null,
    exportStep: () => null,
    release: () => undefined,
    ...(exact
      ? {
          brep: (sha256: string) => (texts.has(sha256) ? { mesh: TETRA } : null),
          loadBlob: (sha256: string, brep: string) => {
            loaded.push(sha256);
            texts.set(sha256, brep);
          },
          importShapes: (format: 'step' | 'iges', text: string, options: unknown) => {
            imports.push({ text, options, format });
            return spec.imported === undefined ? null : spec.imported;
          },
        }
      : {}),
  });
  return { kernel, loaded, imports };
}
